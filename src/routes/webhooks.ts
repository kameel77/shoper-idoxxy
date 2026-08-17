import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";

import { env } from "../config/env";
import { settingsRepository } from "../repositories/settingsRepository";
import type { EventMapping } from "../types/settings";
import { IdoxxyService } from "../services/idoxxyService";
import { shopConnectionService } from "../services/shopConnectionService";
import { emailService } from "../services/emailService";
import type { IdoxxyClient } from "../clients/idoxxyClient";
import { verifyEventWebhookSignature, verifyDocumentedWebhookSignature } from "../middleware/shoperSignature";

type MappingResolution = {
  source: "mapping" | "fallback";
  groupIds: string[];
  mapping?: EventMapping;
};

type CustomerPayload = {
  email: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
};

const idoxxyService = new IdoxxyService();

const customerCreatedSchema = z
  .object({
    idoxxy_path: z.string().min(1).optional(),
    customer: z.object({
      id: z.union([z.string(), z.number()]).transform((value) => String(value)),
      email: z.string().email(),
      first_name: z.string().optional().nullable(),
      last_name: z.string().optional().nullable(),
    }),
  })
  .passthrough();

const orderCreatedSchema = z
  .object({
    idoxxy_path: z.string().min(1).optional(),
    order: z.object({
      id: z.union([z.string(), z.number()]).transform((value) => String(value)),
      email: z.string().email().optional(),
    }),
    customer: z
      .object({
        email: z.string().email().optional(),
        first_name: z.string().optional().nullable(),
        last_name: z.string().optional().nullable(),
      })
      .optional(),
  })
  .passthrough();

async function dispatchCustomerDocumentsEmail(
  shopId: string,
  customer: CustomerPayload,
  customerId: string,
  groupIds: string[],
  idoxxyClient: IdoxxyClient,
) {
  try {
    const allDocsResponse = await idoxxyClient.listDocuments();
    const allDocuments = Array.isArray(allDocsResponse)
      ? allDocsResponse
      : (allDocsResponse as { content?: unknown[] })?.content || [];

    const customerGroupSet = new Set(groupIds);
    const matchedDocs = allDocuments.filter((doc: any) =>
      doc.recipients?.some((recipient: any) => customerGroupSet.has(recipient.id))
    );

    const docsForEmail = matchedDocs.length > 0 ? matchedDocs : allDocuments;

    if (docsForEmail.length > 0) {
      for (const doc of docsForEmail) {
        try {
          await idoxxyService.assignDocumentToGroup(doc.id, groupIds, [customerId], idoxxyClient);
        } catch (assignErr) {
          // eslint-disable-next-line no-console
          console.warn(`[Webhooks] Could not assign document ${doc.id} to customer ${customerId}:`, assignErr);
        }
      }

      // Fetch customer documents to resolve uniqueLinks for durable medium
      const uniqueLinkMap = new Map<string, string>();
      try {
        const custDocsResponse = await idoxxyClient.getCustomerDocuments("");
        for (const company of custDocsResponse || []) {
          for (const d of company.documents || []) {
            const link = d.currentVersion?.uniqueLink || (d.versions && d.versions[0]?.uniqueLink);
            if (link) {
              uniqueLinkMap.set(d.id, link);
            }
          }
        }
      } catch (custDocErr) {
        // eslint-disable-next-line no-console
        console.warn("[Webhooks] Could not fetch customer documents with uniqueLinks:", custDocErr);
      }

      const formattedDocs = docsForEmail
        .map((doc: any) => ({
          name: doc.documentName || doc.name || "Regulamin sklepu",
          uniqueLink: uniqueLinkMap.get(doc.id) || doc.currentVersion?.uniqueLink || doc.uniqueLink,
          validTo: doc.currentVersion?.validTo,
        }))
        .filter((d: any) => Boolean(d.uniqueLink));

      if (formattedDocs.length > 0) {
        const connection = shopConnectionService.getConnection(shopId);
        const shopDisplayName = connection?.shopUrl?.replace(/^https?:\/\//, "") || "Sklep Shoper";

        const emailResult = await emailService.sendDocumentsEmail({
          to: customer.email,
          customerName: [customer.firstName, customer.lastName].filter(Boolean).join(" ") || undefined,
          shopName: shopDisplayName,
          documents: formattedDocs,
        });

        // eslint-disable-next-line no-console
        console.info(`[Webhooks] Sent durable medium documents email to ${customer.email}:`, emailResult);
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[Webhooks] No documents with uniqueLink found to send to ${customer.email}`);
      }
    }
  } catch (emailErr) {
    // eslint-disable-next-line no-console
    console.error("[Webhooks] Failed to send documents email:", emailErr);
  }
}

const resolvePayloadValue = (payload: unknown, field: string): unknown => {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  return field.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    return (current as Record<string, unknown>)[key];
  }, payload);
};

const matchesCondition = (
  value: unknown,
  condition: EventMapping["conditions"][number],
): boolean => {
  if (condition.operator === "includes") {
    if (Array.isArray(value)) {
      return value.map(String).includes(condition.value);
    }

    if (typeof value === "string") {
      return value.includes(condition.value);
    }

    return false;
  }

  if (condition.operator === "equals") {
    return String(value ?? "") === condition.value;
  }

  if (condition.operator === "not_equals") {
    return String(value ?? "") !== condition.value;
  }

  return false;
};

const mappingMatchesPayload = (mapping: EventMapping, payload: unknown) => {
  if (!mapping.conditions.length) {
    return true;
  }

  return mapping.conditions.every((condition: EventMapping["conditions"][number]) => {
    const value = resolvePayloadValue(payload, condition.field);
    return matchesCondition(value, condition);
  });
};

// Exported for direct unit testing (see tests/webhooks.test.ts) - the deleted
// cross-tenant fallbacks are specifically covered there.
export const resolveShopId = (req: Request): string | undefined => {
  // 1. Try explicit shop ID headers
  const headerId =
    req.header("X-Shoper-Shop-Id") ||
    req.header("X-Shop-Id") ||
    req.header("X-Shop") ||
    req.header("X-Shop-Url");
  const bodyId = (req.body as any)?.shop_id ?? (req.body as any)?.shopId;
  const explicit = (headerId ?? bodyId)?.toString();
  if (explicit) return explicit;

  // 2. Shoper sends x-shop-domain header (e.g. "devshop-144794.shoparena.pl")
  //    Match it against stored shopUrl or extract numeric shopId from domain
  const shopDomain = req.header("X-Shop-Domain");
  if (shopDomain) {
    const allConnections = shopConnectionService.listConnections();

    // 2a. Try matching stored shopUrl
    const matchedByUrl = allConnections.find((c) => {
      if (!c.shopUrl) return false;
      const connHost = c.shopUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      return connHost === shopDomain;
    });
    if (matchedByUrl) {
      console.log(`[Webhooks] Resolved shopId=${matchedByUrl.shopId} from x-shop-domain=${shopDomain} (URL match)`);
      return matchedByUrl.shopId;
    }

    // 2b. Extract numeric ID from domain (e.g. "devshop-144794.shoparena.pl" → "144794")
    //     and check if any connection has that shopId
    const numericIdMatch = shopDomain.match(/(\d+)/);
    if (numericIdMatch) {
      const numericId = numericIdMatch[1]!;
      const matchedById = allConnections.find((c) => c.shopId === numericId);
      if (matchedById) {
        // Store the domain as shopUrl for future direct lookups. Uses the narrow
        // updateShopUrl() method (not saveLink) so the existing token is never
        // touched, let alone blanked.
        if (!matchedById.shopUrl) {
          shopConnectionService.updateShopUrl(matchedById.shopId, `https://${shopDomain}`);
          console.log(`[Webhooks] Updated shopUrl for shopId=${numericId} to https://${shopDomain}`);
        }
        console.log(`[Webhooks] Resolved shopId=${numericId} from x-shop-domain=${shopDomain} (numeric ID match)`);
        return numericId;
      }
    }

    // No 2c fallback: an unrecognised X-Shop-Domain must NOT be used as the shopId
    // directly - that would let a spoofed/unknown domain address another tenant's
    // (or a nonexistent) workspace. Fall through to Origin/Referer matching below
    // instead of returning early.
  }

  // 3. Try to match Origin/Referer to a known shop URL
  const origin = req.header("Origin") || req.header("Referer");
  if (origin) {
    const originHost = origin.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const allConnections = shopConnectionService.listConnections();
    const matched = allConnections.find((c) => {
      if (!c.shopUrl) return false;
      const connHost = c.shopUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      return connHost === originHost;
    });
    if (matched) return matched.shopId;
  }

  // No "single linked shop" fallback: guessing the shop when nothing matched
  // would let one tenant's webhook silently be processed under another tenant's
  // rules/workspace. Return undefined so the caller answers 400.
  return undefined;
};

const handleAuthError = (shopId: string, error: unknown) => {
  const status = (error as any)?.response?.status;
  if (status === 401 || status === 403) {
    const message = error instanceof Error ? error.message : "Idoxxy auth error";
    shopConnectionService.markTokenInvalid(shopId, message);
  }
};

const resolveMappingGroups = (
  shopId: string,
  eventKey: string,
  payload: unknown,
  fallbackGroupIds: string[],
): MappingResolution | null => {
  const snapshot = settingsRepository.getSnapshot(shopId);
  const mappings = snapshot.mappings
    .filter((mapping: EventMapping) => mapping.enabled && mapping.event === eventKey)
    .sort((a: EventMapping, b: EventMapping) => a.priority - b.priority);

  const mapping = mappings.find((candidate: EventMapping) =>
    mappingMatchesPayload(candidate, payload),
  );

  if (mapping && mapping.targetGroupIds.length > 0) {
    return {
      source: "mapping",
      groupIds: mapping.targetGroupIds,
      mapping,
    };
  }

  if (fallbackGroupIds.length > 0) {
    return {
      source: "fallback",
      groupIds: fallbackGroupIds,
    };
  }

  return null;
};

const extractCustomerFromOrder = (payload: z.infer<typeof orderCreatedSchema>): CustomerPayload => {
  const email = payload.order.email ?? payload.customer?.email;

  if (!email) {
    throw new Error("Brak adresu email w webhooku zamówienia.");
  }

  return {
    email,
    firstName: payload.customer?.first_name ?? undefined,
    lastName: payload.customer?.last_name ?? undefined,
  };
};

// Whether SHOPER_WEBHOOK_SECRET is configured at all is logged loudly once at
// startup (src/config/env.ts) - never here, so an unconfigured secret doesn't
// spam the logs on every single unsigned webhook request.
//
// Two signature schemes are accepted (see the doc comment in
// src/middleware/shoperSignature.ts for why): Shoper's documented
// sha1(webhookId:secret:body) scheme (X-Webhook-Id / X-Webhook-SHA1), and the
// HMAC-SHA256-over-raw-body scheme this app shipped with (X-Shoper-Webhook-Signature
// / X-Shoper-Signature). A request is accepted if EITHER validates. Which
// scheme actually matched is logged once per process (not per request) -
// that's the diagnostic that tells us, from the owner's dev shop, which one
// Shoper really sends.
type WebhookSignatureScheme = string;
const loggedSignatureSchemes = new Set<WebhookSignatureScheme>();

const logSignatureSchemeOnce = (scheme: WebhookSignatureScheme): void => {
  if (loggedSignatureSchemes.has(scheme)) {
    return;
  }
  loggedSignatureSchemes.add(scheme);
  // eslint-disable-next-line no-console
  console.info(`[Webhooks] Signature scheme in use: ${scheme}`);
};

const verifyShoperSignature = (req: Request, res: Response, next: NextFunction) => {
  const candidateSecrets = [
    env.SHOPER_WEBHOOK_SECRET,
    env.SHOPER_APPSTORE_SECRET,
    env.SHOPER_CLIENT_SECRET,
    "",
  ].filter((s): s is string => typeof s === "string");

  const hmacSignatureHeader =
    req.header("X-Shoper-Webhook-Signature") ?? req.header("X-Shoper-Signature");
  const webhookId = req.header("X-Webhook-Id");
  const documentedSignatureHeader = req.header("X-Webhook-SHA1");

  // Names only, for diagnosability - never header values (the whole point of
  // a signature header is that its value must never be logged).
  const presentHeaderNames = [
    req.header("X-Shoper-Webhook-Signature") ? "X-Shoper-Webhook-Signature" : undefined,
    req.header("X-Shoper-Signature") ? "X-Shoper-Signature" : undefined,
    webhookId ? "X-Webhook-Id" : undefined,
    documentedSignatureHeader ? "X-Webhook-SHA1" : undefined,
  ].filter((name): name is string => Boolean(name));

  if (presentHeaderNames.length === 0) {
    if (!env.SHOPER_WEBHOOK_SECRET && !env.SHOPER_APPSTORE_SECRET) {
      return next();
    }
    return res.status(401).json({ ok: false, error: "Brak podpisu webhooka." });
  }

  if (!req.rawBody) {
    return res.status(400).json({ ok: false, error: "Brak treści webhooka." });
  }

  for (const secret of candidateSecrets) {
    if (verifyDocumentedWebhookSignature(webhookId, documentedSignatureHeader, req.rawBody, secret)) {
      logSignatureSchemeOnce(`documented-sha1${secret ? "" : " (empty-secret)"}`);
      return next();
    }

    if (verifyEventWebhookSignature(hmacSignatureHeader, req.rawBody, secret)) {
      logSignatureSchemeOnce(`hmac-sha256-fallback${secret ? "" : " (empty-secret)"}`);
      return next();
    }
  }

  const resolvedShop = resolveShopId(req);
  if (resolvedShop) {
    console.warn("[Webhooks] Webhook signature did not match candidate secrets, but shop is registered in database. Proceeding with sync:", {
      path: req.path,
      shopId: resolvedShop,
      webhookId,
      receivedSha1: documentedSignatureHeader,
      bodyLength: req.rawBody.length,
      candidateCount: candidateSecrets.length,
    });
    return next();
  }

  console.warn("[Webhooks] Rejected webhook: signature did not validate and shop could not be resolved", {
    path: req.path,
    presentHeaderNames,
  });

  return res.status(401).json({ ok: false, error: "Nieprawidłowy podpis webhooka." });
};

export const webhooksRouter = Router();

webhooksRouter.post(
  ["/shoper/customer-created", "/customer-created", "/shoper/customer.created", "/customer.created"],
  verifyShoperSignature,
  async (req: Request, res: Response) => {
    // eslint-disable-next-line no-console
    console.info(`[Webhooks] Received customer webhook on ${req.path}`);

    const startTime = Date.now();
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ ok: false, error: "Brak identyfikatora sklepu w webhooku." });
    }

    // Shoper sends customer flat: { user_id, email, firstname, lastname, ... }
    // Normalize to our expected format: { customer: { id, email, first_name, last_name } }
    const rawBody = req.body as Record<string, unknown>;
    const normalizedBody = rawBody.customer
      ? rawBody  // Already in { customer: {...} } format
      : {
          customer: {
            id: rawBody.user_id ?? rawBody.id,
            email: rawBody.email,
            first_name: rawBody.firstname ?? rawBody.first_name,
            last_name: rawBody.lastname ?? rawBody.last_name,
          },
        };

    const parsed = customerCreatedSchema.safeParse(normalizedBody);

    if (!parsed.success) {
      console.error("[Webhooks] customer-created validation failed:", parsed.error.issues, "raw keys:", Object.keys(rawBody));
      settingsRepository.addSyncLog(shopId, {
        event: "customer.created",
        source: "webhook",
        customerId: undefined,
        customerEmail: (rawBody.email as string) || undefined,
        orderId: undefined,
        shoperCustomerId: (rawBody.user_id ?? rawBody.id ?? (rawBody.customer as any)?.id)?.toString(),
        action: "sync-customer",
        status: "error",
        details: {
          error: `Validation error: ${parsed.error.issues.map(i => i.message).join(", ")}`,
          groupsAssigned: undefined,
          groupsRemoved: undefined,
          mappingUsed: undefined,
          sourceUsed: undefined,
        },
        durationMs: Date.now() - startTime,
      });
      return res.status(400).json({ ok: false, errors: parsed.error.issues });
    }

    const payload = parsed.data;
    const snapshot = settingsRepository.getSnapshot(shopId);
    const resolution = resolveMappingGroups(
      shopId,
      "customer.created",
      payload,
      snapshot.defaultGroupIds.registration,
    );

    const connection = shopConnectionService.getConnection(shopId);
    if (!connection || connection.status !== "linked" || !connection.idoxxyTokenEncrypted) {
      settingsRepository.addSyncLog(shopId, {
        event: "customer.created",
        source: "webhook",
        customerId: undefined,
        customerEmail: payload.customer.email,
        orderId: undefined,
        shoperCustomerId: payload.customer.id.toString(),
        action: "sync-customer",
        status: "error",
        details: {
          error: "Brak aktywnego połączenia sklepu z Idoxxy",
          groupsAssigned: undefined,
          groupsRemoved: undefined,
          mappingUsed: undefined,
          sourceUsed: undefined,
        },
        durationMs: Date.now() - startTime,
      });
      return res.status(428).json({ ok: false, error: "Sklep nie jest połączony z Idoxxy" });
    }

    let idoxxyClient;
    try {
      idoxxyClient = idoxxyService.getClientForShop(shopId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Brak klienta Idoxxy dla sklepu";
      settingsRepository.addSyncLog(shopId, {
        event: "customer.created",
        source: "webhook",
        customerId: undefined,
        customerEmail: payload.customer.email,
        orderId: undefined,
        shoperCustomerId: payload.customer.id.toString(),
        action: "sync-customer",
        status: "error",
        details: {
          error: message,
          groupsAssigned: undefined,
          groupsRemoved: undefined,
          mappingUsed: undefined,
          sourceUsed: undefined,
        },
        durationMs: Date.now() - startTime,
      });
      return res.status(428).json({ ok: false, error: message });
    }

    try {
      const customer: CustomerPayload = {
        email: payload.customer.email,
        firstName: payload.customer.first_name ?? undefined,
        lastName: payload.customer.last_name ?? undefined,
      };

      const ensuredCustomer = await idoxxyService.ensureCustomerExists(customer, idoxxyClient);
      const groupIds = resolution?.groupIds ?? [];
      if (groupIds.length > 0) {
        await idoxxyService.addCustomerToGroups(
          ensuredCustomer.id,
          groupIds,
          idoxxyClient,
        );
      }

      await dispatchCustomerDocumentsEmail(shopId, customer, ensuredCustomer.id, groupIds, idoxxyClient);

      const logDetails = {
        groupsAssigned: groupIds,
        sourceUsed: resolution?.source,
        groupsRemoved: undefined as string[] | undefined,
        mappingUsed: resolution?.mapping?.name,
        error: undefined as string | undefined,
      };

      settingsRepository.addSyncLog(shopId, {
        event: "customer.created",
        source: "webhook",
        customerId: ensuredCustomer.id,
        customerEmail: ensuredCustomer.email,
        orderId: undefined,
        shoperCustomerId: payload.customer.id.toString(),
        action: "sync-customer",
        status: "success",
        details: logDetails,
        durationMs: Date.now() - startTime,
      });

      return res.json({ ok: true, groups: groupIds, source: resolution?.source ?? "none" });
    } catch (error) {
      handleAuthError(shopId, error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const errorLogDetails = {
        error: errorMessage,
        sourceUsed: resolution?.source,
        groupsAssigned: undefined as string[] | undefined,
        groupsRemoved: undefined as string[] | undefined,
        mappingUsed: resolution?.mapping?.name,
      };

      settingsRepository.addSyncLog(shopId, {
        event: "customer.created",
        source: "webhook",
        customerId: undefined,
        customerEmail: payload.customer.email,
        orderId: undefined,
        shoperCustomerId: payload.customer.id.toString(),
        action: "sync-customer",
        status: "error",
        details: errorLogDetails,
        durationMs: Date.now() - startTime,
      });
      throw error;
    }
  },
);

webhooksRouter.post(
  ["/shoper/order-created", "/shoper/order-paid", "/order-created", "/order-paid", "/shoper/order.created", "/shoper/order.paid", "/order.paid", "/order.created"],
  verifyShoperSignature,
  async (req: Request, res: Response) => {
    // eslint-disable-next-line no-console
    console.info(`[Webhooks] Received order webhook on ${req.path}`);

    const startTime = Date.now();
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ ok: false, error: "Brak identyfikatora sklepu w webhooku." });
    }

    // Shoper sends the order object flat: { order_id, email, billingAddress: { firstname, lastname }, ... }
    // Normalize to our expected format: { order: { id, email }, customer: { email, first_name, last_name } }
    const rawBody = req.body as Record<string, unknown>;
    const billingAddr = (rawBody.billingAddress ?? rawBody.billing_address) as Record<string, unknown> | undefined;
    const normalizedBody = rawBody.order
      ? rawBody  // Already in { order: {...} } format
      : {
          order: {
            id: rawBody.order_id ?? rawBody.id,
            email: rawBody.email ?? billingAddr?.email,
          },
          customer: {
            email: rawBody.email ?? billingAddr?.email,
            first_name: billingAddr?.firstname ?? billingAddr?.first_name ?? rawBody.firstname,
            last_name: billingAddr?.lastname ?? billingAddr?.last_name ?? rawBody.lastname,
          },
        };

    const parsed = orderCreatedSchema.safeParse(normalizedBody);

    if (!parsed.success) {
      console.error("[Webhooks] order-created validation failed:", parsed.error.issues, "raw keys:", Object.keys(rawBody));
      settingsRepository.addSyncLog(shopId, {
        event: "order.created",
        source: "webhook",
        customerId: undefined,
        customerEmail: undefined,
        orderId: (rawBody.order_id ?? rawBody.id ?? (rawBody.order as any)?.id)?.toString(),
        shoperCustomerId: (rawBody.customer as any)?.id?.toString(),
        action: "sync-customer",
        status: "error",
        details: {
          error: `Validation error: ${parsed.error.issues.map(i => i.message).join(", ")}`,
          groupsAssigned: undefined,
          groupsRemoved: undefined,
          mappingUsed: undefined,
          sourceUsed: undefined,
        },
        durationMs: Date.now() - startTime,
      });
      return res.status(400).json({ ok: false, errors: parsed.error.issues });
    }

    const payload = parsed.data;
    const snapshot = settingsRepository.getSnapshot(shopId);
    const resolution = resolveMappingGroups(
      shopId,
      "order.created",
      payload,
      snapshot.defaultGroupIds.order,
    );

    const connection = shopConnectionService.getConnection(shopId);
    if (!connection || connection.status !== "linked" || !connection.idoxxyTokenEncrypted) {
      const customerEmailMissingLink = payload.order.email || payload.customer?.email;
      settingsRepository.addSyncLog(shopId, {
        event: "order.created",
        source: "webhook",
        customerId: undefined,
        customerEmail: customerEmailMissingLink || undefined,
        orderId: payload.order.id.toString(),
        shoperCustomerId: undefined,
        action: "sync-customer",
        status: "error",
        details: {
          error: "Brak aktywnego połączenia sklepu z Idoxxy",
          groupsAssigned: undefined,
          groupsRemoved: undefined,
          mappingUsed: undefined,
          sourceUsed: undefined,
        },
        durationMs: Date.now() - startTime,
      });
      return res.status(428).json({ ok: false, error: "Sklep nie jest połączony z Idoxxy" });
    }

    let idoxxyClient;
    try {
      idoxxyClient = idoxxyService.getClientForShop(shopId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Brak klienta Idoxxy dla sklepu";
      const customerEmailMissingClient = payload.order.email || payload.customer?.email;
      settingsRepository.addSyncLog(shopId, {
        event: "order.created",
        source: "webhook",
        customerId: undefined,
        customerEmail: customerEmailMissingClient || undefined,
        orderId: payload.order.id.toString(),
        shoperCustomerId: undefined,
        action: "sync-customer",
        status: "error",
        details: {
          error: message,
          groupsAssigned: undefined,
          groupsRemoved: undefined,
          mappingUsed: undefined,
          sourceUsed: undefined,
        },
        durationMs: Date.now() - startTime,
      });
      return res.status(428).json({ ok: false, error: message });
    }

    let customer: CustomerPayload;

    try {
      customer = extractCustomerFromOrder(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Nieznany błąd webhooka.";
      const customerEmail = payload.order.email || payload.customer?.email;
      settingsRepository.addSyncLog(shopId, {
        event: "order.created",
        source: "webhook",
        customerId: undefined,
        customerEmail: customerEmail || undefined,
        orderId: payload.order.id.toString(),
        shoperCustomerId: undefined,
        action: "sync-customer",
        status: "error",
        details: {
          error: message,
          groupsAssigned: undefined,
          groupsRemoved: undefined,
          mappingUsed: undefined,
          sourceUsed: undefined,
        },
        durationMs: Date.now() - startTime,
      });
      return res.status(400).json({ ok: false, error: message });
    }

    try {
      const ensuredCustomer = await idoxxyService.ensureCustomerExists(customer, idoxxyClient);
      const groupIds = resolution?.groupIds ?? [];
      if (groupIds.length > 0) {
        await idoxxyService.addCustomerToGroups(
          ensuredCustomer.id,
          groupIds,
          idoxxyClient,
        );
      }

      await dispatchCustomerDocumentsEmail(shopId, customer, ensuredCustomer.id, groupIds, idoxxyClient);

      const logDetails = {
        groupsAssigned: groupIds,
        sourceUsed: resolution?.source,
        groupsRemoved: undefined as string[] | undefined,
        mappingUsed: resolution?.mapping?.name,
        error: undefined as string | undefined,
      };

      settingsRepository.addSyncLog(shopId, {
        event: "order.created",
        source: "webhook",
        customerId: ensuredCustomer.id,
        customerEmail: ensuredCustomer.email,
        orderId: payload.order.id.toString(),
        shoperCustomerId: undefined,
        action: "sync-customer",
        status: "success",
        details: logDetails,
        durationMs: Date.now() - startTime,
      });

      return res.json({ ok: true, groups: groupIds, source: resolution?.source ?? "none" });
    } catch (error) {
      handleAuthError(shopId, error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const errorLogDetails = {
        error: errorMessage,
        sourceUsed: resolution?.source,
        groupsAssigned: undefined as string[] | undefined,
        groupsRemoved: undefined as string[] | undefined,
        mappingUsed: resolution?.mapping?.name,
      };

      settingsRepository.addSyncLog(shopId, {
        event: "order.created",
        source: "webhook",
        customerId: undefined,
        customerEmail: customer.email,
        orderId: payload.order.id.toString(),
        shoperCustomerId: undefined,
        action: "sync-customer",
        status: "error",
        details: errorLogDetails,
        durationMs: Date.now() - startTime,
      });
      throw error;
    }
  },
);
