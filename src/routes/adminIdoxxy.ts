import { randomUUID } from "node:crypto";

import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { settingsRepository } from "../repositories/settingsRepository";
import { IdoxxyService } from "../services/idoxxyService";
import { emailService } from "../services/emailService";
import { requireShopSession, requireCsrf } from "../middleware/shopSession";

const idoxxyService = new IdoxxyService();
export const adminIdoxxyRouter = Router();

// Every route on this router touches per-shop (or demo, but still
// settings-adjacent) data - require a verified shop session for all of it.
// req.shopId is populated by requireShopSession from the session (or, for an
// authenticated operator, from an explicit ?shopId= they supplied).
adminIdoxxyRouter.use(requireShopSession);

const firstParam = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const credentialsSchema = z.object({
  apiKey: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  baseUrl: z.string().url(),
});

const defaultGroupsSchema = z.object({
  registration: z.array(z.string().uuid()).default([]),
  order: z.array(z.string().uuid()).default([]),
});

const mappingConditionSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(["equals", "not_equals", "includes"]),
  value: z.string(),
});

const mappingSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  event: z.string().min(1),
  priority: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
  targetGroupIds: z.array(z.string().uuid()),
  documentId: z.string().uuid().optional(),
  conditions: z.array(mappingConditionSchema).default([]),
});

const bulkActionSchema = z.object({
  action: z.enum(["assign-group", "remove-group", "resend-documents"]).optional(),
  ids: z.array(z.string().uuid()),
  groupId: z.string().uuid().optional(),
});

const customerGroupSchema = z.object({
  groupIds: z.array(z.string().uuid()),
});

const resendDocumentSchema = z.object({
  recipients: z.array(z.string()).min(1),
});

type Group = { id: string; name: string };
type DocumentItem = { id: string; name: string; uniqueLink?: string };
type Customer = {
  id: string;
  name: string;
  email: string;
  status: string;
  lastActivity: string;
  groupIds: string[];
  documents?: string[];
};

const groups: Group[] = [
  { id: randomUUID(), name: "Newsletter" },
  { id: randomUUID(), name: "Dokumenty umów" },
  { id: randomUUID(), name: "Regulamin" },
  { id: randomUUID(), name: "B2B" },
  { id: randomUUID(), name: "VIP" },
];

const documents: DocumentItem[] = [
  { id: randomUUID(), name: "Regulamin sklepu", uniqueLink: randomUUID() },
  { id: randomUUID(), name: "OWU", uniqueLink: randomUUID() },
  { id: randomUUID(), name: "Polityka prywatności", uniqueLink: randomUUID() },
];

const customers: Customer[] = Array.from({ length: 28 }, (_, index) => {
  const id = randomUUID();
  const fallbackGroupId = groups[0]?.id ?? id;
  return {
    id,
    name: `Klient ${index + 1}`,
    email: `klient${index + 1}@example.com`,
    status: index % 3 === 0 ? "pending" : index % 2 === 0 ? "active" : "disabled",
    lastActivity: new Date(Date.now() - index * 86_400_000).toISOString(),
    groupIds: [groups[index % groups.length]?.id ?? fallbackGroupId],
    documents: index % 2 === 0 ? [documents[0]?.id, documents[1]?.id].filter(Boolean) as string[] : [],
  };
});

const paginate = <T>(items: T[], page = 1, perPage = 8) => {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const start = (currentPage - 1) * perPage;
  return {
    items: items.slice(start, start + perPage),
    totalPages,
    currentPage,
  };
};

adminIdoxxyRouter.get("/settings/test-connection", async (req: Request, res: Response) => {
  const shopId = req.shopId!;

  try {
    const result = await idoxxyService.healthCheck(shopId);
    res.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Nieznany błąd integracji";
    res.status(500).json({ ok: false, error: message });
  }
});

adminIdoxxyRouter.get("/settings/config", (req: Request, res: Response) => {
  res.json(settingsRepository.getSnapshot(req.shopId!));
});

adminIdoxxyRouter.put("/settings/credentials", requireCsrf, (req: Request, res: Response) => {
  const shopId = req.shopId!;

  const parsed = credentialsSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  settingsRepository.saveCredentials(shopId, parsed.data);
  return res.json({ ok: true });
});

adminIdoxxyRouter.put("/settings/default-groups", requireCsrf, (req: Request, res: Response) => {
  const shopId = req.shopId!;

  const parsed = defaultGroupsSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  settingsRepository.updateDefaultGroups(shopId, parsed.data);
  return res.json({ ok: true });
});

adminIdoxxyRouter.post("/settings/mappings", requireCsrf, (req: Request, res: Response) => {
  const shopId = req.shopId!;

  const parsed = mappingSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  const { id, documentId, ...rest } = parsed.data;
  try {
    const mapping = settingsRepository.upsertMapping(shopId, {
      ...rest,
      id: id || undefined,
      documentId: documentId || undefined,
    });
    return res.json({ ok: true, mapping });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Nie udało się zapisać mapowania.";
    return res.status(400).json({ ok: false, error: message });
  }
});

adminIdoxxyRouter.delete("/settings/mappings/:id", requireCsrf, (req: Request, res: Response) => {
  const shopId = req.shopId!;

  const id = firstParam(req.params.id);

  if (!id) {
    return res.status(400).json({ ok: false, error: "Brak identyfikatora mapowania" });
  }

  const removed = settingsRepository.removeMapping(shopId, id);
  if (!removed) {
    return res.status(404).json({ ok: false, error: "Nie znaleziono mapowania dla tego sklepu." });
  }
  return res.json({ ok: true });
});

adminIdoxxyRouter.get("/settings/groups", (_req: Request, res: Response) => {
  res.json({ items: groups });
});

adminIdoxxyRouter.get("/settings/documents", (_req: Request, res: Response) => {
  res.json({ items: documents });
});

adminIdoxxyRouter.get("/groups", (_req: Request, res: Response) => {
  res.json({ items: groups });
});

adminIdoxxyRouter.get("/customers", (req: Request, res: Response) => {
  const query = (req.query.query as string | undefined)?.toLowerCase() ?? "";
  const status = (req.query.status as string | undefined) ?? "";
  const page = Number(req.query.page ?? 1);

  const filtered = customers.filter((customer) => {
    const matchesQuery =
      !query ||
      customer.name.toLowerCase().includes(query) ||
      customer.email.toLowerCase().includes(query);
    const matchesStatus = !status || customer.status === status;
    return matchesQuery && matchesStatus;
  });

  const { items, totalPages, currentPage } = paginate(filtered, page, 8);
  const response = items.map((customer) => ({
    ...customer,
    groups: customer.groupIds
      .map((groupId) => groups.find((group) => group.id === groupId)?.name)
      .filter(Boolean),
  }));

  res.json({ items: response, totalPages, currentPage });
});

adminIdoxxyRouter.get("/customers/:id", (req: Request, res: Response) => {
  const customer = customers.find((entry) => entry.id === req.params.id);

  if (!customer) {
    return res.status(404).json({ ok: false, error: "Nie znaleziono klienta" });
  }

  return res.json({
    customer: {
      ...customer,
      groups: customer.groupIds
        .map((groupId) => groups.find((group) => group.id === groupId)?.name)
        .filter(Boolean),
    },
  });
});

adminIdoxxyRouter.put("/customers/:id/groups", requireCsrf, (req: Request, res: Response) => {
  const customer = customers.find((entry) => entry.id === req.params.id);

  if (!customer) {
    return res.status(404).json({ ok: false, error: "Nie znaleziono klienta" });
  }

  const parsed = customerGroupSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  customer.groupIds = parsed.data.groupIds;
  return res.json({ ok: true });
});

adminIdoxxyRouter.post("/customers/bulk", requireCsrf, (req: Request, res: Response) => {
  const parsed = bulkActionSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  const { ids, action, groupId } = parsed.data;
  const selectedCustomers = customers.filter((customer) => ids.includes(customer.id));

  if (!selectedCustomers.length) {
    return res.json({ ok: true, updated: 0 });
  }

  if (action === "assign-group" && groupId) {
    selectedCustomers.forEach((customer) => {
      if (!customer.groupIds.includes(groupId)) {
        customer.groupIds.push(groupId);
      }
    });
  }

  if (action === "remove-group" && groupId) {
    selectedCustomers.forEach((customer) => {
      customer.groupIds = customer.groupIds.filter((id) => id !== groupId);
    });
  }

    if (action === "resend-documents") {
      // Get customer documents from iDoxxy and return unique links
      const customerDocuments = [];
      
      for (const customerId of ids) {
        const customer = customers.find((c) => c.id === customerId);
        if (customer && customer.documents) {
          customerDocuments.push({
            customerId,
            customerEmail: customer.email,
            customerName: customer.name,
            documents: customer.documents.map((docId: string) => {
              const doc = documents.find((d) => d.id === docId);
              return {
                documentId: docId,
                documentName: doc?.name || "Nieznany dokument",
                uniqueLink: doc?.uniqueLink || null,
              };
            }),
          });
        }
      }

      console.log(`[Resend Documents] Prepared documents for ${customerDocuments.length} customers`);
      
      return res.json({ 
        ok: true, 
        updated: ids.length,
        customerDocuments,
        message: "Dokumenty zostały przygotowane do wysłania. W rzeczywistym środowisku iDoxxy wyśle powiadomienia do klientów."
      });
    }

  return res.json({ ok: true, updated: selectedCustomers.length });
});

adminIdoxxyRouter.post("/documents/:documentId/resend-notification", requireCsrf, (req: Request, res: Response) => {
  const { documentId } = req.params;

  if (!documentId) {
    return res.status(400).json({ ok: false, error: "Brak identyfikatora dokumentu" });
  }

  const parsed = resendDocumentSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  return res.json({ ok: true });
});
