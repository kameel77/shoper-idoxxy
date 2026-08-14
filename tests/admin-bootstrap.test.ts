import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Coverage for the operator/admin account bootstrap (Item 1 of the task
 * brief): src/repositories/userRepository.ts's bootstrapAdminAccount(),
 * wired into src/app.ts's createApp(). Every case here needs its own
 * production-vs-development env AND its own SQLite file, so each test gets a
 * fresh module graph (vi.resetModules()) - same pattern as
 * tests/token-decrypt-failure.test.ts and tests/appstore-callbacks.test.ts.
 *
 * The ADMIN_PASSWORD length/presence fail-fast checks themselves (pure env.ts
 * validation, no DB involved) are covered in tests/env-failfast.test.ts;
 * this file covers everything that needs an actual database and/or an actual
 * HTTP login round-trip.
 */

const makeTempPath = (label: string) => path.join(os.tmpdir(), `idoxxy-test-admin-${label}-${randomUUID()}.db`);

const cleanupSqliteFiles = (dbPath: string) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
};

const VALID_PRODUCTION_SECRETS = {
  SESSION_SECRET: "s".repeat(40),
  SHOPER_WEBHOOK_SECRET: "w".repeat(40),
  SHOPER_APPSTORE_SECRET: "appstore-secret",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

const createdPaths: string[] = [];

afterEach(() => {
  for (const p of createdPaths.splice(0)) {
    cleanupSqliteFiles(p);
  }
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
});

describe("bootstrapAdminAccount - account creation", () => {
  it("creates a working account from ADMIN_USERNAME/ADMIN_PASSWORD that can log in via POST /auth/login", async () => {
    const dbPath = makeTempPath("login");
    createdPaths.push(dbPath);

    vi.resetModules();
    process.env.NODE_ENV = "production";
    process.env.DATABASE_PATH = dbPath;
    process.env.ADMIN_USERNAME = "shop-owner";
    process.env.ADMIN_PASSWORD = "correct-horse-battery-staple";
    Object.assign(process.env, VALID_PRODUCTION_SECRETS);

    const { createApp } = await import("../src/app");
    const app = createApp();
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "shop-owner", password: "correct-horse-battery-staple" }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.user.username).toBe("shop-owner");
      expect(body.user.role).toBe("admin");

      // Wrong password still fails - this isn't a magic bypass.
      const wrongRes = await fetch(`http://127.0.0.1:${port}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "shop-owner", password: "not-the-password" }),
      });
      expect(wrongRes.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not overwrite an already-existing account's password on boot", async () => {
    const dbPath = makeTempPath("no-overwrite");
    createdPaths.push(dbPath);

    // Stage 1 (development): create the admin account with an operator-chosen
    // password, different from ADMIN_PASSWORD used in stage 2.
    vi.resetModules();
    process.env.NODE_ENV = "development";
    process.env.DATABASE_PATH = dbPath;
    process.env.ADMIN_USERNAME = "admin";
    delete process.env.ADMIN_PASSWORD;
    const stage1 = await import("../src/repositories/userRepository");
    await stage1.userRepository.createUser({
      username: "admin",
      email: "admin@shoper-idoxxy.local",
      password: "the-operator-already-changed-this",
      role: "admin",
    });
    const stage1Db = await import("../src/config/database");
    stage1Db.db.close();

    // Stage 2 (production): boot with a *different* ADMIN_PASSWORD. The
    // existing account must be left exactly as-is.
    vi.resetModules();
    process.env.NODE_ENV = "production";
    process.env.DATABASE_PATH = dbPath;
    process.env.ADMIN_USERNAME = "admin";
    process.env.ADMIN_PASSWORD = "a-totally-different-password-1234";
    Object.assign(process.env, VALID_PRODUCTION_SECRETS);

    const { createApp } = await import("../src/app");
    expect(() => createApp()).not.toThrow();

    const stage2 = await import("../src/repositories/userRepository");
    const user = stage2.userRepository.getByUsername("admin")!;
    expect(user).toBeTruthy();

    const matchesOperatorPassword = await stage2.userRepository.validatePassword(
      user,
      "the-operator-already-changed-this",
    );
    const matchesBootPassword = await stage2.userRepository.validatePassword(
      user,
      "a-totally-different-password-1234",
    );
    expect(matchesOperatorPassword).toBe(true);
    expect(matchesBootPassword).toBe(false);
  });
});

describe("bootstrapAdminAccount - legacy default-password guard (production only)", () => {
  it("rotates the password of an existing active admin account still holding the historic default password, and boots", async () => {
    const dbPath = makeTempPath("legacy");
    createdPaths.push(dbPath);

    // Stage 1 (development): seed a pre-existing admin account exactly as the
    // old hardcoded bootstrap used to (username "admin", password "admin123"),
    // simulating a deployment carried over from before this change.
    vi.resetModules();
    process.env.NODE_ENV = "development";
    process.env.DATABASE_PATH = dbPath;
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
    const stage1 = await import("../src/repositories/userRepository");
    await stage1.userRepository.createUser({
      username: "admin",
      email: "admin@shoper-idoxxy.local",
      password: "admin123",
      role: "admin",
    });
    const stage1Db = await import("../src/config/database");
    stage1Db.db.close();

    // Stage 2 (production): with a strong ADMIN_PASSWORD configured, startup
    // must succeed and the *existing* weak account must be rotated onto that
    // configured password - a config change alone previously did not fix an
    // already-provisioned account, and refusing to boot here left the
    // operator with no in-band way to fix it either.
    vi.resetModules();
    process.env.NODE_ENV = "production";
    process.env.DATABASE_PATH = dbPath;
    process.env.ADMIN_PASSWORD = "a-brand-new-strong-password-here";
    Object.assign(process.env, VALID_PRODUCTION_SECRETS);

    const { createApp } = await import("../src/app");
    const app = createApp();
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const rotatedRes = await fetch(`http://127.0.0.1:${port}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "a-brand-new-strong-password-here" }),
      });
      const rotatedBody = await rotatedRes.json();
      expect(rotatedRes.status).toBe(200);
      expect(rotatedBody.ok).toBe(true);
      expect(rotatedBody.user.username).toBe("admin");

      const legacyRes = await fetch(`http://127.0.0.1:${port}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "admin123" }),
      });
      expect(legacyRes.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const stage2 = await import("../src/config/database");
    stage2.db.close();
  });

  it("rotates every active admin still holding the legacy default password, not just ADMIN_USERNAME", async () => {
    const dbPath = makeTempPath("legacy-multi");
    createdPaths.push(dbPath);

    vi.resetModules();
    process.env.NODE_ENV = "development";
    process.env.DATABASE_PATH = dbPath;
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
    const stage1 = await import("../src/repositories/userRepository");
    await stage1.userRepository.createUser({
      username: "admin",
      email: "admin@shoper-idoxxy.local",
      password: "admin123",
      role: "admin",
    });
    await stage1.userRepository.createUser({
      username: "second-admin",
      email: "second-admin@shoper-idoxxy.local",
      password: "admin123",
      role: "admin",
    });
    const stage1Db = await import("../src/config/database");
    stage1Db.db.close();

    vi.resetModules();
    process.env.NODE_ENV = "production";
    process.env.DATABASE_PATH = dbPath;
    process.env.ADMIN_PASSWORD = "a-brand-new-strong-password-here";
    Object.assign(process.env, VALID_PRODUCTION_SECRETS);

    const { createApp } = await import("../src/app");
    expect(() => createApp()).not.toThrow();

    const stage2 = await import("../src/repositories/userRepository");
    const first = stage2.userRepository.getByUsername("admin")!;
    const second = stage2.userRepository.getByUsername("second-admin")!;

    expect(await stage2.userRepository.validatePassword(first, "a-brand-new-strong-password-here")).toBe(true);
    expect(await stage2.userRepository.validatePassword(first, "admin123")).toBe(false);
    expect(await stage2.userRepository.validatePassword(second, "a-brand-new-strong-password-here")).toBe(true);
    expect(await stage2.userRepository.validatePassword(second, "admin123")).toBe(false);

    const stage2Db = await import("../src/config/database");
    stage2Db.db.close();
  });

  it("never touches an admin account with a strong, non-default password, even when it differs from ADMIN_PASSWORD", async () => {
    const dbPath = makeTempPath("legacy-untouched");
    createdPaths.push(dbPath);

    vi.resetModules();
    process.env.NODE_ENV = "development";
    process.env.DATABASE_PATH = dbPath;
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
    const stage1 = await import("../src/repositories/userRepository");
    const created = await stage1.userRepository.createUser({
      username: "careful-admin",
      email: "careful-admin@shoper-idoxxy.local",
      password: "already-a-strong-operator-chosen-password",
      role: "admin",
    });
    const hashBeforeBoot = created.passwordHash;
    const stage1Db = await import("../src/config/database");
    stage1Db.db.close();

    vi.resetModules();
    process.env.NODE_ENV = "production";
    process.env.DATABASE_PATH = dbPath;
    process.env.ADMIN_PASSWORD = "a-totally-different-strong-password-1234";
    Object.assign(process.env, VALID_PRODUCTION_SECRETS);

    const { createApp } = await import("../src/app");
    expect(() => createApp()).not.toThrow();

    const stage2 = await import("../src/repositories/userRepository");
    const user = stage2.userRepository.getByUsername("careful-admin")!;
    expect(user.passwordHash).toBe(hashBeforeBoot);
    expect(await stage2.userRepository.validatePassword(user, "already-a-strong-operator-chosen-password")).toBe(true);
    expect(await stage2.userRepository.validatePassword(user, "a-totally-different-strong-password-1234")).toBe(false);

    const stage2Db = await import("../src/config/database");
    stage2Db.db.close();
  });

  it("boots normally in production when the existing admin account's password has been changed", async () => {
    const dbPath = makeTempPath("legacy-fixed");
    createdPaths.push(dbPath);

    vi.resetModules();
    process.env.NODE_ENV = "development";
    process.env.DATABASE_PATH = dbPath;
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
    const stage1 = await import("../src/repositories/userRepository");
    const created = await stage1.userRepository.createUser({
      username: "admin",
      email: "admin@shoper-idoxxy.local",
      password: "admin123",
      role: "admin",
    });
    // Operator changes the password before the production deploy.
    await stage1.userRepository.updatePassword(created.id, "a-freshly-rotated-strong-password");
    const stage1Db = await import("../src/config/database");
    stage1Db.db.close();

    vi.resetModules();
    process.env.NODE_ENV = "production";
    process.env.DATABASE_PATH = dbPath;
    process.env.ADMIN_PASSWORD = "irrelevant-because-account-exists-1234";
    Object.assign(process.env, VALID_PRODUCTION_SECRETS);

    const { createApp } = await import("../src/app");
    expect(() => createApp()).not.toThrow();

    const stage2 = await import("../src/config/database");
    stage2.db.close();
  });

  it("an inactive (deactivated) legacy-password admin account does not block startup", async () => {
    const dbPath = makeTempPath("legacy-inactive");
    createdPaths.push(dbPath);

    vi.resetModules();
    process.env.NODE_ENV = "development";
    process.env.DATABASE_PATH = dbPath;
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
    const stage1 = await import("../src/repositories/userRepository");
    await stage1.userRepository.createUser({
      username: "old-admin",
      email: "old-admin@shoper-idoxxy.local",
      password: "admin123",
      role: "admin",
    });
    const stage1Db = await import("../src/config/database");
    // Deactivate directly (no repository method for this - matches how the
    // rest of the app treats is_active).
    stage1Db.db.prepare("UPDATE users SET is_active = 0 WHERE username = ?").run("old-admin");
    stage1Db.db.close();

    vi.resetModules();
    process.env.NODE_ENV = "production";
    process.env.DATABASE_PATH = dbPath;
    process.env.ADMIN_USERNAME = "new-admin";
    process.env.ADMIN_PASSWORD = "a-brand-new-strong-password-here";
    Object.assign(process.env, VALID_PRODUCTION_SECRETS);

    const { createApp } = await import("../src/app");
    expect(() => createApp()).not.toThrow();

    const stage2 = await import("../src/config/database");
    stage2.db.close();
  });
});

describe("no code path logs a password", () => {
  it("never logs the configured ADMIN_PASSWORD, the dev fallback password, or the literal legacy password", async () => {
    const dbPath = makeTempPath("no-log");
    createdPaths.push(dbPath);
    const secretPassword = "never-print-me-anywhere-9876543210";

    vi.resetModules();
    process.env.NODE_ENV = "production";
    process.env.DATABASE_PATH = dbPath;
    process.env.ADMIN_USERNAME = "admin";
    process.env.ADMIN_PASSWORD = secretPassword;
    Object.assign(process.env, VALID_PRODUCTION_SECRETS);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { createApp } = await import("../src/app");
    expect(() => createApp()).not.toThrow();

    const allLoggedText = JSON.stringify(
      [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].flat(),
    );
    expect(allLoggedText).not.toContain(secretPassword);
    expect(allLoggedText).not.toContain("admin123");

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();

    const dbModule = await import("../src/config/database");
    dbModule.db.close();
  });

  it("never logs the old or new password when rotating a legacy-default admin account", async () => {
    const dbPath = makeTempPath("no-log-rotation");
    createdPaths.push(dbPath);
    const rotatedToPassword = "rotated-in-strong-password-1234567890";

    vi.resetModules();
    process.env.NODE_ENV = "development";
    process.env.DATABASE_PATH = dbPath;
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
    const stage1 = await import("../src/repositories/userRepository");
    await stage1.userRepository.createUser({
      username: "admin",
      email: "admin@shoper-idoxxy.local",
      password: "admin123",
      role: "admin",
    });
    const stage1Db = await import("../src/config/database");
    stage1Db.db.close();

    vi.resetModules();
    process.env.NODE_ENV = "production";
    process.env.DATABASE_PATH = dbPath;
    process.env.ADMIN_PASSWORD = rotatedToPassword;
    Object.assign(process.env, VALID_PRODUCTION_SECRETS);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { createApp } = await import("../src/app");
    expect(() => createApp()).not.toThrow();

    const allLoggedText = JSON.stringify(
      [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].flat(),
    );
    expect(allLoggedText).not.toContain(rotatedToPassword);
    expect(allLoggedText).not.toContain("admin123");
    // The rotation notice itself must still be present (username, not password).
    expect(allLoggedText).toMatch(/admin/);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();

    const dbModule = await import("../src/config/database");
    dbModule.db.close();
  });

  it("never logs the dev-only fallback password when bootstrapping outside production", async () => {
    const dbPath = makeTempPath("no-log-dev");
    createdPaths.push(dbPath);

    vi.resetModules();
    process.env.NODE_ENV = "development";
    process.env.DATABASE_PATH = dbPath;
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { createApp } = await import("../src/app");
    expect(() => createApp()).not.toThrow();

    const allLoggedText = JSON.stringify([...logSpy.mock.calls, ...warnSpy.mock.calls].flat());
    expect(allLoggedText).not.toContain("admin123");

    logSpy.mockRestore();
    warnSpy.mockRestore();

    const dbModule = await import("../src/config/database");
    dbModule.db.close();
  });
});
