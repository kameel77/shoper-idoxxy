import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * src/config/env.ts throws synchronously at module-load time when required
 * production secrets are missing/invalid, so every case here dynamically
 * imports a fresh copy of the module (vi.resetModules()) after setting up
 * process.env, and asserts the import itself rejects.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const importEnvFresh = async () => {
  const { vi } = await import("vitest");
  vi.resetModules();
  return import("../src/config/env");
};

// Shared by every "boots successfully in production" / non-ADMIN_PASSWORD
// fail-fast case below so each test only needs to override what it's
// actually exercising.
const setValidProductionEnv = () => {
  process.env.NODE_ENV = "production";
  process.env.SESSION_SECRET = "a".repeat(40);
  process.env.SHOPER_WEBHOOK_SECRET = "b".repeat(40);
  process.env.SHOPER_APPSTORE_SECRET = "appstore-secret";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
  process.env.ADMIN_PASSWORD = "c".repeat(20);
};

describe("production fail-fast checks", () => {
  it("refuses to start without SHOPER_WEBHOOK_SECRET", async () => {
    setValidProductionEnv();
    delete process.env.SHOPER_WEBHOOK_SECRET;

    await expect(importEnvFresh()).rejects.toThrow(/SHOPER_WEBHOOK_SECRET/);
  });

  it("refuses to start when SHOPER_WEBHOOK_SECRET is shorter than 32 characters", async () => {
    setValidProductionEnv();
    process.env.SHOPER_WEBHOOK_SECRET = "too-short";

    await expect(importEnvFresh()).rejects.toThrow(/SHOPER_WEBHOOK_SECRET/);
  });

  it("refuses to start without SHOPER_APPSTORE_SECRET", async () => {
    setValidProductionEnv();
    delete process.env.SHOPER_APPSTORE_SECRET;

    await expect(importEnvFresh()).rejects.toThrow(/SHOPER_APPSTORE_SECRET/);
  });

  it("refuses to start without TOKEN_ENCRYPTION_KEY", async () => {
    setValidProductionEnv();
    delete process.env.TOKEN_ENCRYPTION_KEY;

    await expect(importEnvFresh()).rejects.toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("refuses to start when TOKEN_ENCRYPTION_KEY does not decode to exactly 32 bytes", async () => {
    setValidProductionEnv();
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");

    await expect(importEnvFresh()).rejects.toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("refuses to start without ADMIN_PASSWORD", async () => {
    setValidProductionEnv();
    delete process.env.ADMIN_PASSWORD;

    await expect(importEnvFresh()).rejects.toThrow(/ADMIN_PASSWORD/);
  });

  it("refuses to start when ADMIN_PASSWORD is shorter than 16 characters", async () => {
    setValidProductionEnv();
    process.env.ADMIN_PASSWORD = "short-password";

    await expect(importEnvFresh()).rejects.toThrow(/ADMIN_PASSWORD/);
  });

  it("boots successfully in production when all required secrets are valid", async () => {
    setValidProductionEnv();

    const mod = await importEnvFresh();
    expect(mod.isProduction).toBe(true);
    expect(mod.tokenEncryptionKey).toHaveLength(32);
    expect(mod.env.ADMIN_PASSWORD).toBe("c".repeat(20));
  });
});

describe("GDPR retention env validation (src/services/dataRetentionService.ts)", () => {
  it("rejects SYNC_LOG_RETENTION_DAYS=0 rather than interpreting it as delete-everything", async () => {
    process.env.NODE_ENV = "development";
    process.env.SYNC_LOG_RETENTION_DAYS = "0";

    await expect(importEnvFresh()).rejects.toThrow();
  });

  it("defaults SYNC_LOG_RETENTION_DAYS to 90 when unset", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.SYNC_LOG_RETENTION_DAYS;

    const mod = await importEnvFresh();
    expect(mod.env.SYNC_LOG_RETENTION_DAYS).toBe(90);
  });

  it("rejects UNINSTALL_PURGE_GRACE_DAYS=0", async () => {
    process.env.NODE_ENV = "development";
    process.env.UNINSTALL_PURGE_GRACE_DAYS = "0";

    await expect(importEnvFresh()).rejects.toThrow();
  });

  it("defaults UNINSTALL_PURGE_GRACE_DAYS to 30 when unset", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.UNINSTALL_PURGE_GRACE_DAYS;

    const mod = await importEnvFresh();
    expect(mod.env.UNINSTALL_PURGE_GRACE_DAYS).toBe(30);
  });
});

describe("non-production: missing optional secrets do not prevent startup", () => {
  it("derives an ephemeral TOKEN_ENCRYPTION_KEY and boots when none is configured", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.SHOPER_WEBHOOK_SECRET;
    delete process.env.SHOPER_APPSTORE_SECRET;
    delete process.env.TOKEN_ENCRYPTION_KEY;

    const mod = await importEnvFresh();
    expect(mod.isProduction).toBe(false);
    expect(mod.tokenEncryptionKey).toHaveLength(32);
  });
});
