import type { Request } from "express";

import { IdoxxyClient } from "../clients/idoxxyClient";
import { IdoxxyService } from "../services/idoxxyService";

const idoxxyService = new IdoxxyService();

/**
 * Resolve an IdoxxyClient for the current request.
 *
 * Requires req.shopId (set by requireShopSession, see
 * src/middleware/shopSession.ts, mounted on every router that reaches this
 * function). There is
 * deliberately no "guess the shop" fallback: previously this fell back to the
 * first connection with status "linked", which meant a request with no shop
 * context could silently operate on a different tenant's iDoxxy workspace.
 *
 * Throws HTTP-friendly error (statusCode 428) if no shop id is present on the
 * request.
 */
export function resolveShopClient(req: Request): IdoxxyClient {
  const shopId = req.shopId;

  if (shopId) {
    return idoxxyService.getClientForShop(shopId);
  }

  const error = new Error(
    "Brak połączonego sklepu z iDoxxy. Przejdź do panelu ustawień i połącz sklep.",
  );
  (error as any).statusCode = 428;
  throw error;
}
