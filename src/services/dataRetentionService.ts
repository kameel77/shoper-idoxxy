import { db } from "../config/database";
import { env } from "../config/env";

/**
 * GDPR data-lifecycle enforcement for two distinct obligations:
 *
 *  - Defect A: `sync_logs` rows carry the e-mail addresses of a merchant's
 *    own customers (third-party personal data). They must not be retained
 *    indefinitely - purgeExpiredSyncLogs() deletes rows older than
 *    env.SYNC_LOG_RETENTION_DAYS, globally (not per-shop: age is the only
 *    criterion).
 *
 *  - Defect B: once a shop uninstalls the app, its tokens are wiped
 *    immediately (see shopConnectionService.revokeAndWipeTokens, called from
 *    the verified POST /uninstall handler in src/routes/install.ts) and,
 *    after a env.UNINSTALL_PURGE_GRACE_DAYS grace period, every row that
 *    belongs to that shop (the connection itself, plus settings,
 *    event_mappings and sync_logs) is deleted - purgeExpiredUninstalledShops()
 *    below.
 *
 * Every function here takes `now` as an explicit parameter rather than
 * calling Date.now() internally, specifically so tests can drive the clock
 * deterministically without faking global time.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sentinel shop_id assigned by src/config/database.ts (resolveLegacyShopId)
 * to pre-multi-tenant settings/event_mappings/sync_logs rows when the owning
 * shop could not be uniquely determined. It has NO corresponding
 * shop_connections row by construction, so it can never satisfy the
 * `status = 'revoked'` join purgeExpiredUninstalledShops() queries against -
 * but the query below also excludes it explicitly (`shop_id != ?`) and the
 * per-shop delete loop skips it too, as defense in depth: this sentinel must
 * never be deleted by the uninstall purge, since deleting it would destroy
 * legacy data for a shop we can no longer identify. It IS still subject to
 * purgeExpiredSyncLogs(), which is deliberately global/age-only and has no
 * shop-scoped exception - a legacy sync log is still someone's customer's
 * e-mail address and still ages out after the retention window like any
 * other.
 */
export const LEGACY_SHOP_ID = "__legacy__";

// --- Defect A: sync_logs retention -----------------------------------------

// Boundary decision: a sync log exactly `SYNC_LOG_RETENTION_DAYS` days old
// (i.e. timestamp === now - retentionMs, age exactly equal to the retention
// window) is treated as EXPIRED and deleted (`timestamp <= cutoff`, not
// `<`). "Delete rows older than 90 days" is ambiguous at exactly the 90-day
// mark; we resolve that ambiguity in favor of the shorter retention (err on
// the side of deleting third-party personal data sooner rather than later).
const deleteExpiredSyncLogsStmt = db.prepare("DELETE FROM sync_logs WHERE timestamp <= ?");

export const purgeExpiredSyncLogs = (now: number = Date.now()): number => {
  const retentionMs = env.SYNC_LOG_RETENTION_DAYS * DAY_MS;
  const cutoff = now - retentionMs;
  const result = deleteExpiredSyncLogsStmt.run(cutoff);
  if (result.changes > 0) {
    console.log(`[Retention] purged ${result.changes} sync logs`);
  }
  return result.changes;
};

// --- Defect B: purge shops past the post-uninstall grace period ------------

// Same boundary convention as above: a shop revoked exactly
// UNINSTALL_PURGE_GRACE_DAYS days ago (revoked_at === now - graceMs) is
// treated as past the grace period and purged (`revoked_at <= ?`).
const findExpiredRevokedShopIdsStmt = db.prepare(
  `SELECT shop_id FROM shop_connections
   WHERE status = 'revoked' AND revoked_at IS NOT NULL AND revoked_at <= ? AND shop_id != ?`,
);

const deleteShopSyncLogsStmt = db.prepare("DELETE FROM sync_logs WHERE shop_id = ?");
const deleteShopSettingsStmt = db.prepare("DELETE FROM settings WHERE shop_id = ?");
const deleteShopEventMappingsStmt = db.prepare("DELETE FROM event_mappings WHERE shop_id = ?");
const deleteShopConnectionStmt = db.prepare("DELETE FROM shop_connections WHERE shop_id = ?");

// Single transaction per shop: never leave a connection deleted with its
// sync logs (or settings/mappings) still behind, or vice versa.
const purgeOneShop = db.transaction((shopId: string): void => {
  deleteShopSyncLogsStmt.run(shopId);
  deleteShopSettingsStmt.run(shopId);
  deleteShopEventMappingsStmt.run(shopId);
  deleteShopConnectionStmt.run(shopId);
});

/**
 * Delete every row (shop_connections, settings, event_mappings, sync_logs)
 * belonging to a shop that:
 *   - has shop_connections.status = 'revoked' (i.e. went through a verified
 *     uninstall - see shopConnectionService.revokeAndWipeTokens), AND
 *   - was revoked at least env.UNINSTALL_PURGE_GRACE_DAYS days ago.
 *
 * A `linked` (or `installed_not_linked`/`token_invalid`) shop is never
 * touched, no matter how old - only an actual uninstall starts this clock.
 * The `__legacy__` sentinel (see LEGACY_SHOP_ID above) is never touched
 * either, even if it somehow acquired a shop_connections row.
 *
 * Returns the list of purged shop ids (for logging/testing).
 */
export const purgeExpiredUninstalledShops = (now: number = Date.now()): string[] => {
  const graceMs = env.UNINSTALL_PURGE_GRACE_DAYS * DAY_MS;
  const cutoff = now - graceMs;

  const rows = findExpiredRevokedShopIdsStmt.all(cutoff, LEGACY_SHOP_ID) as Array<{
    shop_id: string;
  }>;

  const purgedShopIds: string[] = [];
  for (const row of rows) {
    if (row.shop_id === LEGACY_SHOP_ID) {
      // Belt and braces - see LEGACY_SHOP_ID doc comment. The query above
      // already excludes it; this is a second, independent guard so a future
      // change to the query can't silently start deleting legacy data.
      continue;
    }
    purgeOneShop(row.shop_id);
    purgedShopIds.push(row.shop_id);
    console.log(`[Retention] purged shop ${row.shop_id} after grace period`);
  }
  return purgedShopIds;
};

// --- Scheduler ---------------------------------------------------------------

/**
 * Runs both purges once immediately, then every 24h thereafter via
 * setInterval(...).unref() (so a lingering timer never keeps the Node
 * process alive by itself).
 *
 * IMPORTANT: this must be started from src/index.ts ONLY, never from
 * src/app.ts's createApp(). The test suite builds the app via createApp()
 * many times across ~15 test files; a setInterval started inside it would
 * fire a real 24h timer per call, leaking handles and risking a hung/flaky
 * `vitest run`. createApp() is exercised heavily by tests precisely because
 * it must stay side-effect-free beyond wiring up the Express app itself -
 * please do not "helpfully" move this call there.
 */
export const startDataRetentionScheduler = (): void => {
  const runPurge = () => {
    const now = Date.now();
    purgeExpiredSyncLogs(now);
    purgeExpiredUninstalledShops(now);
  };

  runPurge();

  const interval = setInterval(runPurge, DAY_MS);
  interval.unref();
};
