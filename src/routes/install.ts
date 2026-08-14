import { Router, type Request, type Response, type NextFunction } from "express";
import axios from "axios";
import { z } from "zod";
import { env } from "../config/env";
import { shopConnectionService } from "../services/shopConnectionService";
import { recentInstallsRepository } from "../repositories/recentInstallsRepository";
import { establishShopSession } from "../middleware/shopSession";
import { verifyAppStoreCallbackSignature } from "../middleware/shoperSignature";
import { appStoreCallbackRateLimiter } from "../middleware/rateLimit";

export const installRouter = Router();

// Endpoint do autoryzacji / instalacji App Store
// Odbiera parametry: shop_url
installRouter.get("/install", (req: Request, res: Response) => {
  const shopUrl = req.query.shop_url as string | undefined;

  if (!shopUrl) {
    return res.status(400).send("Brak parametru shop_url");
  }

  // Wymusza brak scheme by zachować czysty host, dla bezpieczeństwa usuń ew. prefiksy HTTP
  const cleanShopUrl = shopUrl.replace(/^https?:\/\//, "");
  const clientId = env.SHOPER_APP_STORE_CLIENT_ID || env.SHOPER_CLIENT_ID;

  if (!clientId) {
    return res.status(500).send("Brak skonfigurowanego ID aplikacji Shoper");
  }

  const redirectUrl = `https://${cleanShopUrl}/admin/oauth/authorize?client_id=${clientId}&response_type=code`;
  return res.redirect(redirectUrl);
});

// Callback / Wymiana kodu na token
const oauthCallbackSchema = z.object({
  code: z.string(),
  shop_url: z.string(),
});

installRouter.get("/oauth/callback", async (req: Request, res: Response) => {
  try {
    const parsed = oauthCallbackSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).send("Błędne parametry autoryzacji z platformy Shoper");
    }

    const { code, shop_url: shopUrl } = parsed.data;
    const cleanShopUrl = shopUrl.replace(/^https?:\/\//, "");

    const clientId = env.SHOPER_APP_STORE_CLIENT_ID || env.SHOPER_CLIENT_ID;
    const clientSecret = env.SHOPER_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.status(500).send("Brak krytycznej autoryzacji aplikacji");
    }

    // Wymiana Tokenu wg dokumentacji Shoper OAuth 2.0
    const tokenResponse = await axios.post(
      `https://${cleanShopUrl}/webapi/rest/oauth/token`,
      {
        grant_type: "authorization_code",
        code,
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

    const { access_token, refresh_token, token_type } = tokenResponse.data;

    if (!access_token) {
      throw new Error("API Shopera nie zwróciło poprawnego access_token");
    }

    // Ponieważ podczas wczesnej autoryzacji /install nie mamy Shop ID, pobierzemy
    // dane o sklepie, uderzając do /webapi/rest/application-info lub wyciągając z URL
    // Ale w Shoper App Store Shop_url (a także shop.name ew.) bywa jedynym wyróżnikiem
    // do weryfikacji. Na razie używamy ShopURL albo prosimy merchant-a o potwierdzenie
    
    // Próbujemy wywołać by poznać "shopId" jeśli shoper nam go nie da w callbacku
    let shopId = cleanShopUrl.split(".")[0]?.replace(/^devshop-/, "") || cleanShopUrl;
    try {
      const appInfoRes = await axios.get(`https://${cleanShopUrl}/webapi/rest/application-info`, {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      });
      if (appInfoRes.data?.shop_id) {
        shopId = appInfoRes.data.shop_id.toString();
      }
    } catch (appInfoError) {
      console.warn(
        `[OAuth Callback] Could not fetch application-info, using fallback shopId "${shopId}":`,
        (appInfoError as any)?.response?.data || (appInfoError as any)?.message || appInfoError,
      );
    }

    // Reject jeśli ID nam nie wyszło
    if (!shopId) {
      throw new Error("Unresolvable Shop ID on OAuth");
    }

    // Fetch canonical shop URL from application-config (handles custom domains)
    let resolvedShopUrl = `https://${cleanShopUrl}`;
    // technical_url used to be discarded once shop_url was chosen below - it
    // is now also persisted (see shopConnectionService.recordTechnicalUrl, a
    // few lines down, once the connection row exists), so src/app.ts can
    // narrow the CSP frame-ancestors directive once both hosts are known for
    // a shop's session.
    let resolvedTechnicalUrl: string | undefined;
    try {
      const appConfigRes = await axios.get(`https://${cleanShopUrl}/webapi/rest/application-config`, {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      });
      // Shoper returns shop_url and technical_url; prefer shop_url (may be custom domain)
      const configShopUrl = appConfigRes.data?.shop_url || appConfigRes.data?.technical_url;
      if (configShopUrl) {
        resolvedShopUrl = configShopUrl.startsWith("http") ? configShopUrl : `https://${configShopUrl}`;
        console.log(`[OAuth] Resolved shop URL from application-config: ${resolvedShopUrl}`);
      }
      const configTechnicalUrl = appConfigRes.data?.technical_url;
      if (configTechnicalUrl) {
        resolvedTechnicalUrl = configTechnicalUrl.startsWith("http")
          ? configTechnicalUrl
          : `https://${configTechnicalUrl}`;
      }
    } catch (configError) {
      console.warn(`[OAuth] Could not fetch application-config, using fallback URL: ${resolvedShopUrl}`);
    }

    // Rejestracja w bazie Shop Connections
    const connection = shopConnectionService.registerInstallation(shopId, resolvedShopUrl);
    shopConnectionService.saveShoperTokens(shopId, access_token, refresh_token || "");
    if (resolvedTechnicalUrl) {
      shopConnectionService.recordTechnicalUrl(shopId, resolvedTechnicalUrl);
    }
    const shopLicense = (req.query.shop as string | undefined) || undefined;
    if (shopLicense) {
      shopConnectionService.recordShoperLicense(shopId, shopLicense);
    }

    // This IS the trust boundary: shopId only ever lands in the session here,
    // in the install branch of src/routes/settings.ts (GET /settings), or -
    // as a third path - the signature-verified iframe-entry block further
    // down that same GET /settings handler (which itself only fires once a
    // shoper_license mapping recorded from one of these two OAuth exchanges
    // exists). Nothing else may set it. establishShopSession also
    // regenerates the session id first (session fixation defense) - if that
    // fails we must not redirect into what looks like an authenticated area,
    // so let it throw into the outer catch below.
    await establishShopSession(req, shopId);

    // Po pomyślnej autoryzacji przekierowujemy użytkownika z powrotem do naszego UI settingsu.
    // The session now carries the shop id, so no need to leak it via the URL.
    // shop_url is passed on purely so the page can build a working "reauthorize"
    // link if this session later expires while the merchant is still in the tab.
    // It carries no authority - requireShopSession never reads it.
    return res.redirect(`/settings?shop_url=${encodeURIComponent(cleanShopUrl)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sth went wrong";
    console.error("[OAuth Callback] Error:", message);
    return res.status(500).send("Wystąpił błąd autoryzacji: " + message);
  }
});

// Verifies the `hash` field Shoper attaches to App Store lifecycle/billing
// callbacks (see src/middleware/shoperSignature.ts for the confirmed
// algorithm and its source). Shoper requires HTTP 200 on these endpoints no
// matter what, so on a missing/invalid signature this middleware itself
// responds 200 and does NOT call next() - the route handler (and therefore
// any state change: revoke, recentInstallsRepository.addInstall, ...) never
// runs. Nothing about the signature or secret is ever logged, only enough
// context to diagnose (path, shop_url, whether a hash was present at all).
//
// When SHOPER_APPSTORE_SECRET is not configured, verification is skipped -
// this is only reachable outside production (see the fail-fast check in
// src/config/env.ts) and is already logged loudly once at startup there, not
// per-request here.
const verifyAppStoreCallback = (req: Request, res: Response, next: NextFunction) => {
  if (!env.SHOPER_APPSTORE_SECRET) {
    return next();
  }

  const body = req.body as Record<string, unknown> | undefined;
  if (verifyAppStoreCallbackSignature(body, env.SHOPER_APPSTORE_SECRET)) {
    return next();
  }

  console.warn("[AppStore] Rejected callback with missing/invalid signature", {
    path: req.path,
    shopUrl: (body?.shop_url ?? req.query?.shop_url)?.toString(),
    hashPresent: typeof body?.hash === "string" && body.hash.length > 0,
  });

  return res.status(200).send("OK");
};

// App Store Odinstalowanie Aplikacji
// Shoper wymusza obecność /uninstall (metoda POST) by usunąć zasoby
installRouter.post("/uninstall", appStoreCallbackRateLimiter, verifyAppStoreCallback, async (req: Request, res: Response) => {
  try {
    const shopUrl = (req.body?.shop_url || req.query?.shop_url)?.toString();
    const action = req.body?.action;

    if (action === "uninstall" || shopUrl) {
      // Find connections by URL
      const allConns = shopConnectionService.listConnections();
      const shopToRevoke = allConns.find(c =>
        c.shopUrl === shopUrl ||
        c.shopUrl === `https://${shopUrl}` ||
        c.shopUrl?.replace(/^https?:\/\//, "") === shopUrl?.replace(/^https?:\/\//, "")
      );

      if (shopToRevoke) {
        // GDPR (Defect B, stage 1): this callback is signature-verified by
        // verifyAppStoreCallback above, so a shop match here is a genuine
        // uninstall - wipe tokens immediately, not just flip the status (see
        // shopConnectionService.revokeAndWipeTokens). Full row deletion of
        // settings/event_mappings/sync_logs happens later, after the grace
        // period, via src/services/dataRetentionService.ts.
        shopConnectionService.revokeAndWipeTokens(shopToRevoke.shopId, "shoper-app-store");
      }
    }

    // Shoper requires 200 OK regardless of whether we matched or not
    return res.status(200).send("OK");
  } catch (error) {
    console.error("[Uninstall Webhook] Error:", error);
    // Powinien zwracać powiodło się, by nie blokować shopera
    return res.status(200).send("OK-Handled-Err");
  }
});

// App Store Billing Webhook
installRouter.post("/billing/subscription", appStoreCallbackRateLimiter, verifyAppStoreCallback, async (req: Request, res: Response) => {
  // Puste logowanie płatności
  res.status(200).send("OK");
});

// App Store Automatic Messages
installRouter.post("/billing/automatic-messages", appStoreCallbackRateLimiter, verifyAppStoreCallback, async (req: Request, res: Response) => {
  try {
    const { action, shop, shop_url } = req.body;
    if (action === "install" && shop && shop_url) {
      recentInstallsRepository.addInstall({
        shopId: shop.toString(),
        shopUrl: shop_url.toString(),
        timestamp: new Date().toISOString(),
      });
      console.log(`[AppStore] Intercepted install for shop: ${shop} (${shop_url})`);

      // Best-effort shoper_license backfill: this callback only carries
      // `shop` (the App Store license, NOT this app's numeric shopId - see
      // src/middleware/shoperSignature.ts's iframe-entry section) and
      // `shop_url`, no numeric shop_id. Match an existing connection by
      // normalized shop_url (same comparison as /uninstall below) and record
      // the license against it if found; otherwise there's nothing to attach
      // it to yet, and the opportunistic backfill in GET /settings's
      // iframe-entry block will pick it up once the shop has a session.
      const shopUrlStr = shop_url.toString();
      const allConns = shopConnectionService.listConnections();
      const matchedConnection = allConns.find(
        (c) =>
          c.shopUrl === shopUrlStr ||
          c.shopUrl === `https://${shopUrlStr}` ||
          c.shopUrl?.replace(/^https?:\/\//, "") === shopUrlStr.replace(/^https?:\/\//, ""),
      );
      if (matchedConnection) {
        shopConnectionService.recordShoperLicense(matchedConnection.shopId, shop.toString());
      }
    }
  } catch (err) {
    console.error(`[AppStore] Error handling automatic message:`, err);
  }

  // Shoper wymaga zawsze odpowiedzi HTTP 200
  return res.status(200).send("OK");
});
