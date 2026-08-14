import type { Request, Response, NextFunction } from "express";

/**
 * Global error handler - MUST be registered last in createApp() (see
 * src/app.ts). Express recognises error middleware by its 4-argument arity,
 * and only routes/middleware defined before it get their errors caught here.
 * Catches everything a route handler throws or forwards via next(err) -
 * notably the webhook handlers in src/routes/webhooks.ts, which `throw`
 * after logging instead of catching - so a response is always sent instead
 * of falling through to Express's own default handler (which would leak a
 * stack trace/internal message to the client).
 *
 * Only ever returns the app's standard { ok: false, error: <Polish message> }
 * shape - the error itself (stack, message, any embedded token/SQL fragment)
 * is logged server-side (with method + path for triage) and never put in the
 * response body. Honours err.statusCode when the thrower set one (e.g. a
 * 400/401/428 domain error), defaulting to 500 otherwise.
 *
 * This does NOT touch 404s for missing static assets/unmatched routes:
 * Express only invokes error middleware for a thrown/forwarded error, never
 * for an ordinary "no route matched", so express.static's default 404
 * behaviour for a missing file is untouched by this handler.
 *
 * Extracted into its own module (rather than an inline app.use() in
 * src/app.ts) so it can be unit tested directly against a minimal Express
 * app - see tests/error-handler.test.ts.
 */
export const errorHandler = (err: unknown, req: Request, res: Response, next: NextFunction): void => {
  // If a response has already started streaming, we can no longer send a
  // fresh JSON body - defer to Express's built-in handler, which just
  // terminates the connection (this is Express's own documented escape hatch
  // for that situation, not a leak).
  if (res.headersSent) {
    next(err);
    return;
  }

  const statusCode =
    typeof (err as { statusCode?: unknown } | null)?.statusCode === "number"
      ? (err as { statusCode: number }).statusCode
      : 500;

  console.error(`[App] Unhandled error on ${req.method} ${req.path}:`, err);

  res.status(statusCode).json({
    ok: false,
    error: "Wystąpił nieoczekiwany błąd serwera. Spróbuj ponownie później.",
  });
};
