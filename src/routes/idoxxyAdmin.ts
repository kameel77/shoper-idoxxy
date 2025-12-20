import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { settingsRepository } from "../repositories/settingsRepository";
import { IdoxxyService } from "../services/idoxxyService";
import type { SettingsSnapshot } from "../types/settings";

export const idoxxyAdminRouter = Router();
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

const bulkAddGroupSchema = z.object({
  groupId: z.string().uuid(),
  customerIds: z.array(z.string().uuid()).min(1),
});

idoxxyAdminRouter.get("/settings", (_req: Request, res: Response) => {
  res.json(settingsRepository.getSnapshot());
});

idoxxyAdminRouter.put("/settings", (req: Request, res: Response) => {
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
  };

  settingsRepository.updateSettings(payload);
  return res.json({ ok: true });
});

idoxxyAdminRouter.get("/groups", async (_req: Request, res: Response) => {
  try {
    const groups = await idoxxyService.listGroups();
    return res.json(groups);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Nieznany błąd integracji";
    return res.status(500).json({ ok: false, error: message });
  }
});

idoxxyAdminRouter.get("/customers", async (req: Request, res: Response) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search : "";
    const customers = await idoxxyService.listCustomers(search);
    return res.json(customers);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Nieznany błąd integracji";
    return res.status(500).json({ ok: false, error: message });
  }
});

idoxxyAdminRouter.get(
  "/customers/:id/groups",
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params as { id: string };
      const groups = await idoxxyService.getCustomerGroups(id);
      if (!groups) {
        return res
          .status(404)
          .json({ ok: false, error: "Nie znaleziono klienta" });
      }

      return res.json({ ok: true, groups });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Nieznany błąd integracji";
      return res.status(500).json({ ok: false, error: message });
    }
  },
);

idoxxyAdminRouter.put(
  "/customers/:id/groups",
  async (req: Request, res: Response) => {
    const parsed = customerGroupsSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ ok: false, errors: parsed.error.issues });
    }

    try {
      const { id } = req.params as { id: string };
      await idoxxyService.assignCustomerToGroups(id, parsed.data.groupIds);
      return res.json({ ok: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Nieznany błąd integracji";
      return res.status(500).json({ ok: false, error: message });
    }
  },
);

idoxxyAdminRouter.post(
  "/customers/bulk-add-group",
  async (req: Request, res: Response) => {
    const parsed = bulkAddGroupSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ ok: false, errors: parsed.error.issues });
    }

    try {
      await idoxxyService.addCustomersToGroup(
        parsed.data.groupId,
        parsed.data.customerIds,
      );
      return res.json({ ok: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Nieznany błąd integracji";
      return res.status(500).json({ ok: false, error: message });
    }
  },
);
