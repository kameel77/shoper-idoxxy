import path from "node:path";

import axios from "axios";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";

import { resolveShopClient } from "../middleware/resolveShopClient";
import {
  requireShopSession,
  requireCsrf,
  ensureShopIdMatchesSession,
  issueCsrfToken,
  establishShopSession,
} from "../middleware/shopSession";
import { requireApiAuth } from "../middleware/auth";
import { verifyIframeEntrySignature, verifyAppStoreCallbackSignature } from "../middleware/shoperSignature";
import { env } from "../config/env";
import { settingsRepository } from "../repositories/settingsRepository";
import { recentInstallsRepository } from "../repositories/recentInstallsRepository";
import { IdoxxyService } from "../services/idoxxyService";
import { ShoperService } from "../services/shoperService";
import { shopConnectionService } from "../services/shopConnectionService";
import { settingsMutationRateLimiter } from "../middleware/rateLimit";

export const settingsRouter = Router();
const idoxxyService = new IdoxxyService();
const shoperService = new ShoperService();

// Generous rate limit on state-changing /settings/* endpoints (see
// src/middleware/rateLimit.ts for the shared limiter constants/rationale).
// Only applied to mutating methods - GET endpoints (config/groups/documents/
// sync-logs/...) are read-only and unlimited here.
settingsRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === "GET") return next();
  return settingsMutationRateLimiter(req, res, next);
});

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

// shopId is optional here on purpose: the authoritative shop id always comes
// from the verified session (req.shopId, set by requireShopSession). A caller
// may still include it (e.g. an admin operator's tooling), but if present it
// must agree with the session - see ensureShopIdMatchesSession below.
const linkTestSchema = z.object({
  shopId: z.string().optional(),
  shopUrl: z.string().url().optional(),
  token: z.string().optional(),
  baseUrl: z.string().optional(),
});

const linkSaveSchema = z.object({
  shopId: z.string().optional(),
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
      // Same technical_url capture as src/routes/install.ts's GET /oauth/callback
      // - persisted below via shopConnectionService.recordTechnicalUrl once the
      // connection row exists, so src/app.ts can narrow the CSP
      // frame-ancestors directive once both hosts are known for a shop's session.
      let resolvedTechnicalUrl: string | undefined;
      try {
        const appConfigRes = await axios.get(`https://${cleanShopUrl}/webapi/rest/application-config`, {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        const configShopUrl = appConfigRes.data?.shop_url || appConfigRes.data?.technical_url;
        if (configShopUrl) {
          resolvedShopUrl = configShopUrl.startsWith("http") ? configShopUrl : `https://${configShopUrl}`;
        }
        const configTechnicalUrl = appConfigRes.data?.technical_url;
        if (configTechnicalUrl) {
          resolvedTechnicalUrl = configTechnicalUrl.startsWith("http")
            ? configTechnicalUrl
            : `https://${configTechnicalUrl}`;
        }
      } catch {
        // Fallback to URL from params
      }

      // Save connection
      shopConnectionService.registerInstallation(shopId, resolvedShopUrl);
      shopConnectionService.saveShoperTokens(shopId, access_token, refresh_token || "");
      if (resolvedTechnicalUrl) {
        shopConnectionService.recordTechnicalUrl(shopId, resolvedTechnicalUrl);
      }

      // shopLicense (the `shop` query param) is Shoper's App Store identifier
      // for this shop - a distinct value from shopId (see
      // src/middleware/shoperSignature.ts's iframe-entry section). We have a
      // proven shop identity right here (post OAuth-exchange), so this is a
      // safe place to record the mapping for the signature-verified iframe
      // entry path below to use on future visits.
      if (shopLicense) {
        shopConnectionService.recordShoperLicense(shopId, shopLicense);
      }

      // This IS the trust boundary: shopId only ever lands in the session
      // here, in install.ts's GET /oauth/callback, and in the
      // signature-verified iframe-entry block below (GET /settings, once a
      // shoper_license mapping exists) - all three run only after a proven
      // Shoper identity for that shop. establishShopSession also regenerates
      // the session id first (session fixation defense) - if that fails we
      // must not redirect into what looks like an authenticated area, so let
      // it throw into the catch below instead of falling through to the
      // redirect.
      await establishShopSession(req, shopId);

      console.log(`[Settings Install] Shop ${shopId} installed (URL: ${resolvedShopUrl})`);

      // Redirect to the clean settings URL - the session now carries the
      // shop id, so the frontend no longer needs it in the query string.
      // shop_url is passed on purely so the page can build a working
      // "reauthorize" link if this session later expires while the merchant is
      // still in the tab. It carries no authority - requireShopSession never
      // reads it.
      return res.redirect(`/settings?shop_url=${encodeURIComponent(cleanShopUrl)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Install error";
      const responseData = (error as any)?.response?.data;
      const responseStatus = (error as any)?.response?.status;
      console.error(`[Settings Install] OAuth exchange failed (${responseStatus}):`, message, responseData || "");
      // Fall through to serve the page normally
    }
  }

  // Handle Shoper App Store uninstall action. This branch used to revoke a
  // shop's connection on a bare, unauthenticated GET - the same class of hole
  // that verifyAppStoreCallback (see src/routes/install.ts) already closed on
  // POST /uninstall. It is fixed the same way here: verify Shoper's `hash`
  // App Store callback signature (src/middleware/shoperSignature.ts) over the
  // *query* params before making any state change. verifyAppStoreCallbackSignature
  // takes a plain Record<string, unknown> - req.query already satisfies that
  // (same cast used by verifyIframeEntrySignature below), and the hash
  // exclusion / sorted-params HMAC-SHA512 construction is identical whether
  // the params arrive as a POST body or a GET query string.
  //
  // On a missing/invalid signature: no state change, warn in the same style
  // as install.ts's verifyAppStoreCallback (path, shop_url, whether a hash
  // was present - never the signature or secret), then fall through to
  // serving the settings page exactly as before - this branch must never
  // widen the trust boundary on a partial/ambiguous result.
  //
  // Skipped entirely (no verification attempt, no state change) when
  // SHOPER_APPSTORE_SECRET is unset - unreachable in production due to the
  // fail-fast check in src/config/env.ts.
  if (action === "uninstall" && shopUrlParam) {
    if (env.SHOPER_APPSTORE_SECRET) {
      if (verifyAppStoreCallbackSignature(req.query as Record<string, unknown>, env.SHOPER_APPSTORE_SECRET)) {
        const cleanShopUrl = shopUrlParam.replace(/^https?:\/\//, "");
        const allConns = shopConnectionService.listConnections();
        const shopToRevoke = allConns.find((c) => {
          if (!c.shopUrl) return false;
          const connHost = c.shopUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
          return connHost === cleanShopUrl;
        });
        if (shopToRevoke) {
          // Same GDPR semantics as the verified POST /uninstall handler in
          // src/routes/install.ts: wipe tokens immediately on a genuine,
          // signature-verified uninstall rather than just flipping status.
          shopConnectionService.revokeAndWipeTokens(shopToRevoke.shopId, "shoper-app-store");
          console.log(`[Settings Uninstall] Revoked shop ${shopToRevoke.shopId}`);
        }
      } else {
        const hashValue = req.query.hash;
        console.warn("[Settings Uninstall] Rejected uninstall action with missing/invalid signature", {
          path: req.path,
          shopUrl: shopUrlParam,
          hashPresent: typeof hashValue === "string" && hashValue.length > 0,
        });
      }
    }
    // Fall through to serve settings page
  }

  // Third trusted way to establish a shop session: Shoper's documented
  // signed iframe entry (developers.shoper.pl/docs, "Shop Panel Integration
  // -> Iframe Security - Hash Verification"). When a shop admin opens this
  // app from the Shoper panel, Shoper appends admin-hash/hash-signed query
  // params (application, shop, timestamp, place, admin-id, admin-name,
  // hash, admin-hash) to this exact URL. Unlike the OAuth branches above,
  // this never performs an authorization_code exchange - it trusts Shoper's
  // HMAC signature instead, over params we already possess a proven
  // shopId<->license mapping for (recorded during a prior OAuth install).
  //
  // This does NOT widen the trust boundary: an invalid/absent signature, or
  // a valid signature whose `shop` license has no recorded mapping (shop
  // installed before this feature existed), leaves the caller exactly as
  // unauthenticated as before - execution just falls through to serving the
  // static shell below, and the frontend's existing reauthorize flow (see
  // public/settings.html) takes over as it always did.
  //
  // Skipped entirely when SHOPER_APPSTORE_SECRET is unset - unreachable in
  // production due to the fail-fast check in src/config/env.ts.
  if (env.SHOPER_APPSTORE_SECRET) {
    const verification = verifyIframeEntrySignature(req.query as Record<string, unknown>, env.SHOPER_APPSTORE_SECRET);
    if (verification.valid) {
      if (!req.session?.shopId) {
        const resolvedShopId = shopConnectionService.getShopIdByLicense(verification.shop);
        if (resolvedShopId) {
          try {
            await establishShopSession(req, resolvedShopId);
            console.log("[ShopSession] iframe entry verified", {
              shopId: resolvedShopId,
              "admin-id": verification.adminId,
              "admin-name": verification.adminName,
            });
          } catch (error) {
            // Session establishment failed (e.g. store error) - do not throw
            // into a 500; just fall through to serving the page unauthenticated,
            // same as any other failed session attempt.
            console.error("[ShopSession] Failed to establish session from verified iframe entry", error);
          }
        }
        // No mapping found for this license yet: fall through to current
        // behavior so the merchant still gets the reauthorize path.
      } else {
        // A session already exists (e.g. from the install branch above, or a
        // pre-existing cookie) - opportunistically backfill the license
        // mapping for shops that installed before this feature existed.
        shopConnectionService.recordShoperLicense(req.session.shopId, verification.shop);
      }
    }
  }

  // Deliberately no "auto-resolve shopId from shop_url and redirect" step
  // here anymore: that used an unauthenticated list of every shop's
  // connection to answer a caller-supplied shop_url, and fed the result back
  // into the page via a query param the frontend then trusted. The frontend
  // no longer needs a shopId at all - it relies solely on the session shop id
  // established during OAuth or the verified iframe entry above.
  res.sendFile(path.join(process.cwd(), "public/settings.html"));
});

settingsRouter.get("/ui", (_req: Request, res: Response) => {
  res.redirect(301, "/settings");
});

// Double-submit CSRF token for the current shop session. Requires a shop
// session itself so an attacker can't mint a token for a victim's session.
settingsRouter.get("/csrf", requireShopSession, (req: Request, res: Response) => {
  try {
    return res.json({ ok: true, csrfToken: issueCsrfToken(req) });
  } catch {
    return res.status(500).json({ ok: false, error: "Sesja niedostępna." });
  }
});

settingsRouter.get("/test-connection", requireShopSession, async (req: Request, res: Response) => {
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

// Operator-only: not scoped to any shop, checks the platform's own Shoper API
// credentials rather than a tenant's.
settingsRouter.get("/test-shoper", requireApiAuth, async (_req: Request, res: Response) => {
  try {
    const result = await shoperService.healthCheck();
    res.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Nieznany błąd integracji Shoper";
    res.status(500).json({ ok: false, error: message });
  }
});

settingsRouter.get("/config", requireShopSession, (req: Request, res: Response) => {
  res.json(settingsRepository.getSnapshot(req.shopId!));
});

settingsRouter.get("/groups", requireShopSession, async (req: Request, res: Response) => {
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

settingsRouter.get("/documents", requireShopSession, async (req: Request, res: Response) => {
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

settingsRouter.put("/credentials", requireShopSession, requireCsrf, (req: Request, res: Response) => {
  const shopId = req.shopId!;

  const parsed = credentialsSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  settingsRepository.updateApiKeys(shopId, {
    baseUrl: parsed.data.baseUrl,
    apiKey: parsed.data.apiKey,
    shoperApiKey: undefined,
    idoxxyApiKey: undefined,
  });
  settingsRepository.updateLastSettingsModified(shopId);
  return res.json({ ok: true });
});

settingsRouter.put("/default-groups", requireShopSession, requireCsrf, (req: Request, res: Response) => {
  const shopId = req.shopId!;

  const parsed = defaultGroupsSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  settingsRepository.updateFallbackGroups(shopId, parsed.data);
  settingsRepository.updateLastSettingsModified(shopId);
  return res.json({ ok: true });
});

settingsRouter.put("/path-mappings", requireShopSession, requireCsrf, (req: Request, res: Response) => {
  const shopId = req.shopId!;

  const parsed = pathMappingsSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  settingsRepository.updatePathMappings(shopId, parsed.data);
  return res.json({ ok: true });
});

settingsRouter.post("/mappings", requireShopSession, requireCsrf, (req: Request, res: Response) => {
  const shopId = req.shopId!;

  const parsed = eventMappingSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  try {
    const mapping = settingsRepository.upsertMapping(shopId, parsed.data as any);
    settingsRepository.updateLastSettingsModified(shopId);
    return res.json({ ok: true, mapping });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Nie udało się zapisać mapowania.";
    return res.status(400).json({ ok: false, error: message });
  }
});

settingsRouter.delete("/mappings/:id", requireShopSession, requireCsrf, (req: Request, res: Response) => {
  const shopId = req.shopId!;

  const id = firstParam(req.params.id);

  if (!id) {
    return res.status(400).json({ ok: false, error: "Missing mapping ID" });
  }

  const removed = settingsRepository.removeMapping(shopId, id);
  if (!removed) {
    return res.status(404).json({ ok: false, error: "Nie znaleziono mapowania dla tego sklepu." });
  }
  return res.json({ ok: true });
});

settingsRouter.get("/link/status/:shopId", requireShopSession, (req: Request, res: Response) => {
  const shopId = firstParam(req.params.shopId);

  if (!ensureShopIdMatchesSession(req, res, shopId)) return;

  const connection = shopConnectionService.getConnection(req.shopId!);
  if (!connection) {
    return res.status(404).json({ ok: false, error: "Połączenie dla sklepu nie istnieje" });
  }

  return res.json({ ok: true, connection: sanitizeConnection(connection) });
});

// Operator-only: lists every tenant's connection, so it must never be
// reachable with just a shop session.
settingsRouter.get("/link/connections", requireApiAuth, (_req: Request, res: Response) => {
  const items = shopConnectionService.listConnections().map(sanitizeConnection);
  return res.json({ ok: true, items });
});

settingsRouter.post("/link/test", requireShopSession, requireCsrf, async (req: Request, res: Response) => {
  const parsed = linkTestSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  if (!ensureShopIdMatchesSession(req, res, parsed.data.shopId)) return;

  const shopId = req.shopId!;
  const { shopUrl, token, baseUrl } = parsed.data;
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
    const status = (error as any)?.response?.status;
    console.error("[Settings Link] Token test failed", { shopId, status });
    return res.status(status === 401 || status === 403 ? 401 : 500).json({
      ok: false,
      error:
        status === 401 || status === 403
          ? "Token iDoxxy jest nieprawidłowy lub nie ma dostępu do wybranego workspace’a."
          : "Nie udało się zweryfikować połączenia z iDoxxy. Spróbuj ponownie lub skontaktuj się z pomocą techniczną.",
    });
  }
});

settingsRouter.post("/link", requireShopSession, requireCsrf, async (req: Request, res: Response) => {
  const parsed = linkSaveSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues });
  }

  if (!ensureShopIdMatchesSession(req, res, parsed.data.shopId)) return;

  const shopId = req.shopId!;
  const { shopUrl, token, baseUrl, workspaceId } = parsed.data;

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
    const status = (error as any)?.response?.status;
    console.error("[Settings Link] Store connection failed", { shopId, status });
    return res.status(status === 401 || status === 403 ? 401 : 500).json({
      ok: false,
      error:
        status === 401 || status === 403
          ? "Token iDoxxy jest nieprawidłowy lub nie ma dostępu do wybranego workspace’a."
          : "Nie udało się połączyć sklepu z iDoxxy. Spróbuj ponownie lub skontaktuj się z pomocą techniczną.",
    });
  }
});

settingsRouter.delete("/link/:shopId", requireShopSession, requireCsrf, (req: Request, res: Response) => {
  const shopId = firstParam(req.params.shopId);

  if (!ensureShopIdMatchesSession(req, res, shopId)) return;

  const deleted = shopConnectionService.deleteConnection(req.shopId!);
  if (!deleted) {
    return res.status(404).json({ ok: false, error: "Połączenie dla sklepu nie istnieje" });
  }

  return res.json({ ok: true });
});

settingsRouter.get("/sync-logs", requireShopSession, (req: Request, res: Response) => {
  const logs = settingsRepository.getSyncLogs(req.shopId!);
  res.json({ items: logs });
});

settingsRouter.get("/sync-stats", requireShopSession, (req: Request, res: Response) => {
  const stats = settingsRepository.getSyncStats(req.shopId!);
  res.json(stats);
});

// Operator-only: recent App Store install pings aren't scoped to a caller's
// shop - they're the platform's own install feed.
settingsRouter.get("/recent-installs", requireApiAuth, (_req: Request, res: Response) => {
  const items = recentInstallsRepository.getRecentInstalls();
  res.json({ ok: true, items });
});

settingsRouter.delete("/recent-installs/:shopId", requireApiAuth, (req: Request, res: Response) => {
  const shopId = firstParam(req.params.shopId);
  if (!shopId) {
    return res.status(400).json({ ok: false, error: "Brak identyfikatora sklepu" });
  }
  recentInstallsRepository.removeInstall(shopId);
  res.json({ ok: true });
});
