// Vitest global setup, run before each test file's own imports.
//
// Every test file gets its own isolated module registry (vitest's default
// `isolate: true`), so pointing DATABASE_PATH at a fresh temp file here - before
// the test file statically imports src/config/database.ts - guarantees tests
// never touch data/app.db and never leak state between test files.
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_PATH = path.join(os.tmpdir(), `idoxxy-test-${randomUUID()}.db`);
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-at-least-32-characters-long";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
// Needed by tests that drive the real Shoper OAuth exchange (src/routes/install.ts,
// the install branch of src/routes/settings.ts) against a mocked axios.
process.env.SHOPER_CLIENT_ID = process.env.SHOPER_CLIENT_ID || "test-shoper-client-id";
process.env.SHOPER_CLIENT_SECRET = process.env.SHOPER_CLIENT_SECRET || "test-shoper-client-secret";
// Defaults for the token-encryption defect (see src/config/env.ts,
// src/services/tokenCrypto.ts) - a fixed key keeps test runs deterministic.
// Deliberately NOT setting SHOPER_WEBHOOK_SECRET or SHOPER_APPSTORE_SECRET
// here: tests/shop-session-auth.test.ts's "public endpoints stay reachable"
// case specifically relies on SHOPER_WEBHOOK_SECRET being unset (signature
// check is a no-op) so an unsigned webhook reaches the handler and fails for
// its own reasons rather than via signature/session middleware. Tests that
// need either secret configured set it locally via vi.resetModules() + a
// dynamic import, same pattern as DATABASE_PATH above.
process.env.TOKEN_ENCRYPTION_KEY =
  process.env.TOKEN_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString("base64");
