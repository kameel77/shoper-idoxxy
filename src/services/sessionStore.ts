import session from "express-session";

import { db } from "../config/database";

/**
 * SQLite-backed express-session store, replacing the default MemoryStore
 * (see src/config/database.ts for the `sessions` table this reads/writes).
 *
 * Sessions are the trust boundary for shop identity in this app - req.session.shopId
 * is set only after a verified Shoper OAuth exchange (src/routes/install.ts) and
 * every shop-scoped route trusts it directly (src/middleware/shopSession.ts) - so a
 * bug here is a security bug (a session that outlives its expiry, or one whose data
 * is corrupted/lost on read) rather than a mere convenience bug. Three invariants
 * this store maintains:
 *
 *   - get() NEVER throws to its caller for a missing/expired sid: express-session's
 *     own Store.load() treats a get() callback error as a hard failure (next(err)),
 *     so a routine "no session" state must be reported as callback(null, undefined),
 *     never as an error.
 *   - touch() extends expiry ONLY - it must never overwrite the `data` column, since
 *     express-session calls touch() precisely when the session was NOT modified
 *     (see shouldTouch/shouldSave in express-session's index.js), passing the
 *     unmodified live session back to us purely to reset its idle timer.
 *   - set() upserts unconditionally (INSERT ... ON CONFLICT DO UPDATE), since it is
 *     called both for a brand-new session id and for re-saving an existing one.
 *
 * Not registered as a class field-level Store.prototype.createSession override:
 * the base session.Store class (which this extends) already implements
 * createSession/load/regenerate generically from get/set/destroy, converting the
 * plain JSON object get() returns back into a live Session/Cookie - see
 * node_modules/express-session/session/store.js. Only the four methods below need
 * a SQLite-specific implementation.
 */

type SessionRow = {
  data: string;
  expires_at: number;
};

// Fallback TTL used only when a session's cookie carries neither `maxAge` nor
// `expires` (not expected in this app - src/app.ts always sets cookie.maxAge -
// but defensive rather than persisting a row that can never expire/be swept).
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const getStmt = db.prepare<[string], SessionRow>(
  "SELECT data, expires_at FROM sessions WHERE sid = ?",
);
const upsertStmt = db.prepare<[string, string, number]>(`
  INSERT INTO sessions (sid, data, expires_at)
  VALUES (?, ?, ?)
  ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
`);
const touchExpiryStmt = db.prepare<[number, string]>(
  "UPDATE sessions SET expires_at = ? WHERE sid = ?",
);
const destroyStmt = db.prepare<[string]>("DELETE FROM sessions WHERE sid = ?");
const sweepExpiredStmt = db.prepare<[number]>("DELETE FROM sessions WHERE expires_at <= ?");

/**
 * Derive the epoch-ms expiry for a session about to be persisted. `sessionData`
 * here is the LIVE Session object express-session hands to set()/touch() (not a
 * JSON-parsed one), so `cookie.maxAge` is a real getter computed from
 * `cookie.expires` (see node_modules/express-session/session/cookie.js) - reading
 * it directly, rather than re-deriving it from a serialized form, is what keeps
 * this correct across both call sites.
 */
const resolveExpiresAt = (sessionData: session.SessionData, now: number): number => {
  const maxAge = sessionData.cookie?.maxAge;
  if (typeof maxAge === "number" && Number.isFinite(maxAge)) {
    return now + maxAge;
  }

  const expires = sessionData.cookie?.expires;
  if (expires) {
    const expiresAt = new Date(expires).getTime();
    if (!Number.isNaN(expiresAt)) {
      return expiresAt;
    }
  }

  return now + DEFAULT_TTL_MS;
};

export class SqliteSessionStore extends session.Store {
  get(sid: string, callback: (err: unknown, session?: session.SessionData | null) => void): void {
    try {
      const row = getStmt.get(sid);

      if (!row) {
        callback(null, undefined);
        return;
      }

      if (row.expires_at <= Date.now()) {
        // Lazily reclaim the row on read too, not just via the periodic
        // sweep (see startSessionSweeper below) - a caller reading an
        // expired sid should never have to wait for the sweeper to run.
        destroyStmt.run(sid);
        callback(null, undefined);
        return;
      }

      callback(null, JSON.parse(row.data) as session.SessionData);
    } catch (error) {
      callback(error);
    }
  }

  set(sid: string, sessionData: session.SessionData, callback?: (err?: unknown) => void): void {
    try {
      const expiresAt = resolveExpiresAt(sessionData, Date.now());
      upsertStmt.run(sid, JSON.stringify(sessionData), expiresAt);
      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    try {
      destroyStmt.run(sid);
      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }

  touch(sid: string, sessionData: session.SessionData, callback?: (err?: unknown) => void): void {
    try {
      const expiresAt = resolveExpiresAt(sessionData, Date.now());
      const result = touchExpiryStmt.run(expiresAt, sid);

      if (result.changes === 0) {
        // The row was gone (expired and already swept/reclaimed between
        // requests) - fall back to a full upsert so the session isn't
        // silently dropped instead of merely having its expiry refreshed.
        upsertStmt.run(sid, JSON.stringify(sessionData), expiresAt);
      }

      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }
}

/**
 * Delete every session row past its expiry. Exported separately from the
 * scheduler below so tests can call it deterministically without waiting on
 * a timer.
 */
export const sweepExpiredSessions = (now: number = Date.now()): number => {
  const result = sweepExpiredStmt.run(now);
  return result.changes;
};

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

/**
 * Periodic sweep of expired session rows, `.unref()`ed so a lingering timer
 * never keeps the Node process alive by itself.
 *
 * IMPORTANT: same rule as src/services/dataRetentionService.ts's
 * startDataRetentionScheduler() and src/middleware/rateLimit.ts's
 * startRateLimitSweeper() - this must be started from src/index.ts ONLY,
 * never from src/app.ts's createApp(). The test suite calls createApp() many
 * times across ~15+ test files; a setInterval started inside it would leak a
 * timer handle per call and risk a hung/flaky `vitest run`. createApp() must
 * stay side-effect-free beyond wiring up the Express app itself.
 */
export const startSessionStoreSweeper = (): void => {
  const interval = setInterval(() => {
    sweepExpiredSessions();
  }, SWEEP_INTERVAL_MS);
  interval.unref();
};
