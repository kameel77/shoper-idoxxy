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

  // Add shoper token columns if they don't exist
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

  console.log("[Database] Initialized successfully");
};

// Initialize on module load
initDatabase();
