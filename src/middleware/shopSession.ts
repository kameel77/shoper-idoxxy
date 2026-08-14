import { randomBytes } from "node:crypto";

import type { Request, Response, NextFunction } from "express";

// req.shopId is the single, narrow surface every downstream handler and
// resolveShopClient() reads. It is set only by requireShopSession below, from
// the verified session (or, for an authenticated operator, from an explicit
// ?shopId= they supplied - see requireShopSession).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      shopId?: string;
    }
  }
}

// Extend express-session's SessionData with the fields this app stores in the
// session cookie. `shopId` is the trust boundary for every per-shop endpoint:
// it may ONLY be assigned in three places, all in establishShopSession()
// below: src/routes/install.ts (GET /oauth/callback), src/routes/settings.ts
// (the action === "install" branch), and src/routes/settings.ts's
// signature-verified iframe-entry block (GET /settings, further down the
// same handler). The first two run only after a successful Shoper OAuth
// authorization_code exchange for that shop; the third instead trusts
// Shoper's HMAC-signed iframe-entry query params (see
// src/middleware/shoperSignature.ts's verifyIframeEntrySignature) resolved
// against a shoper_license mapping recorded by one of the first two.
// `csrfToken` backs the double-submit CSRF check below.
declare module "express-session" {
  interface SessionData {
    userId?: string;
    isAuthenticated?: boolean;
    shopId?: string;
    csrfToken?: string;
  }
}

const firstParam = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

// Best-effort host extraction for the reauthorizeUrl hint returned on 401.
// This is purely informational (tells the merchant which /install link to
// click) and must never be used to authorize anything.
const hostFromShopUrlHint = (req: Request): string | undefined => {
  const raw =
    firstParam(req.query.shop_url as string | string[] | undefined) ??
    firstParam(req.query.shopUrl as string | string[] | undefined);

  if (!raw) return undefined;

  const withoutScheme = raw.replace(/^https?:\/\//, "");
  const host = withoutScheme.split("/")[0]?.trim();
  return host || undefined;
};

const respondUnauthorized = (req: Request, res: Response): void => {
  const host = hostFromShopUrlHint(req);
  const payload: { ok: false; error: string; reauthorizeUrl?: string } = {
    ok: false,
    error:
      "Sesja sklepu wygasła lub nie istnieje. Otwórz aplikację ponownie z poziomu panelu Shoper, aby się zalogować.",
  };
  if (host) {
    payload.reauthorizeUrl = `/install?shop_url=${encodeURIComponent(host)}`;
  }
  res.status(401).json(payload);
};

/**
 * Require a verified shop session. Sets req.shopId from req.session.shopId,
 * which is only ever populated after a successful Shoper OAuth exchange (see
 * src/routes/install.ts and src/routes/settings.ts). There is deliberately no
 * fallback to req.query.shopId, req.body.shopId or any header - those are
 * caller-supplied and grant no authority.
 *
 * The one exception: an admin operator authenticated via the separate
 * requireAuth/userRepository mechanism (req.user) is not a tenant, but may
 * explicitly inspect a shop by supplying ?shopId=. Every such access is
 * logged.
 */
export const requireShopSession = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (req.user) {
    const operatorShopId = firstParam(req.query.shopId as string | string[] | undefined);
    if (operatorShopId) {
      console.log("[ShopSession] operator access", {
        user: req.user.username ?? req.user.id,
        shopId: operatorShopId,
      });
      req.shopId = operatorShopId;
      next();
      return;
    }
    // An operator session alone does not imply a shop - they must pick one.
    respondUnauthorized(req, res);
    return;
  }

  const shopId = req.session?.shopId;
  if (!shopId) {
    respondUnauthorized(req, res);
    return;
  }

  req.shopId = shopId;
  next();
};

/**
 * Establish a verified shop session, defending against session fixation: the
 * pre-existing session (whatever an attacker may have primed via a
 * shared/fixed session cookie) is discarded and a fresh session id is issued
 * before req.session.shopId is written. This is the ONLY way req.session.shopId
 * may be set - called from three places, all requiring proof of shop identity
 * before calling this: src/routes/install.ts (GET /oauth/callback) and
 * src/routes/settings.ts (the action === "install" branch), both immediately
 * after a successful Shoper OAuth authorization_code exchange for shopId; and
 * src/routes/settings.ts's signature-verified iframe-entry block, immediately
 * after verifyIframeEntrySignature (see src/middleware/shoperSignature.ts)
 * confirms Shoper's HMAC over the iframe-entry query params and a
 * shoper_license mapping resolves the signed `shop` license to this shopId.
 *
 * An admin operator login (req.session.userId / isAuthenticated) already
 * present on the pre-regenerate session is carried over onto the new one -
 * regenerate() otherwise discards it, which would silently log the operator
 * out if they happened to also complete a shop OAuth flow in the same
 * browser session.
 *
 * Rejects (never redirects) if regenerate/save fails, so callers must not
 * treat a successful OAuth token exchange as sufficient on its own to
 * redirect the browser into an authenticated area.
 */
export const establishShopSession = (req: Request, shopId: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (!req.session) {
      reject(new Error("Session middleware is not initialized"));
      return;
    }

    const previousUserId = req.session.userId;
    const previousIsAuthenticated = req.session.isAuthenticated;

    req.session.regenerate((regenerateError) => {
      if (regenerateError) {
        reject(regenerateError);
        return;
      }
      if (!req.session) {
        reject(new Error("Session middleware is not initialized after regenerate"));
        return;
      }

      if (previousUserId !== undefined) {
        req.session.userId = previousUserId;
      }
      if (previousIsAuthenticated !== undefined) {
        req.session.isAuthenticated = previousIsAuthenticated;
      }
      req.session.shopId = shopId;

      req.session.save((saveError) => {
        if (saveError) {
          reject(saveError);
          return;
        }
        resolve();
      });
    });
  });
};

/**
 * Reject a caller-supplied shop id (from a request body or URL param) that
 * disagrees with the verified session shop id. An operator acting through
 * requireShopSession's ?shopId= override is allowed to proceed because
 * req.shopId already reflects the shop they selected.
 */
export const ensureShopIdMatchesSession = (
  req: Request,
  res: Response,
  candidate: string | undefined,
): boolean => {
  if (candidate && candidate !== req.shopId) {
    res.status(403).json({
      ok: false,
      error: "Brak uprawnień do zarządzania danymi innego sklepu.",
    });
    return false;
  }
  return true;
};

/**
 * Lazily issue (or return the existing) CSRF token for the current session.
 * Storing it in the session (rather than deriving it from anything
 * request-supplied) is what makes the double-submit check in requireCsrf
 * meaningful - an attacker triggering a cross-site request cannot read the
 * cookie-scoped session to learn the token.
 */
export const issueCsrfToken = (req: Request): string => {
  if (!req.session) {
    throw new Error("Session middleware is not initialized");
  }
  if (!req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString("hex");
  }
  return req.session.csrfToken;
};

/**
 * Double-submit CSRF protection for state-changing shop-session endpoints.
 * Session cookies are sameSite: "none" in production (required for the
 * Shoper iframe), which makes every mutating endpoint CSRF-able unless the
 * caller also proves it can read a value out of the session via JS (the
 * X-CSRF-Token header, which a cross-site form/navigation cannot set).
 */
export const requireCsrf = (req: Request, res: Response, next: NextFunction): void => {
  const sessionToken = req.session?.csrfToken;
  const headerToken = req.header("X-CSRF-Token");

  if (!sessionToken || !headerToken || headerToken !== sessionToken) {
    res.status(403).json({
      ok: false,
      error: "Nieprawidłowy lub brakujący token CSRF. Odśwież stronę i spróbuj ponownie.",
    });
    return;
  }

  next();
};
