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
  baseUrl: z.string().url().default("https://api.idoxxy.com"),
  apiKey: z.string().optional(),
});

const defaultGroupsSchema = z.object({
  fallbackRegistrationGroupIds: z.array(z.string().uuid()).default([]),
  fallbackOrderGroupIds: z.array(z.string().uuid()).default([]),
});

const pathMappingSchema = z.object({
  pathKey: z.string().min(1),
  groupIds: z.array(z.string().uuid()).default([]),
});

const pathMappingsSchema = z.array(pathMappingSchema).default([]);

const eventMappingSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  event: z.enum(["customer.created", "order.created", "newsletter", "abandoned_cart"]),
  priority: z.number().int().min(0).default(0),
  targetGroupIds: z.array(z.string()).default([]),
  documentId: z.string().optional(),
  enabled: z.boolean().default(true),
  conditions: z.array(z.object({})).default([]),
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

settingsRouter.get("/groups", async (_req: Request, res: Response) => {
  try {
    const result = await idoxxyService.listGroups();
    const groups = result.content.map((group: { id: string; groupName: string }) => ({
      id: group.id,
      name: group.groupName,
    }));
    res.json({ items: groups });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Nie udało się pobrać grup";
    res.status(500).json({ ok: false, error: message, items: [] });
  }
});

settingsRouter.get("/documents", async (_req: Request, res: Response) => {
  // Documents feature not yet implemented - return empty array
  res.json({ items: [] });
});

settingsRouter.put("/credentials", (req: Request, res: Response) => {
  const parsed = credentialsSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  settingsRepository.updateApiKeys(parsed.data);
  settingsRepository.updateLastSettingsModified();
  return res.json({ ok: true });
});

settingsRouter.put("/default-groups", (req: Request, res: Response) => {
  const parsed = defaultGroupsSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  settingsRepository.updateFallbackGroups(parsed.data);
  settingsRepository.updateLastSettingsModified();
  return res.json({ ok: true });
});

settingsRouter.put("/path-mappings", (req: Request, res: Response) => {
  const parsed = pathMappingsSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  settingsRepository.updatePathMappings(parsed.data);
  return res.json({ ok: true });
});

settingsRouter.post("/mappings", (req: Request, res: Response) => {
  const parsed = eventMappingSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  const mapping = settingsRepository.upsertMapping(parsed.data as any);
  settingsRepository.updateLastSettingsModified();
  return res.json({ ok: true, mapping });
});

settingsRouter.delete("/mappings/:id", (req: Request, res: Response) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ ok: false, error: "Missing mapping ID" });
  }

  settingsRepository.removeMapping(id);
  settingsRepository.updateLastSettingsModified();
  return res.json({ ok: true });
});

settingsRouter.get("/sync-logs", (_req: Request, res: Response) => {
  const logs = settingsRepository.getSyncLogs();
  res.json({ items: logs });
});

settingsRouter.get("/sync-stats", (_req: Request, res: Response) => {
  const stats = settingsRepository.getSyncStats();
  res.json(stats);
});
