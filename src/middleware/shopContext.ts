import type { Request, Response, NextFunction } from "express";

// Extend Express Request to include shop context
declare global {
  namespace Express {
    interface Request {
      shopId?: string;
      shopUrl?: string;
    }
  }
}

// Extract shop context from request headers or query params
// Used when shop admins access from Shoper.pl panel
export const extractShopContext = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Try to get shopId from various sources (in order of priority)
  const shopId = 
    req.query.shopId as string | undefined ||
    req.body?.shopId ||
    req.headers["x-shoper-shop-id"] as string | undefined ||
    req.headers["x-shop-id"] as string | undefined ||
    req.headers["x-shop"] as string | undefined;

  const shopUrl =
    req.query.shopUrl as string | undefined ||
    req.body?.shopUrl ||
    req.headers["x-shoper-shop-url"] as string | undefined ||
    req.headers["x-shop-url"] as string | undefined;

  if (shopId) {
    req.shopId = shopId;
  }
  
  if (shopUrl) {
    req.shopUrl = shopUrl;
  }

  next();
};

// Require shop context - returns 400 if no shop identified
export const requireShopContext = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!req.shopId) {
    res.status(400).json({ 
      ok: false, 
      error: "Brak identyfikatora sklepu. Użyteczne nagłówki: X-Shoper-Shop-Id lub parametr: ?shopId=..." 
    });
    return;
  }
  next();
};
