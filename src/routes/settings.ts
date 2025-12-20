import path from "node:path";

import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { settingsRepository } from "../repositories/settingsRepository";
import { IdoxxyService } from "../services/idoxxyService";
import { ShoperService } from "../services/shoperService";

export const settingsRouter = Router();
const idoxxyService = new IdoxxyService();
const shoperService = new ShoperService();

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

settingsRouter.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), "public/settings.html"));
});

settingsRouter.get("/ui", (_req: Request, res: Response) => {
  res.redirect(301, "/settings");
});

settingsRouter.get("/test-connection", async (_req: Request, res: Response) => {
  try {
    const result = await idoxxyService.healthCheck();
    res.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Nieznany błąd integracji";
    res.status(500).json({ ok: false, error: message });
  }
});

settingsRouter.get("/test-shoper", async (_req: Request, res: Response) => {
  try {
    const result = await shoperService.healthCheck();
    res.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Nieznany błąd integracji Shoper";
    res.status(500).json({ ok: false, error: message });
  }
});

settingsRouter.get("/config", (_req: Request, res: Response) => {
  res.json(settingsRepository.getSnapshot());
});

settingsRouter.put("/credentials", (req: Request, res: Response) => {
  const parsed = credentialsSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  settingsRepository.saveCredentials(parsed.data);
  return res.json({ ok: true });
});

settingsRouter.put("/default-groups", (req: Request, res: Response) => {
  const parsed = defaultGroupsSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  settingsRepository.updateDefaultGroups(parsed.data);
  return res.json({ ok: true });
});

settingsRouter.post("/mappings", (req: Request, res: Response) => {
  const parsed = mappingSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  const { id, documentId, ...rest } = parsed.data;
  const mapping = settingsRepository.upsertMapping({
    ...rest,
    ...(documentId ? { documentId } : {}),
    ...(id ? { id } : {}),
  });
  return res.json({ ok: true, mapping });
});

settingsRouter.delete("/mappings/:id", (req: Request, res: Response) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ ok: false, error: "Brak identyfikatora mapowania" });
  }

  settingsRepository.removeMapping(id);
  return res.json({ ok: true });
});
