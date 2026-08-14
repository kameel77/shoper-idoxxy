import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, it, expect, vi, afterEach } from "vitest";

const makeTempPath = () => path.join(os.tmpdir(), `idoxxy-test-migration-${randomUUID()}.db`);

const cleanupSqliteFiles = (dbPath: string) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
};

describe("Database migration", () => {
  const createdPaths: string[] = [];

  afterEach(() => {
    for (const p of createdPaths.splice(0)) {
      cleanupSqliteFiles(p);
    }
  });

  it("migrates a legacy single-shop database, backfilling shop_id, and is idempotent", async () => {
    const dbPath = makeTempPath();
    createdPaths.push(dbPath);

    // Hand-build a pre-migration ("legacy") database matching the old schema.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    legacy.exec(`
      CREATE TABLE event_mappings (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        event TEXT NOT NULL,
        priority INTEGER DEFAULT 0,
        target_group_ids TEXT NOT NULL,
        document_id TEXT,
        enabled INTEGER DEFAULT 1,
        conditions TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    legacy.exec(`
      CREATE TABLE sync_logs (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        event TEXT NOT NULL,
        source TEXT NOT NULL,
        customer_id TEXT,
        customer_email TEXT,
        order_id TEXT,
        shoper_customer_id TEXT,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        details TEXT NOT NULL,
        duration_ms INTEGER
      )
    `);
    legacy.exec(`
      CREATE TABLE shop_connections (
        shop_id TEXT PRIMARY KEY,
        shop_url TEXT,
        idoxxy_base_url TEXT,
        idoxxy_workspace_id TEXT,
        idoxxy_token_encrypted TEXT,
        status TEXT NOT NULL,
        token_last_verified_at INTEGER,
        revoked_at INTEGER,
        revoked_by TEXT,
        last_error TEXT,
        last_sync_at INTEGER,
        last_sync_status TEXT,
        audit_metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    const now = Date.now();
    legacy
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run("idoxxy_api_key", "legacy-secret-key", now);
    legacy
      .prepare(
        `INSERT INTO event_mappings (id, name, event, priority, target_group_ids, document_id, enabled, conditions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("mapping-1", "Legacy mapping", "customer.created", 0, "[]", null, 1, "[]", now, now);
    legacy
      .prepare(
        `INSERT INTO sync_logs (id, timestamp, event, source, action, status, details)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("log-1", now, "customer.created", "webhook", "sync-customer", "success", "{}");
    legacy
      .prepare("INSERT INTO shop_connections (shop_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("shop-only", "linked", now, now);
    legacy.close();

    vi.resetModules();
    process.env.DATABASE_PATH = dbPath;
    const { initDatabase, db } = await import("../src/config/database");

    try {
      // Migration already ran once as a side effect of the module load above.
      const settingsCols = db.prepare("PRAGMA table_info(settings)").all() as Array<{ name: string }>;
      expect(settingsCols.map((c) => c.name).sort()).toEqual(["key", "shop_id", "updated_at", "value"].sort());

      const settingRow = db
        .prepare("SELECT shop_id, value FROM settings WHERE key = ?")
        .get("idoxxy_api_key") as { shop_id: string; value: string };
      expect(settingRow.shop_id).toBe("shop-only");
      expect(settingRow.value).toBe("legacy-secret-key");

      const mappingRow = db
        .prepare("SELECT shop_id FROM event_mappings WHERE id = ?")
        .get("mapping-1") as { shop_id: string };
      expect(mappingRow.shop_id).toBe("shop-only");

      const logRow = db.prepare("SELECT shop_id FROM sync_logs WHERE id = ?").get("log-1") as {
        shop_id: string;
      };
      expect(logRow.shop_id).toBe("shop-only");

      // Running initDatabase() again must be a no-op and must not error, duplicate
      // rows, or lose data - even though the schema is now NOT NULL/composite-PK.
      expect(() => initDatabase()).not.toThrow();

      const settingsCount = (db.prepare("SELECT COUNT(*) as count FROM settings").get() as {
        count: number;
      }).count;
      expect(settingsCount).toBe(1);

      const settingRowAfter = db
        .prepare("SELECT shop_id, value FROM settings WHERE key = ?")
        .get("idoxxy_api_key") as { shop_id: string; value: string };
      expect(settingRowAfter).toEqual(settingRow);

      const mappingCount = (db.prepare("SELECT COUNT(*) as count FROM event_mappings").get() as {
        count: number;
      }).count;
      expect(mappingCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("assigns the __legacy__ sentinel and warns when the shop cannot be uniquely determined", async () => {
    const dbPath = makeTempPath();
    createdPaths.push(dbPath);

    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    legacy.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run("k", "v", Date.now());
    // Zero shop_connections rows -> ambiguous, must fall back to "__legacy__".
    legacy.close();

    vi.resetModules();
    process.env.DATABASE_PATH = dbPath;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { db } = await import("../src/config/database");
    try {
      const row = db.prepare("SELECT shop_id FROM settings WHERE key = ?").get("k") as { shop_id: string };
      expect(row.shop_id).toBe("__legacy__");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      db.close();
    }
  });

  it("creates a fresh database directly with the final per-shop schema (no legacy rows)", async () => {
    const dbPath = makeTempPath();
    createdPaths.push(dbPath);

    vi.resetModules();
    process.env.DATABASE_PATH = dbPath;
    const { db } = await import("../src/config/database");

    try {
      const settingsCols = db.prepare("PRAGMA table_info(settings)").all() as Array<{
        name: string;
        pk: number;
      }>;
      const shopIdCol = settingsCols.find((c) => c.name === "shop_id");
      const keyCol = settingsCols.find((c) => c.name === "key");
      expect(shopIdCol?.pk).toBeGreaterThan(0);
      expect(keyCol?.pk).toBeGreaterThan(0);

      const eventMappingsCols = db.prepare("PRAGMA table_info(event_mappings)").all() as Array<{
        name: string;
      }>;
      expect(eventMappingsCols.some((c) => c.name === "shop_id")).toBe(true);

      const indexes = db.prepare("PRAGMA index_list(event_mappings)").all() as Array<{ name: string }>;
      expect(indexes.some((idx) => idx.name === "idx_event_mappings_shop_id")).toBe(true);

      const syncLogIndexes = db.prepare("PRAGMA index_list(sync_logs)").all() as Array<{ name: string }>;
      expect(syncLogIndexes.some((idx) => idx.name === "idx_sync_logs_shop_id_timestamp")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("adds the shoper_license column (+ index) to shop_connections, and is idempotent", async () => {
    const dbPath = makeTempPath();
    createdPaths.push(dbPath);

    // Hand-build a pre-migration shop_connections table without shoper_license,
    // matching a database created before this column existed.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE shop_connections (
        shop_id TEXT PRIMARY KEY,
        shop_url TEXT,
        idoxxy_base_url TEXT,
        idoxxy_workspace_id TEXT,
        idoxxy_token_encrypted TEXT,
        shoper_access_token TEXT,
        shoper_refresh_token TEXT,
        status TEXT NOT NULL,
        token_last_verified_at INTEGER,
        revoked_at INTEGER,
        revoked_by TEXT,
        last_error TEXT,
        last_sync_at INTEGER,
        last_sync_status TEXT,
        audit_metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    const now = Date.now();
    legacy
      .prepare("INSERT INTO shop_connections (shop_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("shop-pre-license-column", "linked", now, now);
    legacy.close();

    vi.resetModules();
    process.env.DATABASE_PATH = dbPath;
    const { initDatabase, db } = await import("../src/config/database");

    try {
      const cols = db.prepare("PRAGMA table_info(shop_connections)").all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "shoper_license")).toBe(true);

      const indexes = db.prepare("PRAGMA index_list(shop_connections)").all() as Array<{ name: string }>;
      expect(indexes.some((idx) => idx.name === "idx_shop_connections_shoper_license")).toBe(true);

      // Pre-existing row is untouched (nullable column added, not backfilled).
      const row = db
        .prepare("SELECT shoper_license FROM shop_connections WHERE shop_id = ?")
        .get("shop-pre-license-column") as { shoper_license: string | null };
      expect(row.shoper_license).toBeNull();

      // Re-running initDatabase() (e.g. a second process boot) must not throw
      // or duplicate the column/index.
      expect(() => initDatabase()).not.toThrow();
      expect(() => initDatabase()).not.toThrow();

      const colsAfter = db.prepare("PRAGMA table_info(shop_connections)").all() as Array<{ name: string }>;
      expect(colsAfter.filter((c) => c.name === "shoper_license")).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
