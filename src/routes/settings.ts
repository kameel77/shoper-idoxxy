import path from "node:path";

import axios from "axios";
import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { resolveShopClient } from "../middleware/resolveShopClient";
import { env } from "../config/env";
import { settingsRepository } from "../repositories/settingsRepository";
import { recentInstallsRepository } from "../repositories/recentInstallsRepository";
import { IdoxxyService } from "../services/idoxxyService";
import { ShoperService } from "../services/shoperService";
import { shopConnectionService } from "../services/shopConnectionService";

export const settingsRouter = Router();
const idoxxyService = new IdoxxyService();
const shoperService = new ShoperService();

const firstParam = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const credentialsSchema = z.object({
  baseUrl: z.string().url().default("https://api.idoxxy.com"),
  apiKey: z.string().optional(),
});

const defaultGroupsSchema = z.object({
  fallbackRegistrationGroupIds: z.array(z.string().uuid()).default([]),
  fallbackOrderGroupIds: z.array(z.string().uuid()).default([]),
  registration: z.array(z.string().uuid()).default([]),
  order: z.array(z.string().uuid()).default([]),
}).transform((data) => ({
  fallbackRegistrationGroupIds: data.fallbackRegistrationGroupIds.length > 0 
    ? data.fallbackRegistrationGroupIds 
    : data.registration,
  fallbackOrderGroupIds: data.fallbackOrderGroupIds.length > 0 
    ? data.fallbackOrderGroupIds 
    : data.order,
}));

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

const linkTestSchema = z.object({
  shopId: z.string(),
  shopUrl: z.string().url().optional(),
  token: z.string().optional(),
  baseUrl: z.string().optional(),
});

const linkSaveSchema = z.object({
  shopId: z.string(),
  shopUrl: z.string().optional(),
  token: z.string().optional(),
  baseUrl: z.string().optional(),
  workspaceId: z.string().optional(),
});

const sanitizeConnection = (connection: any) => {
  if (!connection) return null;
  const { idoxxyTokenEncrypted, ...rest } = connection;
  return rest;
};

settingsRouter.get("/", async (req: Request, res: Response) => {
  const action = req.query.action as string | undefined;
  const shopUrlParam = req.query.shop_url as string | undefined;
  const authCode = req.query.auth_code as string | undefined;
  const shopLicense = req.query.shop as string | undefined;

  // Handle Shoper App Store install action
  if (action === "install" && authCode && shopUrlParam) {
    try {
      const cleanShopUrl = shopUrlParam.replace(/^https?:\/\//, "");
      const clientId = env.SHOPER_APP_STORE_CLIENT_ID || env.SHOPER_CLIENT_ID;
      const clientSecret = env.SHOPER_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        console.error("[Settings Install] Missing Shoper credentials");
        return res.sendFile(path.join(process.cwd(), "public/settings.html"));
      }

      console.log(`[Settings Install] Exchanging auth_code for ${cleanShopUrl} with clientId=${clientId.substring(0, 8)}...`);

      // Exchange auth_code for OAuth tokens (same as install.ts)
      const tokenResponse = await axios.post(
        `https://${cleanShopUrl}/webapi/rest/oauth/token`,
        {
          grant_type: "authorization_code",
          code: authCode,
        },
        {
          auth: {
            username: clientId,
            password: clientSecret,
          },
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      const { access_token, refresh_token } = tokenResponse.data;
      if (!access_token) {
        throw new Error("Shoper API did not return access_token");
      }

      // Get shop ID from application-info
      const appInfoRes = await axios.get(`https://${cleanShopUrl}/webapi/rest/application-info`, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const shopId = appInfoRes.data?.shop_id?.toString() || cleanShopUrl;

      // Get canonical shop URL from application-config
      let resolvedShopUrl = `https://${cleanShopUrl}`;
      try {
        const appConfigRes = await axios.get(`https://${cleanShopUrl}/webapi/rest/application-config`, {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        const configShopUrl = appConfigRes.data?.shop_url || appConfigRes.data?.technical_url;
        if (configShopUrl) {
          resolvedShopUrl = configShopUrl.startsWith("http") ? configShopUrl : `https://${configShopUrl}`;
        }
      } catch {
        // Fallback to URL from params
      }

      // Save connection
      shopConnectionService.registerInstallation(shopId, resolvedShopUrl);
      shopConnectionService.saveShoperTokens(shopId, access_token, refresh_token || "");

      console.log(`[Settings Install] Shop ${shopId} installed (URL: ${resolvedShopUrl})`);

      // Redirect to clean settings URL with shopId
      return res.redirect(`/settings?shopId=${shopId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Install error";
      const responseData = (error as any)?.response?.data;
      const responseStatus = (error as any)?.response?.status;
      console.error(`[Settings Install] OAuth exchange failed (${responseStatus}):`, message, responseData || "");
      // Fall through to serve the page normally
    }
  }

  // Handle Shoper App Store uninstall action
  if (action === "uninstall" && shopUrlParam) {
    const cleanShopUrl = shopUrlParam.replace(/^https?:\/\//, "");
    const allConns = shopConnectionService.listConnections();
    const shopToRevoke = allConns.find((c) => {
      if (!c.shopUrl) return false;
      const connHost = c.shopUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      return connHost === cleanShopUrl;
    });
    if (shopToRevoke) {
      shopConnectionService.revoke(shopToRevoke.shopId, "shoper-app-store");
      console.log(`[Settings Uninstall] Revoked shop ${shopToRevoke.shopId}`);
    }
    // Fall through to serve settings page
  }

  // For normal admin views: try to auto-resolve shopId from URL params
  // Shoper admin passes shop=<license_hash> and sometimes shop_url 
  if (!req.query.shopId && shopUrlParam) {
    const cleanShopUrl = shopUrlParam.replace(/^https?:\/\//, "");
    const allConns = shopConnectionService.listConnections();
    const matched = allConns.find((c) => {
      if (!c.shopUrl) return false;
      const connHost = c.shopUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      return connHost === cleanShopUrl;
    });
    if (matched) {
      // Redirect with shopId for the frontend JS
      const params = new URLSearchParams(req.query as Record<string, string>);
      params.set("shopId", matched.shopId);
      return res.redirect(`/settings?${params.toString()}`);
    }
  }

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

settingsRouter.get("/groups", async (req: Request, res: Response) => {
  try {
    const client = resolveShopClient(req);
    const result = await client.listGroups();
    const groups = result.content.map((group: { id: string; groupName: string }) => ({
      id: group.id,
      name: group.groupName,
    }));
    res.json({ items: groups });
  } catch (error) {
    const statusCode = (error as any)?.statusCode;
    const message =
      error instanceof Error ? error.message : "Nie udało się pobrać grup";
    res.status(statusCode || 500).json({ ok: false, error: message, items: [] });
  }
});

settingsRouter.get("/documents", async (req: Request, res: Response) => {
  try {
    const client = resolveShopClient(req);
    const result = await client.listDocuments();
    const documents = (result.content || []).map((doc: { id: string; documentName: string }) => ({
      id: doc.id,
      name: doc.documentName,
    }));
    res.json({ items: documents });
  } catch (error) {
    const statusCode = (error as any)?.statusCode;
    const message =
      error instanceof Error ? error.message : "Nie udało się pobrać dokumentów";
    res.status(statusCode || 500).json({ ok: false, error: message, items: [] });
  }
});

settingsRouter.put("/credentials", (req: Request, res: Response) => {
  const parsed = credentialsSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  settingsRepository.updateApiKeys({
    baseUrl: parsed.data.baseUrl,
    apiKey: parsed.data.apiKey,
    shoperApiKey: undefined,
    idoxxyApiKey: undefined,
  });
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
  const id = firstParam(req.params.id);

  if (!id) {
    return res.status(400).json({ ok: false, error: "Missing mapping ID" });
  }

  settingsRepository.removeMapping(id);
  settingsRepository.updateLastSettingsModified();
  return res.json({ ok: true });
});

settingsRouter.get("/link/status/:shopId", (req: Request, res: Response) => {
  const shopId = firstParam(req.params.shopId);

  if (!shopId) {
    return res.status(400).json({ ok: false, error: "Brak identyfikatora sklepu" });
  }

  const connection = shopConnectionService.getConnection(shopId);
  if (!connection) {
    return res.status(404).json({ ok: false, error: "Połączenie dla sklepu nie istnieje" });
  }

  return res.json({ ok: true, connection: sanitizeConnection(connection) });
});

settingsRouter.get("/link/connections", (_req: Request, res: Response) => {
  const items = shopConnectionService.listConnections().map(sanitizeConnection);
  return res.json({ ok: true, items });
});

settingsRouter.post("/link/test", async (req: Request, res: Response) => {
  const parsed = linkTestSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  const { shopId, shopUrl, token, baseUrl } = parsed.data;
  shopConnectionService.registerInstallation(shopId, shopUrl);

  const actualToken = token || shopConnectionService.getToken(shopId);

  if (!actualToken) {
    return res.status(400).json({ ok: false, error: "Brak zdefiniowanego tokenu. Wprowadź go w formularzu." });
  }

  try {
    const result = await idoxxyService.testToken(actualToken, baseUrl);
    shopConnectionService.markVerified(shopId);
    return res.json({ ok: true, me: result.payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nieznany błąd integracji";
    const status = (error as any)?.response?.status;
    return res.status(status === 401 || status === 403 ? 401 : 500).json({
      ok: false,
      error: message,
    });
  }
});

settingsRouter.post("/link", async (req: Request, res: Response) => {
  const parsed = linkSaveSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  const { shopId, shopUrl, token, baseUrl, workspaceId } = parsed.data;

  shopConnectionService.registerInstallation(shopId, shopUrl);

  const actualToken = token || shopConnectionService.getToken(shopId);

  if (!actualToken) {
    return res.status(400).json({ ok: false, error: "Brak zdefiniowanego tokenu. Wprowadź go w formularzu." });
  }

  try {
    const result = await idoxxyService.testToken(actualToken, baseUrl);

    const connection = shopConnectionService.saveLink({
      shopId,
      shopUrl: shopUrl || undefined,
      idoxxyBaseUrl: baseUrl || undefined,
      idoxxyWorkspaceId: workspaceId || undefined,
      token: actualToken,
      status: "linked",
      tokenLastVerifiedAt: Date.now(),
    });

    return res.json({
      ok: true,
      connection: sanitizeConnection(connection),
      me: result.payload,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nieznany błąd integracji";
    const status = (error as any)?.response?.status;
    return res.status(status === 401 || status === 403 ? 401 : 500).json({
      ok: false,
      error: message,
    });
  }
});

settingsRouter.delete("/link/:shopId", (req: Request, res: Response) => {
  const shopId = firstParam(req.params.shopId);

  if (!shopId) {
    return res.status(400).json({ ok: false, error: "Brak identyfikatora sklepu" });
  }

  const deleted = shopConnectionService.deleteConnection(shopId);
  if (!deleted) {
    return res.status(404).json({ ok: false, error: "Połączenie dla sklepu nie istnieje" });
  }

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

settingsRouter.get("/recent-installs", (_req: Request, res: Response) => {
  const items = recentInstallsRepository.getRecentInstalls();
  res.json({ ok: true, items });
});

settingsRouter.delete("/recent-installs/:shopId", (req: Request, res: Response) => {
  const shopId = firstParam(req.params.shopId);
  if (!shopId) {
    return res.status(400).json({ ok: false, error: "Brak identyfikatora sklepu" });
  }
  recentInstallsRepository.removeInstall(shopId);
  res.json({ ok: true });
});
