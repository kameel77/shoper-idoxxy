import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { resolveShopClient } from "../middleware/resolveShopClient";
import { settingsRepository } from "../repositories/settingsRepository";
import { IdoxxyService } from "../services/idoxxyService";
import { emailService } from "../services/emailService";
import { shopConnectionService } from "../services/shopConnectionService";
import { requireShopSession, requireCsrf } from "../middleware/shopSession";
import type { SettingsSnapshot } from "../types/settings";

export const idoxxyAdminRouter = Router();

// Every route on this router touches per-shop data - require a verified shop
// session for all of it. req.shopId is populated by requireShopSession from
// the session (or, for an authenticated operator, from an explicit ?shopId=
// they supplied).
idoxxyAdminRouter.use(requireShopSession);

const firstParam = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;
const idoxxyService = new IdoxxyService();

const pathMappingSchema = z.object({
  pathKey: z.string().min(1),
  groupIds: z.array(z.string().uuid()).default([]),
});

const settingsSchema = z.object({
  shoperApiKey: z.string().min(1).optional(),
  idoxxyApiKey: z.string().min(1).optional(),
  fallbackRegistrationGroupIds: z.array(z.string().uuid()).default([]),
  fallbackOrderGroupIds: z.array(z.string().uuid()).default([]),
  pathMappings: z.array(pathMappingSchema).default([]),
});

const customerGroupsSchema = z.object({
  groupIds: z.array(z.string().uuid()).default([]),
});

const bulkActionSchema = z.object({
  action: z.enum(["assign-group", "remove-group", "resend-documents"]).optional(),
  ids: z.array(z.string()),
  customers: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      groupIds: z.array(z.string()).optional(),
    })
  ).optional(),
  groupId: z.string().optional(),
});

const bulkAddGroupSchema = z.object({
  groupId: z.string().uuid(),
  customerIds: z.array(z.string().uuid()).min(1),
});

const resendDocumentSchema = z.object({
  recipients: z.array(z.string()).min(1),
});

idoxxyAdminRouter.get("/settings", (req: Request, res: Response) => {
  res.json(settingsRepository.getSnapshot(req.shopId!));
});

idoxxyAdminRouter.put("/settings", requireCsrf, (req: Request, res: Response) => {
  const shopId = req.shopId!;

  const parsed = settingsSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  const payload: SettingsSnapshot = {
    ...parsed.data,
    defaultGroupIds: {
      registration: parsed.data.fallbackRegistrationGroupIds,
      order: parsed.data.fallbackOrderGroupIds,
    },
    mappings: [],
    syncLogs: [],
    baseUrl: undefined,
    credentials: { baseUrl: undefined, apiKey: undefined },
    shoperApiKey: undefined,
    idoxxyApiKey: undefined,
    lastSyncedAt: undefined,
    lastSettingsModifiedAt: undefined,
  };

  settingsRepository.updateSettings(shopId, payload);
  return res.json({ ok: true });
});

idoxxyAdminRouter.get("/groups", async (req: Request, res: Response) => {
  try {
    const client = resolveShopClient(req);
    const groups = await client.listGroups();
    return res.json(groups);
  } catch (error) {
    const statusCode = (error as any)?.statusCode;
    const message =
      error instanceof Error ? error.message : "Nieznany błąd integracji";
    return res.status(statusCode || 500).json({ ok: false, error: message });
  }
});

idoxxyAdminRouter.get("/customers", async (req: Request, res: Response) => {
  try {
    const client = resolveShopClient(req);
    const search = typeof req.query.query === "string" ? req.query.query : undefined;
    const page = typeof req.query.page === "string" ? parseInt(req.query.page, 10) : 1;
    
    // API stronicuje od 0, więc odejmujemy 1
    const params: { search?: string; page: number; size: number } = {
      page: Math.max(0, page - 1),
      size: 10,
    };
    if (search) {
      params.search = search;
    }

    const customers = await client.listCustomersWithGroups(params);
    return res.json(customers);
  } catch (error) {
    const statusCode = (error as any)?.statusCode;
    const message =
      error instanceof Error ? error.message : "Nieznany błąd integracji";
    return res.status(statusCode || 500).json({ ok: false, error: message });
  }
});

idoxxyAdminRouter.get(
  "/customers/:id",
  async (req: Request, res: Response) => {
    try {
      const client = resolveShopClient(req);
      const { id } = req.params as { id: string };
      const customer = await client.getCustomerGroups(id);
      if (!customer) {
        return res
          .status(404)
          .json({ ok: false, error: "Nie znaleziono klienta w iDoxxy" });
      }

      const name = `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || customer.email;
      const groupIds = (customer.customerGroups || []).map((g) => g.id);
      const groups = (customer.customerGroups || []).map((g) => g.groupName);

      return res.json({
        ok: true,
        customer: {
          id: customer.id,
          name,
          firstName: customer.firstName,
          lastName: customer.lastName,
          email: customer.email,
          status: "active",
          createdAt: customer.createdAt,
          lastActivity: customer.updatedAt || customer.createdAt,
          groupIds,
          groups,
        },
      });
    } catch (error) {
      const statusCode = (error as any)?.statusCode;
      const message =
        error instanceof Error ? error.message : "Nieznany błąd integracji";
      return res.status(statusCode || 500).json({ ok: false, error: message });
    }
  },
);

idoxxyAdminRouter.get(
  "/customers/:id/groups",
  async (req: Request, res: Response) => {
    try {
      const client = resolveShopClient(req);
      const { id } = req.params as { id: string };
      const groups = await idoxxyService.getCustomerGroups(id, client);
      if (!groups) {
        return res
          .status(404)
          .json({ ok: false, error: "Nie znaleziono klienta" });
      }

      return res.json({ ok: true, groups });
    } catch (error) {
      const statusCode = (error as any)?.statusCode;
      const message =
        error instanceof Error ? error.message : "Nieznany błąd integracji";
      return res.status(statusCode || 500).json({ ok: false, error: message });
    }
  },
);

idoxxyAdminRouter.put(
  "/customers/:id/groups",
  requireCsrf,
  async (req: Request, res: Response) => {
    const parsed = customerGroupsSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ ok: false, errors: parsed.error.issues });
    }

    try {
      const client = resolveShopClient(req);
      const { id } = req.params as { id: string };
      const currentGroups = (await idoxxyService.getCustomerGroups(id, client)) || [];
      const currentGroupIds = new Set(currentGroups.map((g: any) => g.id));
      const targetGroupIds = new Set(parsed.data.groupIds);

      const toAdd = parsed.data.groupIds.filter((groupId) => !currentGroupIds.has(groupId));
      const toRemove = currentGroups
        .filter((group: any) => !targetGroupIds.has(group.id))
        .map((group: any) => group.id);

      await Promise.all([
        ...toAdd.map((groupId) => client.addCustomerToGroup(groupId, id)),
        ...toRemove.map((groupId) => client.removeCustomerFromGroup(groupId, id)),
      ]);

      return res.json({ ok: true });
    } catch (error) {
      const statusCode = (error as any)?.statusCode;
      const message =
        error instanceof Error ? error.message : "Nieznany błąd integracji";
      return res.status(statusCode || 500).json({ ok: false, error: message });
    }
  },
);

idoxxyAdminRouter.post(
  "/customers/bulk-add-group",
  requireCsrf,
  async (req: Request, res: Response) => {
    const parsed = bulkAddGroupSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ ok: false, errors: parsed.error.issues });
    }

    try {
      const client = resolveShopClient(req);
      await idoxxyService.addCustomersToGroup(
        parsed.data.groupId,
        parsed.data.customerIds,
        client,
      );
      return res.json({ ok: true });
    } catch (error) {
      const statusCode = (error as any)?.statusCode;
      const message =
        error instanceof Error ? error.message : "Nieznany błąd integracji";
      return res.status(statusCode || 500).json({ ok: false, error: message });
    }
  },
);

idoxxyAdminRouter.post("/customers/bulk", requireCsrf, async (req: Request, res: Response) => {
  const parsed = bulkActionSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  const { ids, action, groupId } = parsed.data;

  try {
    const client = resolveShopClient(req);

    if (action === "assign-group" && groupId) {
      await idoxxyService.addCustomersToGroup(groupId, ids, client);
      return res.json({ ok: true, updated: ids.length });
    }

    if (action === "remove-group" && groupId) {
      for (const customerId of ids) {
        try {
          await client.removeCustomerFromGroup(groupId, customerId);
        } catch (error) {
          console.error(`Error removing customer ${customerId} from group ${groupId}:`, error);
        }
      }
      return res.json({ ok: true, updated: ids.length });
    }

    if (action === "resend-documents") {
      try {
        const results: Array<{ customerId: string; email?: string; status: string; documents?: string[]; error?: string }> = [];

        const docsResponse = await client.listDocuments();
        const allDocuments = docsResponse.content || [];
        console.info(`[IdoxxyAdmin] Found ${allDocuments.length} documents in iDoxxy`);

        if (allDocuments.length === 0) {
          return res.json({
            ok: false,
            error: "Brak dokumentów w koncie iDoxxy. Nie ma czego wysłać.",
          });
        }

        for (const customerId of ids) {
          try {
            const customerData = parsed.data.customers?.find(c => c.id === customerId);

            if (!customerData || !customerData.email) {
              results.push({ customerId, status: "error", error: "Brak adresu email" });
              continue;
            }

            const customerGroupIds = new Set(customerData.groupIds || []);

            const matchedDocs = allDocuments.filter((doc: any) =>
              doc.recipients?.some((recipient: any) => customerGroupIds.has(recipient.id))
            );

            if (matchedDocs.length === 0) {
              console.info(`[IdoxxyAdmin] No group match for ${customerData.email}, sending all ${allDocuments.length} documents`);
              for (const doc of allDocuments) {
                await idoxxyService.resendDocumentNotification(doc.id, [customerData.email], client);
              }
              results.push({
                customerId,
                email: customerData.email,
                status: "sent",
                documents: allDocuments.map((d: any) => d.documentName),
              });
            } else {
              console.info(`[IdoxxyAdmin] Matched ${matchedDocs.length} documents for ${customerData.email}`);
              for (const doc of matchedDocs) {
                await idoxxyService.resendDocumentNotification(doc.id, [customerData.email], client);
              }
              results.push({
                customerId,
                email: customerData.email,
                status: "sent",
                documents: matchedDocs.map((d: any) => d.documentName),
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "Nieznany błąd";
            results.push({ customerId, status: "error", error: message });
          }
        }

        const sent = results.filter(r => r.status === "sent").length;
        const failed = results.filter(r => r.status === "error").length;

        return res.json({
          ok: true,
          summary: { sent, failed, total: ids.length },
          results,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Nieznany błąd wysyłki dokumentów";
        return res.status(500).json({ ok: false, error: message });
      }
    }

    return res.json({ ok: true, updated: 0 });
  } catch (error) {
    const statusCode = (error as any)?.statusCode;
    const message =
      error instanceof Error ? error.message : "Nieznany błąd operacji zbiorczej";
    return res.status(statusCode || 500).json({ ok: false, error: message });
  }
});

// DEBUG: probe Idoxxy API for correct document listing endpoint
idoxxyAdminRouter.get("/debug/documents", async (req: Request, res: Response) => {
  const client = resolveShopClient(req);
  const results: Record<string, unknown> = {};

  const pathsToTry = [
    "/customer/documents/listAll",
    "/documents/listAll",
    "/documents/search",
    "/documents",
  ];

  for (const path of pathsToTry) {
    try {
      const response = await (client as any).authorizedRequest({
        method: "get",
        url: path,
      });
      results[path] = { status: response.status, data: response.data };
      console.info(`[DEBUG] ${path} =>`, JSON.stringify(response.data, null, 2));
    } catch (error: any) {
      results[path] = { 
        error: error.message,
        status: error.response?.status,
        data: error.response?.data,
      };
      console.info(`[DEBUG] ${path} => ERROR ${error.response?.status}:`, error.response?.data);
    }
  }

  return res.json({ ok: true, results });
});

idoxxyAdminRouter.post("/documents/:documentId/resend-notification", requireCsrf, async (req: Request, res: Response) => {
  const documentId = firstParam(req.params.documentId);
  
  if (!documentId) {
    return res.status(400).json({ ok: false, error: "Brak identyfikatora dokumentu" });
  }

  const parsed = resendDocumentSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  try {
    const client = resolveShopClient(req);
    await idoxxyService.resendDocumentNotification(documentId, parsed.data.recipients, client);
    return res.json({ ok: true });
  } catch (error) {
    const statusCode = (error as any)?.statusCode;
    const message = error instanceof Error ? error.message : "Nieznany błąd podczas ponownej wysyłki dokumentu";
    return res.status(statusCode || 500).json({ ok: false, error: message });
  }
});
