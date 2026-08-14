import path from "node:path";

import cookieParser from "cookie-parser";
import express, { type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import morgan from "morgan";
import session from "express-session";

import { env } from "./config/env";
import { db } from "./config/database";
import { userRepository } from "./repositories/userRepository";
import { shopConnectionService } from "./services/shopConnectionService";
import { requireAuth, optionalAuth } from "./middleware/auth";
import { authRouter } from "./routes/auth";
import { idoxxyAdminRouter } from "./routes/idoxxyAdmin";
import { settingsRouter } from "./routes/settings";
import { customerGroupsRouter } from "./routes/customerGroups";
import { webhooksRouter } from "./routes/webhooks";
import { adminIdoxxyRouter } from "./routes/adminIdoxxy";
import { installRouter } from "./routes/install";
import { webhookRateLimiter } from "./middleware/rateLimit";
import { errorHandler } from "./middleware/errorHandler";
import { SqliteSessionStore } from "./services/sessionStore";

// Base CSP directives shared by every response. frame-ancestors is handled
// separately (see cspFrameAncestorsMiddleware below) because it is the one
// directive that can safely vary per-response.
const CSP_BASE_DIRECTIVES: Record<string, readonly string[]> = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'unsafe-inline'", "https://dcsaascdn.net"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "https:"],
  "connect-src": ["'self'"],
  "font-src": ["'self'", "https:", "data:"],
  "object-src": ["'none'"],
  "media-src": ["'self'"],
};

/**
 * Best-effort "scheme://host" origin extraction for a stored shop_url/
 * technical_url value (which may or may not carry a scheme, and may carry a
 * path). Returns undefined on anything unparsable - callers must fall back
 * to "*" rather than emit a malformed frame-ancestors source expression.
 */
const toOrigin = (rawUrl: string): string | undefined => {
  try {
    const withScheme = rawUrl.startsWith("http://") || rawUrl.startsWith("https://") ? rawUrl : `https://${rawUrl}`;
    const parsed = new URL(withScheme);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
};

/**
 * Per-response Content-Security-Policy, narrowing frame-ancestors from "*" to
 * the specific shop's known hosts when - and only when - we can be
 * confident: a verified shop session exists AND both shopUrl and
 * technicalUrl are on record for it (see src/services/shopConnectionService.ts's
 * recordTechnicalUrl, populated from Shoper's /webapi/rest/application-config
 * during OAuth - src/routes/install.ts and the install branch of
 * src/routes/settings.ts). In every other case (no session, hosts unknown,
 * an unparsable stored URL, anything ambiguous) this keeps "*": breaking the
 * iframe for a merchant during marketplace review is far worse than the
 * residual clickjacking risk that "*" carries, so this only ever narrows,
 * never widens, and fails open to "*" rather than to a possibly-wrong host.
 *
 * Implemented as a plain header-writing middleware (not via helmet's
 * contentSecurityPolicy option) specifically because it needs to vary per
 * request based on req.session - helmet's directives are fixed at app-setup
 * time. It must run after the session middleware (needs req.session.shopId)
 * and is the sole writer of the Content-Security-Policy header - helmet's
 * own CSP handling is disabled below (contentSecurityPolicy: false) so the
 * two never fight over the same header.
 */
const cspFrameAncestorsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  let frameAncestors: readonly string[] = ["*"];

  const shopId = req.session?.shopId;
  if (shopId) {
    const connection = shopConnectionService.getConnection(shopId);
    if (connection?.shopUrl && connection?.technicalUrl) {
      const shopOrigin = toOrigin(connection.shopUrl);
      const technicalOrigin = toOrigin(connection.technicalUrl);
      if (shopOrigin && technicalOrigin) {
        frameAncestors = [...new Set([shopOrigin, technicalOrigin])];
      }
    }
  }

  const directives = [
    ...Object.entries(CSP_BASE_DIRECTIVES).map(([name, sources]) => `${name} ${sources.join(" ")}`),
    `frame-ancestors ${frameAncestors.join(" ")}`,
  ];
  res.setHeader("Content-Security-Policy", directives.join("; "));
  next();
};

export const createApp = () => {
  const app = express();

  // This app runs behind Coolify's own reverse proxy (Traefik), which is the
  // single hop between the internet and this container - there is no further
  // internal proxy layer in front of it. `1` trusts exactly that one hop's
  // X-Forwarded-For entry (so req.ip / req.secure reflect the real client),
  // and nothing beyond it - unlike `true` (trust the whole forwarded chain),
  // which would let a client forge its own apparent IP by prepending fake
  // entries to X-Forwarded-For. This is load-bearing for the rate limiters in
  // src/middleware/rateLimit.ts, which key on req.ip.
  app.set("trust proxy", 1);

  app.use(
    helmet({
      // Handled by cspFrameAncestorsMiddleware below instead, so it can vary
      // frame-ancestors per-response based on the shop session - see its doc
      // comment for why.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      frameguard: false, // Required for frame-ancestors to work over X-Frame-Options
    }),
  );

  app.use(cookieParser());

  // Session configuration. Store: SQLite-backed (src/services/sessionStore.ts),
  // not express-session's default MemoryStore - MemoryStore is explicitly
  // documented as unfit for production (leaks memory, drops every merchant's
  // session on each deploy/restart, doesn't scale past one process). A new
  // SqliteSessionStore instance is created per createApp() call - cheap (it
  // just prepares statements against the already-open `db` singleton) and
  // keeps createApp() free of any shared-module-level session state.
  app.use(
    session({
      store: new SqliteSessionStore(),
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      name: "shoper_idoxxy.sid",
      cookie: {
        secure: env.NODE_ENV === "production",
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: env.NODE_ENV === "production" ? "none" : "lax", // Must be none for 3rd-party cross-origin iframes
      },
    }),
  );

  // Must run after the session middleware above (reads req.session.shopId).
  app.use(cspFrameAncestorsMiddleware);

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan("dev"));

  // Health check - no auth required. Runs a trivial query so a container
  // whose SQLite volume is broken/unreachable fails readiness instead of
  // reporting healthy - see src/config/database.ts. Deliberately cheap (a
  // single "SELECT 1", no table scan) since this may be polled frequently.
  app.get("/health", (_req: Request, res: Response) => {
    try {
      db.prepare("SELECT 1").get();
      res.json({ status: "ok" });
    } catch (error) {
      console.error("[Health] Database check failed:", error);
      res.status(503).json({ status: "error" });
    }
  });

  // Auth routes (login/logout) - no auth required
  app.use("/auth", authRouter);

  // Shop-specific settings. optionalAuth only attaches req.user when an admin
  // operator is logged in (separate mechanism from the shop session); it does
  // NOT grant shop access by itself. Per-route access control lives in each
  // router: shop-scoped endpoints use requireShopSession (trust boundary is
  // req.session.shopId, set only after a verified Shoper OAuth exchange - see
  // src/routes/install.ts and the install branch of src/routes/settings.ts),
  // and operator-only endpoints use requireApiAuth.
  app.use("/settings", optionalAuth, settingsRouter);
  app.use("/admin/idoxxy", optionalAuth, idoxxyAdminRouter);
  app.use("/admin/idoxxy", optionalAuth, adminIdoxxyRouter);
  app.use("/customers", optionalAuth, customerGroupsRouter);

  // Public static files - but protect admin folder
  app.use("/admin", requireAuth, express.static(path.join(process.cwd(), "public", "admin")));
  app.use(express.static(path.join(process.cwd(), "public")));
  
  // App Store OAuth public routes
  app.use("/", installRouter);

  // Webhooks don't require auth (they use signature verification). Rate
  // limited generously (see src/middleware/rateLimit.ts) purely as an abuse
  // backstop - these can already answer non-200 statuses for other reasons
  // (400/401/428/500), so a 429 here doesn't break any documented contract.
  app.use("/webhooks", webhookRateLimiter, webhooksRouter);

  // Redirect root based on auth status (handles GET and POST from Shoper iframe)
  app.all("/", optionalAuth, (req: Request, res: Response) => {
    if (req.user) {
      // Admin is logged in - show dashboard
      return res.redirect("/admin/dashboard.html");
    }

    // Combine query and body params to preserve Shoper context (e.g. shop, hash) across redirect
    const searchParams = new URLSearchParams();
    [req.query, req.body].forEach((source) => {
      if (source && typeof source === "object") {
        for (const [key, value] of Object.entries(source)) {
          if (typeof value === "string") {
            searchParams.set(key, value);
          }
        }
      }
    });

    const qs = searchParams.toString();
    const shopId = searchParams.get("shopId") || searchParams.get("shop") || req.headers["x-shoper-shop-id"];

    if (qs || shopId) {
      res.redirect(`/settings${qs ? "?" + qs : ""}`);
    } else {
      res.sendFile(path.join(process.cwd(), "public", "index.html"));
    }
  });

  // Global error handler - see src/middleware/errorHandler.ts for the full
  // rationale. MUST be registered last: Express only routes an error to
  // middleware defined *before* it in the stack.
  app.use(errorHandler);

  // Bootstrap (or validate) the operator/admin account - see
  // src/repositories/userRepository.ts's bootstrapAdminAccount() doc comment.
  // Deliberately NOT wrapped in try/catch: in production this can throw
  // (missing/weak ADMIN_PASSWORD is already caught earlier by
  // src/config/env.ts at import time; this catches the case of an existing
  // account still holding the legacy default password), and createApp() is
  // meant to propagate that synchronously so the process never starts
  // listening - the same fail-fast posture as every other production secret
  // check in this codebase.
  userRepository.bootstrapAdminAccount();

  return app;
};
