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
  apiKey: z.string().min(1).optional(),
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

  settingsRepository.updateApiKeys(parsed.data);
  return res.json({ ok: true });
});

settingsRouter.put("/default-groups", (req: Request, res: Response) => {
  const parsed = defaultGroupsSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  settingsRepository.updateFallbackGroups(parsed.data);
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
