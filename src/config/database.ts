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

// Create tables
export const initDatabase = () => {
  // Settings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Event mappings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_mappings (
      id TEXT PRIMARY KEY,
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

  // Sync logs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_logs (
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
      details TEXT NOT NULL, -- JSON
      duration_ms INTEGER
    )
  `);

  // Shop connections table
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

  // Insert default settings if not exists
  const defaultSettings = [
    { key: "idoxxy_base_url", value: "https://api.idoxxy.com" },
    { key: "fallback_registration_groups", value: "[]" },
    { key: "fallback_order_groups", value: "[]" },
    { key: "path_mappings", value: "[]" },
  ];

  const insertStmt = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)"
  );

  for (const setting of defaultSettings) {
    insertStmt.run(setting.key, setting.value, Date.now());
  }

  console.log("[Database] Initialized successfully");
};

// Initialize on module load
initDatabase();
