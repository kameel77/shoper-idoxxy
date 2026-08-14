import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Coverage for the GDPR data-lifecycle work in
 * src/services/dataRetentionService.ts:
 *   - Defect A: sync_logs retention (purgeExpiredSyncLogs)
 *   - Defect B: immediate token wipe on verified uninstall
 *     (shopConnectionService.revokeAndWipeTokens) + the post-grace-period
 *     full purge (purgeExpiredUninstalledShops)
 *
 * Fresh module graph + temp SQLite file per test (same pattern as
 * tests/shop-connection-lazy-migration.test.ts) so timestamps/env defaults
 * from one test never leak into another.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

let db: typeof import("../src/config/database").db;
let env: typeof import("../src/config/env").env;
let purgeExpiredSyncLogs: typeof import("../src/services/dataRetentionService").purgeExpiredSyncLogs;
let purgeExpiredUninstalledShops: typeof import("../src/services/dataRetentionService").purgeExpiredUninstalledShops;
let LEGACY_SHOP_ID: typeof import("../src/services/dataRetentionService").LEGACY_SHOP_ID;
let shopConnectionService: typeof import("../src/services/shopConnectionService").shopConnectionService;
let settingsRepository: typeof import("../src/repositories/settingsRepository").settingsRepository;

beforeEach(async () => {
  vi.resetModules();
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `idoxxy-test-retention-${randomUUID()}.db`);

  ({ db } = await import("../src/config/database"));
  ({ env } = await import("../src/config/env"));
  ({ purgeExpiredSyncLogs, purgeExpiredUninstalledShops, LEGACY_SHOP_ID } = await import(
    "../src/services/dataRetentionService"
  ));
  ({ shopConnectionService } = await import("../src/services/shopConnectionService"));
  ({ settingsRepository } = await import("../src/repositories/settingsRepository"));
});

const insertSyncLog = (shopId: string, timestamp: number, id: string = randomUUID()): string => {
  db.prepare(
    `INSERT INTO sync_logs (id, shop_id, timestamp, event, source, action, status, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, shopId, timestamp, "customer.created", "webhook", "sync-customer", "success", "{}");
  return id;
};

const countRows = (table: string, shopId: string): number =>
  (db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE shop_id = ?`).get(shopId) as { c: number }).c;

const sampleMapping = () => ({
  id: undefined,
  name: "Test mapping",
  event: "customer.created" as const,
  priority: 0,
  enabled: true,
  targetGroupIds: ["11111111-1111-1111-1111-111111111111"],
  documentId: undefined,
  conditions: [],
});

describe("purgeExpiredSyncLogs (Defect A: sync_logs retention)", () => {
  it("deletes a log older than the retention window and keeps one inside it", () => {
    const now = Date.now();
    const retentionMs = env.SYNC_LOG_RETENTION_DAYS * DAY_MS;
    const oldId = insertSyncLog("shop-a", now - retentionMs - DAY_MS);
    const freshId = insertSyncLog("shop-a", now - DAY_MS);

    const deleted = purgeExpiredSyncLogs(now);

    expect(deleted).toBe(1);
    expect(db.prepare("SELECT id FROM sync_logs WHERE id = ?").get(oldId)).toBeUndefined();
    expect(db.prepare("SELECT id FROM sync_logs WHERE id = ?").get(freshId)).toBeDefined();
  });

  it("boundary: a log exactly at the retention window edge is deleted (chosen: age === window counts as expired)", () => {
    const now = Date.now();
    const retentionMs = env.SYNC_LOG_RETENTION_DAYS * DAY_MS;
    const boundaryId = insertSyncLog("shop-a", now - retentionMs);

    const deleted = purgeExpiredSyncLogs(now);

    expect(deleted).toBe(1);
    expect(db.prepare("SELECT id FROM sync_logs WHERE id = ?").get(boundaryId)).toBeUndefined();
  });

  it("is global across shops, not per-shop: old logs for several shops are all pruned by age alone", () => {
    const now = Date.now();
    const retentionMs = env.SYNC_LOG_RETENTION_DAYS * DAY_MS;
    const idA = insertSyncLog("shop-a", now - retentionMs - DAY_MS);
    const idB = insertSyncLog("shop-b", now - retentionMs - 10 * DAY_MS);
    const idFreshA = insertSyncLog("shop-a", now - DAY_MS);
    const idFreshC = insertSyncLog("shop-c", now);

    const deleted = purgeExpiredSyncLogs(now);

    expect(deleted).toBe(2);
    expect(db.prepare("SELECT id FROM sync_logs WHERE id = ?").get(idA)).toBeUndefined();
    expect(db.prepare("SELECT id FROM sync_logs WHERE id = ?").get(idB)).toBeUndefined();
    expect(db.prepare("SELECT id FROM sync_logs WHERE id = ?").get(idFreshA)).toBeDefined();
    expect(db.prepare("SELECT id FROM sync_logs WHERE id = ?").get(idFreshC)).toBeDefined();
  });

  it("is also applied to the __legacy__ sentinel's logs (age-only, no shop exception)", () => {
    const now = Date.now();
    const retentionMs = env.SYNC_LOG_RETENTION_DAYS * DAY_MS;
    const legacyOldId = insertSyncLog(LEGACY_SHOP_ID, now - retentionMs - DAY_MS);

    purgeExpiredSyncLogs(now);

    expect(db.prepare("SELECT id FROM sync_logs WHERE id = ?").get(legacyOldId)).toBeUndefined();
  });
});

describe("shopConnectionService.revokeAndWipeTokens (Defect B, stage 1: immediate token wipe)", () => {
  it("wipes all three token columns immediately while leaving shop_url, mappings and settings intact", () => {
    const shopId = "shop-uninstall-immediate";
    shopConnectionService.registerInstallation(shopId, `https://${shopId}.example.com`);
    shopConnectionService.markLinked(shopId, "workspace-1", "idoxxy-token-plain");
    shopConnectionService.saveShoperTokens(shopId, "shoper-access-plain", "shoper-refresh-plain");
    settingsRepository.upsertMapping(shopId, sampleMapping());
    settingsRepository.updateFallbackGroups(shopId, {
      fallbackRegistrationGroupIds: ["11111111-1111-1111-1111-111111111111"],
      fallbackOrderGroupIds: [],
    });

    const before = shopConnectionService.getConnection(shopId)!;
    expect(before.idoxxyTokenEncrypted).toBeDefined();
    expect(before.shoperAccessToken).toBeDefined();
    expect(before.shoperRefreshToken).toBeDefined();

    const result = shopConnectionService.revokeAndWipeTokens(shopId, "shoper-app-store");

    expect(result.status).toBe("revoked");
    expect(result.revokedAt).toBeDefined();
    expect(result.revokedBy).toBe("shoper-app-store");
    expect(result.idoxxyTokenEncrypted).toBeUndefined();
    expect(result.shoperAccessToken).toBeUndefined();
    expect(result.shoperRefreshToken).toBeUndefined();

    // Untouched: shop_url, mappings, settings.
    expect(result.shopUrl).toBe(before.shopUrl);
    expect(settingsRepository.getMappings(shopId)).toHaveLength(1);
    expect(settingsRepository.getSnapshot(shopId).defaultGroupIds.registration).toEqual([
      "11111111-1111-1111-1111-111111111111",
    ]);
  });
});

describe("purgeExpiredUninstalledShops (Defect B, stage 2: purge after grace period)", () => {
  const graceMs = () => env.UNINSTALL_PURGE_GRACE_DAYS * DAY_MS;

  // Sets up a fully-populated, then-revoked shop, and back-dates revoked_at
  // via direct SQL (revoke/revokeAndWipeTokens always stamp Date.now(), so
  // this is the only way to simulate "revoked N days ago" deterministically).
  const setUpRevokedShop = (shopId: string, revokedAt: number): void => {
    shopConnectionService.registerInstallation(shopId, `https://${shopId}.example.com`);
    shopConnectionService.markLinked(shopId, "workspace-1", "idoxxy-token");
    settingsRepository.upsertMapping(shopId, sampleMapping());
    settingsRepository.updateFallbackGroups(shopId, {
      fallbackRegistrationGroupIds: ["11111111-1111-1111-1111-111111111111"],
      fallbackOrderGroupIds: [],
    });
    insertSyncLog(shopId, Date.now());

    shopConnectionService.revokeAndWipeTokens(shopId, "shoper-app-store");
    db.prepare("UPDATE shop_connections SET revoked_at = ? WHERE shop_id = ?").run(revokedAt, shopId);
  };

  it("deletes the connection, settings, event_mappings and sync_logs for a shop revoked longer ago than the grace period, in one pass", () => {
    const now = Date.now();
    const shopId = "shop-past-grace";
    setUpRevokedShop(shopId, now - graceMs() - DAY_MS);

    const purged = purgeExpiredUninstalledShops(now);

    expect(purged).toEqual([shopId]);
    expect(shopConnectionService.getConnection(shopId)).toBeUndefined();
    expect(countRows("settings", shopId)).toBe(0);
    expect(countRows("event_mappings", shopId)).toBe(0);
    expect(countRows("sync_logs", shopId)).toBe(0);
  });

  it("boundary: a shop revoked exactly at the grace period edge is purged (same age===window convention as sync log retention)", () => {
    const now = Date.now();
    const shopId = "shop-grace-boundary";
    setUpRevokedShop(shopId, now - graceMs());

    const purged = purgeExpiredUninstalledShops(now);

    expect(purged).toEqual([shopId]);
    expect(shopConnectionService.getConnection(shopId)).toBeUndefined();
  });

  it("does not touch a shop revoked inside the grace period", () => {
    const now = Date.now();
    const shopId = "shop-within-grace";
    setUpRevokedShop(shopId, now - DAY_MS);

    const purged = purgeExpiredUninstalledShops(now);

    expect(purged).toEqual([]);
    expect(shopConnectionService.getConnection(shopId)).toBeDefined();
    expect(settingsRepository.getMappings(shopId)).toHaveLength(1);
    expect(countRows("sync_logs", shopId)).toBe(1);
  });

  it("never touches a linked (never-uninstalled) shop, no matter how old", () => {
    const now = Date.now();
    const shopId = "shop-linked-forever";
    shopConnectionService.registerInstallation(shopId, `https://${shopId}.example.com`);
    shopConnectionService.markLinked(shopId, "workspace-1", "idoxxy-token");
    // Make it look ancient - only revoked_at/status should matter, not age.
    const ancient = now - 1000 * graceMs();
    db.prepare("UPDATE shop_connections SET created_at = ?, updated_at = ? WHERE shop_id = ?").run(
      ancient,
      ancient,
      shopId,
    );

    const purged = purgeExpiredUninstalledShops(now);

    expect(purged).toEqual([]);
    expect(shopConnectionService.getConnection(shopId)?.status).toBe("linked");
  });

  it("never deletes the __legacy__ sentinel, even if it somehow carries a revoked shop_connections row", () => {
    const now = Date.now();

    // __legacy__ normally has no shop_connections row at all (see
    // src/config/database.ts); this test forces one into existence to prove
    // the explicit shop_id != LEGACY_SHOP_ID guard in
    // purgeExpiredUninstalledShops works even in that abnormal case.
    db.prepare(
      `INSERT INTO shop_connections (shop_id, status, revoked_at, created_at, updated_at) VALUES (?, 'revoked', ?, ?, ?)`,
    ).run(LEGACY_SHOP_ID, now - graceMs() - DAY_MS, now, now);
    db.prepare(`INSERT INTO settings (shop_id, key, value, updated_at) VALUES (?, ?, ?, ?)`).run(
      LEGACY_SHOP_ID,
      "idoxxy_api_key",
      "legacy-value",
      now,
    );
    insertSyncLog(LEGACY_SHOP_ID, now - graceMs() - DAY_MS);

    const purged = purgeExpiredUninstalledShops(now);

    expect(purged).toEqual([]);
    expect(db.prepare("SELECT shop_id FROM shop_connections WHERE shop_id = ?").get(LEGACY_SHOP_ID)).toBeDefined();
    expect(countRows("settings", LEGACY_SHOP_ID)).toBe(1);
    // The sync log purge is unrelated/global and would still remove this row
    // via purgeExpiredSyncLogs - but purgeExpiredUninstalledShops alone must
    // never touch it.
    expect(countRows("sync_logs", LEGACY_SHOP_ID)).toBe(1);
  });

  it("reinstalling inside the grace window restores a usable connection with its mappings and default groups intact", () => {
    const now = Date.now();
    const shopId = "shop-reinstall-in-grace";
    setUpRevokedShop(shopId, now - DAY_MS); // revoked yesterday, well within the default 30-day grace

    expect(shopConnectionService.getConnection(shopId)?.status).toBe("revoked");

    const revived = shopConnectionService.registerInstallation(shopId, `https://${shopId}.example.com`);

    expect(revived.status).toBe("installed_not_linked");
    // Token was wiped on uninstall and is intentionally NOT restored by
    // reinstall - the merchant must paste it again.
    expect(revived.idoxxyTokenEncrypted).toBeUndefined();

    // But mappings and default groups survived the grace period untouched.
    expect(settingsRepository.getMappings(shopId)).toHaveLength(1);
    const snapshot = settingsRepository.getSnapshot(shopId);
    expect(snapshot.defaultGroupIds.registration).toEqual(["11111111-1111-1111-1111-111111111111"]);

    // And a subsequent purge run must NOT delete this shop - it is no longer
    // in "revoked" status.
    purgeExpiredUninstalledShops(now + graceMs() + DAY_MS);
    expect(shopConnectionService.getConnection(shopId)).toBeDefined();
  });
});
