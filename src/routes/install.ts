import { Router, type Request, type Response } from "express";
import axios from "axios";
import { z } from "zod";
import { env } from "../config/env";
import { shopConnectionService } from "../services/shopConnectionService";

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
    const appInfoRes = await axios.get(`https://${cleanShopUrl}/webapi/rest/application-info`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    const shopId = appInfoRes.data?.shop_id?.toString() || cleanShopUrl;

    // Reject jeśli ID nam nie wyszło
    if(!shopId) {
      throw new Error("Unresolvable Shop ID on OAuth");
    }

    // Rejestracja w bazie Shop Connections
    const connection = shopConnectionService.registerInstallation(shopId, `https://${cleanShopUrl}`);
    shopConnectionService.saveShoperTokens(shopId, access_token, refresh_token || "");

    // Po pomyślnej autoryzacji przekierowujemy użytkownika z powrotem do naszego UI settingsu
    return res.redirect(`/settings?shopId=${shopId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sth went wrong";
    console.error("[OAuth Callback] Error:", message);
    return res.status(500).send("Wystąpił błąd autoryzacji: " + message);
  }
});

// App Store Odinstalowanie Aplikacji
// Shoper wymusza obecność /uninstall (metoda POST) by usunąć zasoby
installRouter.post("/uninstall", async (req: Request, res: Response) => {
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
        shopConnectionService.revoke(shopToRevoke.shopId, "shoper-app-store");
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
installRouter.post("/billing/subscription", async (req: Request, res: Response) => {
  // Puste logowanie płatności
  res.status(200).send("OK");
});
