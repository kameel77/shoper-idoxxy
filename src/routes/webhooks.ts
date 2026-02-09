import crypto from "node:crypto";

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";

import { env } from "../config/env";
import { settingsRepository } from "../repositories/settingsRepository";
import type { EventMapping } from "../types/settings";
import { IdoxxyService } from "../services/idoxxyService";
import { shopConnectionService } from "../services/shopConnectionService";

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

const resolveShopId = (req: Request): string | undefined => {
  const headerId =
    req.header("X-Shoper-Shop-Id") ||
    req.header("X-Shop-Id") ||
    req.header("X-Shop") ||
    req.header("X-Shop-Url");
  const bodyId = (req.body as any)?.shop_id ?? (req.body as any)?.shopId;
  return (headerId ?? bodyId)?.toString();
};

const handleAuthError = (shopId: string, error: unknown) => {
  const status = (error as any)?.response?.status;
  if (status === 401 || status === 403) {
    const message = error instanceof Error ? error.message : "Idoxxy auth error";
    shopConnectionService.markTokenInvalid(shopId, message);
  }
};

const resolveMappingGroups = (
  eventKey: string,
  payload: unknown,
  fallbackGroupIds: string[],
): MappingResolution | null => {
  const snapshot = settingsRepository.getSnapshot();
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

const verifyShoperSignature = (req: Request, res: Response, next: NextFunction) => {
  if (!env.SHOPER_WEBHOOK_SECRET) {
    return next();
  }

  const signatureHeader =
    req.header("X-Shoper-Webhook-Signature") ?? req.header("X-Shoper-Signature");

  if (!signatureHeader) {
    return res.status(401).json({ ok: false, error: "Brak podpisu webhooka." });
  }

  if (!req.rawBody) {
    return res.status(400).json({ ok: false, error: "Brak treści webhooka." });
  }

  const expected = crypto
    .createHmac("sha256", env.SHOPER_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("hex");

  const received = signatureHeader.trim();

  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  ) {
    return res.status(401).json({ ok: false, error: "Nieprawidłowy podpis webhooka." });
  }

  return next();
};

export const webhooksRouter = Router();

webhooksRouter.post(
  "/shoper/customer-created",
  verifyShoperSignature,
  async (req: Request, res: Response) => {
    const startTime = Date.now();
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ ok: false, error: "Brak identyfikatora sklepu w webhooku." });
    }
    const parsed = customerCreatedSchema.safeParse(req.body);

    if (!parsed.success) {
      settingsRepository.addSyncLog({
        event: "customer.created",
        source: "webhook",
        customerId: undefined,
        customerEmail: undefined,
        orderId: undefined,
        shoperCustomerId: req.body?.customer?.id?.toString(),
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
    const snapshot = settingsRepository.getSnapshot();
    const resolution = resolveMappingGroups(
      "customer.created",
      payload,
      snapshot.defaultGroupIds.registration,
    );

    const connection = shopConnectionService.getConnection(shopId);
    if (!connection || connection.status !== "linked" || !connection.idoxxyTokenEncrypted) {
      settingsRepository.addSyncLog({
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
      settingsRepository.addSyncLog({
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

    if (!resolution) {
      settingsRepository.addSyncLog({
        event: "customer.created",
        source: "webhook",
        customerId: undefined,
        customerEmail: payload.customer.email,
        orderId: undefined,
        shoperCustomerId: payload.customer.id.toString(),
        action: "sync-customer",
        status: "error",
        details: {
          error: "No mapping or default groups found for customer-created webhook",
          groupsAssigned: undefined,
          groupsRemoved: undefined,
          mappingUsed: undefined,
          sourceUsed: "fallback",
        },
        durationMs: Date.now() - startTime,
      });
      // eslint-disable-next-line no-console
      console.warn("Brak mapowania lub grup domyślnych dla webhooka customer-created.", {
        idoxxyPath: payload.idoxxy_path,
      });
      return res.status(202).json({ ok: false, reason: "no-groups" });
    }

    try {
      const customer: CustomerPayload = {
        email: payload.customer.email,
        firstName: payload.customer.first_name ?? undefined,
        lastName: payload.customer.last_name ?? undefined,
      };

      const ensuredCustomer = await idoxxyService.ensureCustomerExists(customer, idoxxyClient);
      await idoxxyService.addCustomerToGroups(
        ensuredCustomer.id,
        resolution.groupIds,
        idoxxyClient,
      );

      const logDetails = {
        groupsAssigned: resolution.groupIds,
        sourceUsed: resolution.source,
        groupsRemoved: undefined as string[] | undefined,
        mappingUsed: undefined as string | undefined,
        error: undefined as string | undefined,
      };
      if (resolution.mapping?.name) {
        logDetails.mappingUsed = resolution.mapping.name;
      }

      settingsRepository.addSyncLog({
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

      return res.json({ ok: true, groups: resolution.groupIds, source: resolution.source });
    } catch (error) {
      handleAuthError(shopId, error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const errorLogDetails = {
        error: errorMessage,
        sourceUsed: resolution.source,
        groupsAssigned: undefined as string[] | undefined,
        groupsRemoved: undefined as string[] | undefined,
        mappingUsed: undefined as string | undefined,
      };
      if (resolution.mapping?.name) {
        errorLogDetails.mappingUsed = resolution.mapping.name;
      }

      settingsRepository.addSyncLog({
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
  "/shoper/order-created",
  verifyShoperSignature,
  async (req: Request, res: Response) => {
    const startTime = Date.now();
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ ok: false, error: "Brak identyfikatora sklepu w webhooku." });
    }
    const parsed = orderCreatedSchema.safeParse(req.body);

    if (!parsed.success) {
      settingsRepository.addSyncLog({
        event: "order.created",
        source: "webhook",
        customerId: undefined,
        customerEmail: undefined,
        orderId: req.body?.order?.id?.toString(),
        shoperCustomerId: req.body?.customer?.id?.toString(),
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
    const snapshot = settingsRepository.getSnapshot();
    const resolution = resolveMappingGroups(
      "order.created",
      payload,
      snapshot.defaultGroupIds.order,
    );

    const connection = shopConnectionService.getConnection(shopId);
    if (!connection || connection.status !== "linked" || !connection.idoxxyTokenEncrypted) {
      const customerEmailMissingLink = payload.order.email || payload.customer?.email;
      settingsRepository.addSyncLog({
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
      settingsRepository.addSyncLog({
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

    if (!resolution) {
      const customerEmail = payload.order.email || payload.customer?.email;
      settingsRepository.addSyncLog({
        event: "order.created",
        source: "webhook",
        customerId: undefined,
        customerEmail: customerEmail || undefined,
        orderId: payload.order.id.toString(),
        shoperCustomerId: undefined,
        action: "sync-customer",
        status: "error",
        details: {
          error: "No mapping or default groups found for order-created webhook",
          groupsAssigned: undefined,
          groupsRemoved: undefined,
          mappingUsed: undefined,
          sourceUsed: "fallback",
        },
        durationMs: Date.now() - startTime,
      });
      // eslint-disable-next-line no-console
      console.warn("Brak mapowania lub grup domyślnych dla webhooka order-created.", {
        idoxxyPath: payload.idoxxy_path,
      });
      return res.status(202).json({ ok: false, reason: "no-groups" });
    }

    let customer: CustomerPayload;

    try {
      customer = extractCustomerFromOrder(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Nieznany błąd webhooka.";
      const customerEmail = payload.order.email || payload.customer?.email;
      settingsRepository.addSyncLog({
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
      await idoxxyService.addCustomerToGroups(
        ensuredCustomer.id,
        resolution.groupIds,
        idoxxyClient,
      );

      const logDetails = {
        groupsAssigned: resolution.groupIds,
        sourceUsed: resolution.source,
        groupsRemoved: undefined as string[] | undefined,
        mappingUsed: undefined as string | undefined,
        error: undefined as string | undefined,
      };
      if (resolution.mapping?.name) {
        logDetails.mappingUsed = resolution.mapping.name;
      }

      settingsRepository.addSyncLog({
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

      return res.json({ ok: true, groups: resolution.groupIds, source: resolution.source });
    } catch (error) {
      handleAuthError(shopId, error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const errorLogDetails = {
        error: errorMessage,
        sourceUsed: resolution.source,
        groupsAssigned: undefined as string[] | undefined,
        groupsRemoved: undefined as string[] | undefined,
        mappingUsed: undefined as string | undefined,
      };
      if (resolution.mapping?.name) {
        errorLogDetails.mappingUsed = resolution.mapping.name;
      }

      settingsRepository.addSyncLog({
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
