import type { Request, Response, NextFunction } from "express";

/**
 * In-memory fixed-window rate limiting. No new npm dependency - a Map keyed
 * by "limiterName:clientIp" plus a periodic sweep to reclaim memory from
 * stale entries (see startRateLimitSweeper() below).
 *
 * This is process-local state: it resets on every deploy/restart and is not
 * shared across horizontally-scaled instances. That's an accepted trade-off
 * for this app's scale - see the task report for the full reasoning.
 *
 * Client IP derivation: this app runs behind Coolify's own reverse proxy
 * (Traefik), which sits directly in front of the app container as the single
 * hop between the internet and this process - there is no additional
 * internal proxy layer between Traefik and the app. app.set("trust proxy", 1)
 * in src/app.ts tells Express to trust exactly the first hop's
 * X-Forwarded-For entry (the real client IP that Traefik appended) and
 * nothing beyond it, so req.ip resolves to the real client IP rather than to
 * Traefik's own address, WITHOUT trusting an attacker-supplied chain of fake
 * proxies further down the header (which `trust proxy: true` would do). If a
 * CDN/WAF is ever added in front of Coolify, this constant must become 2 (or
 * the appropriate hop count) - it is deliberately a small integer, not
 * `true`, precisely so a wrong guess fails toward "under-trusting" (treating
 * a shared edge IP as the client) rather than "over-trusting" (a client
 * spoofing its own IP via a hand-crafted X-Forwarded-For header).
 */

type WindowEntry = {
  count: number;
  windowStart: number;
  windowMs: number;
};

const buckets = new Map<string, WindowEntry>();

const clientIp = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? "unknown";

export type RateLimiterOptions = {
  /** Unique name for this limiter, used as the bucket key prefix so different limiters never share counters. */
  name: string;
  /** Fixed window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed per window per client IP. */
  max: number;
  /**
   * "block" (default): respond 429 with a Polish message + Retry-After header
   * when the limit is exceeded, and do not call next().
   *
   * "silent-ok": respond 200 "OK" (no JSON body, matching the plain-text
   * contract Shoper's App Store callbacks require - see verifyAppStoreCallback
   * in src/routes/install.ts) and do not call next(). Used for the App Store
   * lifecycle/billing callbacks specifically because Shoper requires HTTP 200
   * on those endpoints unconditionally; answering 429 there would violate
   * that contract and could make Shoper's own retry-with-backoff logic treat
   * a rate-limited request as a delivery failure and retry it sooner/more
   * aggressively - the opposite of what a rate limiter is for.
   */
  mode?: "block" | "silent-ok";
  /** Polish, user-facing message for "block" mode. Ignored in "silent-ok" mode. */
  message?: string;
};

export const createRateLimiter = (options: RateLimiterOptions) => {
  const mode = options.mode ?? "block";

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${options.name}:${clientIp(req)}`;
    const now = Date.now();

    let entry = buckets.get(key);
    if (!entry || now - entry.windowStart >= options.windowMs) {
      entry = { count: 0, windowStart: now, windowMs: options.windowMs };
      buckets.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > options.max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((entry.windowStart + entry.windowMs - now) / 1000),
      );
      res.setHeader("Retry-After", String(retryAfterSeconds));

      if (mode === "silent-ok") {
        res.status(200).send("OK");
        return;
      }

      res.status(429).json({
        ok: false,
        error: options.message ?? "Zbyt wiele żądań. Spróbuj ponownie później.",
      });
      return;
    }

    next();
  };
};

// ---------------------------------------------------------------------------
// Limit constants - all in one place, one comment each explaining the choice.
// ---------------------------------------------------------------------------

/**
 * POST /auth/login: strict. This endpoint verifies a bcrypt password hash
 * and would otherwise be freely brute-forceable. 10 attempts / 15 minutes /
 * IP is generous enough for a legitimate operator who mistypes a password a
 * few times, while making an online brute-force attempt impractically slow.
 */
export const LOGIN_RATE_LIMIT_OPTIONS: RateLimiterOptions = {
  name: "auth-login",
  windowMs: 15 * 60 * 1000,
  max: 10,
  mode: "block",
  message: "Zbyt wiele prób logowania. Spróbuj ponownie za kilka minut.",
};

/**
 * Event webhooks (POST /webhooks/shoper/*). These already answer non-200
 * statuses for other reasons (400/401/428/500 - see src/routes/webhooks.ts),
 * so a 429 here doesn't break any documented contract. Sized generously
 * (300/min = 5/sec sustained) so no plausible burst of real Shoper
 * customer.created/order.created traffic for a single shop is ever
 * throttled; it exists only to bound abuse/misconfiguration.
 */
export const WEBHOOK_RATE_LIMIT_OPTIONS: RateLimiterOptions = {
  name: "webhooks",
  windowMs: 60 * 1000,
  max: 300,
  mode: "block",
  message: "Zbyt wiele żądań webhook. Spróbuj ponownie za chwilę.",
};

/**
 * App Store lifecycle/billing callbacks (POST /uninstall, /billing/subscription,
 * /billing/automatic-messages - src/routes/install.ts). Shoper requires HTTP
 * 200 on these unconditionally and retries failed billing messages up to 100
 * times with escalating backoff, so this uses mode: "silent-ok" (see above) -
 * never a 429 - to avoid turning a rate limit into a retry storm. The window
 * is sized generously (600/min) since it exists purely as a backstop against
 * a misbehaving/malicious caller hammering these endpoints, not to shape
 * Shoper's own traffic.
 */
export const APPSTORE_CALLBACK_RATE_LIMIT_OPTIONS: RateLimiterOptions = {
  name: "appstore-callback",
  windowMs: 60 * 1000,
  max: 600,
  mode: "silent-ok",
};

/**
 * State-changing /settings/* endpoints (credentials, mappings, link, ...).
 * Generous - a legitimate merchant admin saving several settings sections in
 * quick succession, or a UI that retries a failed save, should never hit
 * this; it exists to bound scripted abuse of an authenticated session.
 */
export const SETTINGS_MUTATION_RATE_LIMIT_OPTIONS: RateLimiterOptions = {
  name: "settings-mutation",
  windowMs: 60 * 1000,
  max: 120,
  mode: "block",
  message: "Zbyt wiele żądań. Spróbuj ponownie za chwilę.",
};

export const loginRateLimiter = createRateLimiter(LOGIN_RATE_LIMIT_OPTIONS);
export const webhookRateLimiter = createRateLimiter(WEBHOOK_RATE_LIMIT_OPTIONS);
export const appStoreCallbackRateLimiter = createRateLimiter(APPSTORE_CALLBACK_RATE_LIMIT_OPTIONS);
export const settingsMutationRateLimiter = createRateLimiter(SETTINGS_MUTATION_RATE_LIMIT_OPTIONS);

// ---------------------------------------------------------------------------
// Sweep: reclaim memory from buckets nobody has touched since their window
// expired (e.g. a one-off caller whose entry would otherwise sit in the Map
// forever). setInterval(...).unref() so a lingering timer never keeps the
// Node process alive by itself.
//
// IMPORTANT: same rule as src/services/dataRetentionService.ts's scheduler -
// this must be started from src/index.ts ONLY, never from src/app.ts's
// createApp(). createApp() is exercised many times across the test suite and
// must stay side-effect-free beyond wiring up the Express app itself.
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export const startRateLimitSweeper = (): void => {
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (now - entry.windowStart >= entry.windowMs) {
        buckets.delete(key);
      }
    }
  }, SWEEP_INTERVAL_MS);
  interval.unref();
};
