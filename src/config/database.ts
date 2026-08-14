import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import type { Database as DatabaseType } from "better-sqlite3";

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.db");

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db: DatabaseType = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma("journal_mode = WAL");

// Cached across calls in this process so that a legacy-shop resolution warning
// (see resolveLegacyShopId) is only ever logged once, even though initDatabase()
// runs on every module load and may migrate several tables in one pass.
let legacyShopIdCache: string | undefined;

/**
 * Check whether a column exists on a table using PRAGMA table_info.
 * Replaces the previous try/catch-swallow pattern around ALTER TABLE ADD COLUMN.
 */
const columnExists = (table: string, column: string): boolean => {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
};

const tableExists = (table: string): boolean => {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return Boolean(row);
};

/**
 * Determine which shop_id legacy (pre-multi-tenant) rows in settings/event_mappings/
 * sync_logs should be assigned to.
 *
 * If there is exactly one row in shop_connections we can safely assume the legacy
 * config belonged to that shop. Otherwise there is no safe automatic mapping, so we
 * assign the sentinel "__legacy__" and warn loudly that an operator must reassign
 * the data by hand.
 */
const resolveLegacyShopId = (): string => {
  if (legacyShopIdCache) {
    return legacyShopIdCache;
  }

  const rows = db.prepare("SELECT shop_id FROM shop_connections").all() as Array<{
    shop_id: string;
  }>;

  if (rows.length === 1 && rows[0]) {
    legacyShopIdCache = rows[0].shop_id;
    return legacyShopIdCache;
  }

  console.warn(
    `[Database] Cannot uniquely determine the owning shop for legacy settings/event_mappings/sync_logs rows (found ${rows.length} shop_connections) - assigned shop_id="__legacy__"; an operator must manually reassign this data to the correct shop.`,
  );
  legacyShopIdCache = "__legacy__";
  return legacyShopIdCache;
};

/**
 * Migrate the "settings" table to a per-shop schema where the primary key is the
 * composite (shop_id, key) instead of just (key). SQLite cannot alter an existing
 * primary key in place, so we create a new table, copy the data across (backfilling
 * shop_id for legacy rows), drop the old table and rename the new one into place.
 *
 * Idempotent: if the table already has a shop_id column (i.e. it was already
 * migrated, or this is a fresh install created directly with the new schema) this
 * is a no-op.
 */
const migrateSettingsTable = (): void => {
  if (!tableExists("settings")) {
    db.exec(`
      CREATE TABLE settings (
        shop_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (shop_id, key)
      )
    `);
    return;
  }

  if (columnExists("settings", "shop_id")) {
    // Already migrated on a previous initDatabase() run - nothing to do.
    return;
  }

  console.log("[Database] Migrating settings table to per-shop (shop_id, key) schema...");

  const legacyShopId = resolveLegacyShopId();

  const runMigration = db.transaction(() => {
    db.exec(`
      CREATE TABLE settings_new (
        shop_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (shop_id, key)
      )
    `);

    const legacyRows = db
      .prepare("SELECT key, value, updated_at FROM settings")
      .all() as Array<{ key: string; value: string; updated_at: number }>;

    const insertLegacyRow = db.prepare(
      "INSERT INTO settings_new (shop_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
    );
    for (const row of legacyRows) {
      insertLegacyRow.run(legacyShopId, row.key, row.value, row.updated_at);
    }

    db.exec("DROP TABLE settings");
    db.exec("ALTER TABLE settings_new RENAME TO settings");

    return legacyRows.length;
  });

  const migratedCount = runMigration();
  console.log(`[Database] Migrated ${migratedCount} legacy settings row(s) to shop_id="${legacyShopId}"`);
};

/**
 * Add a nullable shop_id column to `table` (if missing) via PRAGMA-checked ALTER
 * TABLE, then backfill any rows still missing shop_id (NULL or empty string) with
 * the resolved legacy shop id. Backfill only runs once: once every row has a
 * shop_id, subsequent calls find zero rows to update and skip the warning/UPDATE.
 */
const addShopIdColumnAndBackfill = (table: string): void => {
  if (!columnExists(table, "shop_id")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN shop_id TEXT`);
  }

  const { count } = db
    .prepare(`SELECT COUNT(*) as count FROM ${table} WHERE shop_id IS NULL OR shop_id = ''`)
    .get() as { count: number };

  if (count === 0) {
    return;
  }

  const legacyShopId = resolveLegacyShopId();
  db.prepare(`UPDATE ${table} SET shop_id = ? WHERE shop_id IS NULL OR shop_id = ''`).run(
    legacyShopId,
  );
  console.log(`[Database] Backfilled ${count} legacy row(s) in ${table} with shop_id="${legacyShopId}"`);
};

/**
 * Add the nullable shoper_license column (+ lookup index) to shop_connections
 * if missing. Holds Shoper's App Store "shop" identifier - a distinct value
 * from shop_id (see src/types/shopConnection.ts for why). Idempotent via the
 * same PRAGMA-checked columnExists() pattern as addShopIdColumnAndBackfill,
 * deliberately NOT the pre-existing try/catch-swallow pattern used above for
 * shoper_access_token/shoper_refresh_token.
 */
const addShoperLicenseColumn = (): void => {
  if (!columnExists("shop_connections", "shoper_license")) {
    db.exec(`ALTER TABLE shop_connections ADD COLUMN shoper_license TEXT`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_shop_connections_shoper_license ON shop_connections(shoper_license)`,
  );
};

/**
 * Add the nullable technical_url column to shop_connections if missing. Holds
 * the `technical_url` host Shoper's /webapi/rest/application-config response
 * returns alongside `shop_url` (see src/routes/install.ts and the install
 * branch of src/routes/settings.ts) - previously discarded. Used only to
 * narrow the CSP frame-ancestors directive per-response once both hosts are
 * known for a shop session (src/app.ts); never looked up by value, so no
 * index. Idempotent via the same PRAGMA-checked columnExists() pattern as
 * addShoperLicenseColumn.
 */
const addTechnicalUrlColumn = (): void => {
  if (!columnExists("shop_connections", "technical_url")) {
    db.exec(`ALTER TABLE shop_connections ADD COLUMN technical_url TEXT`);
  }
};

// Create tables
export const initDatabase = () => {
  // Shop connections table is created first: legacy-row backfill for the other
  // tables needs to inspect it to find a unique candidate shop.
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_connections (
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
      audit_metadata TEXT, -- JSON
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Add shoper token columns if they don't exist
  // NOTE: this try/catch pattern is pre-existing and out of scope for this change
  // (only settings/event_mappings/sync_logs were required to switch to PRAGMA checks).
  try {
    db.exec(`ALTER TABLE shop_connections ADD COLUMN shoper_access_token TEXT`);
  } catch (err) {
    // Ignore error if column already exists
  }

  try {
    db.exec(`ALTER TABLE shop_connections ADD COLUMN shoper_refresh_token TEXT`);
  } catch (err) {
    // Ignore error if column already exists
  }

  addShoperLicenseColumn();
  addTechnicalUrlColumn();

  // Settings table - migrated to composite (shop_id, key) primary key
  migrateSettingsTable();

  // Event mappings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_mappings (
      id TEXT PRIMARY KEY,
      shop_id TEXT,
      name TEXT NOT NULL,
      event TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      target_group_ids TEXT NOT NULL, -- JSON array
      document_id TEXT,
      enabled INTEGER DEFAULT 1,
      conditions TEXT NOT NULL, -- JSON array
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  addShopIdColumnAndBackfill("event_mappings");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_mappings_shop_id ON event_mappings(shop_id)`);

  // Sync logs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_logs (
      id TEXT PRIMARY KEY,
      shop_id TEXT,
      timestamp INTEGER NOT NULL,
      event TEXT NOT NULL,
      source TEXT NOT NULL,
      customer_id TEXT,
      customer_email TEXT,
      order_id TEXT,
      shoper_customer_id TEXT,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      details TEXT NOT NULL, -- JSON
      duration_ms INTEGER
    )
  `);
  addShopIdColumnAndBackfill("sync_logs");
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sync_logs_shop_id_timestamp ON sync_logs(shop_id, timestamp DESC)`,
  );

  // Users table for admin authentication
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      is_active INTEGER DEFAULT 1,
      last_login_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // express-session store (see src/services/sessionStore.ts SqliteSessionStore).
  // Replaces the default in-memory MemoryStore, which express-session itself
  // documents as unfit for production (leaks memory, drops every session on
  // restart/redeploy, doesn't scale past one process). `data` is the
  // JSON-serialized express-session SessionData (the same shape MemoryStore
  // would hold in memory); `expires_at` is an epoch-ms cutoff derived from
  // the session cookie's maxAge/expires, used both to reject an expired
  // session on read and to sweep expired rows periodically.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)`);

  console.log("[Database] Initialized successfully");
};

// Initialize on module load
initDatabase();
