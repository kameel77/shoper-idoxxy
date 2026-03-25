import type { Request } from "express";

import { IdoxxyClient } from "../clients/idoxxyClient";
import { IdoxxyService } from "../services/idoxxyService";
import { shopConnectionService } from "../services/shopConnectionService";

const idoxxyService = new IdoxxyService();

/**
 * Resolve an IdoxxyClient for the current request.
 *
 * Priority:
 *  1. req.shopId (set by extractShopContext middleware)
 *  2. First connection with status "linked"
 *
 * Throws HTTP-friendly error if no linked shop is found.
 */
export function resolveShopClient(req: Request): IdoxxyClient {
  const shopId = req.shopId;

  if (shopId) {
    return idoxxyService.getClientForShop(shopId);
  }

  // Fallback: find first linked connection
  const connections = shopConnectionService.listConnections();
  const linked = connections.find((c) => c.status === "linked");

  if (linked) {
    return idoxxyService.getClientForShop(linked.shopId);
  }

  const error = new Error(
    "Brak połączonego sklepu z iDoxxy. Przejdź do panelu ustawień i połącz sklep.",
  );
  (error as any).statusCode = 428;
  throw error;
}
