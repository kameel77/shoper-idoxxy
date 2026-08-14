import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import axios from "axios";
import type session from "express-session";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Coverage for Item 2 of the task brief: the SQLite-backed express-session
 * store (src/services/sessionStore.ts) that replaces the default MemoryStore.
 *
 * Sessions are the trust boundary for shop identity in this app, so this
 * covers both the store's raw Store-interface contract (get/set/destroy/touch
 * against a temp SQLite file, same isolation pattern as
 * tests/token-decrypt-failure.test.ts) AND an end-to-end check that a real
 * shop session, established the normal way through HTTP, is still readable -
 * and still authorises a shop-scoped route - via a brand-new store instance
 * reading the same on-disk table. That end-to-end angle is the whole point:
 * MemoryStore could never survive that (it is a plain in-process Map), which
 * is exactly the production defect this replaces.
 */

const makeTempPath = (label: string) =>
  path.join(os.tmpdir(), `idoxxy-test-session-store-${label}-${randomUUID()}.db`);

const cleanupSqliteFiles = (dbPath: string) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
};

const createdPaths: string[] = [];

afterEach(() => {
  for (const p of createdPaths.splice(0)) {
    cleanupSqliteFiles(p);
  }
});

// ---------------------------------------------------------------------------
// Unit-level: exercise the Store interface directly against a temp DB.
// ---------------------------------------------------------------------------

describe("SqliteSessionStore - unit", () => {
  let SqliteSessionStore: typeof import("../src/services/sessionStore").SqliteSessionStore;
  let sweepExpiredSessions: typeof import("../src/services/sessionStore").sweepExpiredSessions;
  let db: typeof import("../src/config/database").db;

  beforeEach(async () => {
    vi.resetModules();
    const dbPath = makeTempPath("unit");
    createdPaths.push(dbPath);
    process.env.DATABASE_PATH = dbPath;
    ({ SqliteSessionStore, sweepExpiredSessions } = await import("../src/services/sessionStore"));
    ({ db } = await import("../src/config/database"));
  });

  // A live Session/Cookie-shaped object is what express-session actually
  // hands set()/touch() at runtime (see src/services/sessionStore.ts's doc
  // comment on resolveExpiresAt) - a plain object with the same `cookie.maxAge`
  // shape is sufficient here since our store only ever reads that property.
  const fakeSessionData = (
    data: Record<string, unknown>,
    maxAgeMs: number,
  ): session.SessionData =>
    ({
      cookie: { maxAge: maxAgeMs, originalMaxAge: maxAgeMs, httpOnly: true, path: "/" },
      ...data,
    }) as unknown as session.SessionData;

  const getAsync = (
    store: InstanceType<typeof SqliteSessionStore>,
    sid: string,
  ): Promise<session.SessionData | null | undefined> =>
    new Promise((resolve, reject) => {
      store.get(sid, (err, sess) => (err ? reject(err) : resolve(sess)));
    });

  const setAsync = (
    store: InstanceType<typeof SqliteSessionStore>,
    sid: string,
    data: session.SessionData,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      store.set(sid, data, (err) => (err ? reject(err) : resolve()));
    });

  const destroyAsync = (store: InstanceType<typeof SqliteSessionStore>, sid: string): Promise<void> =>
    new Promise((resolve, reject) => {
      store.destroy(sid, (err) => (err ? reject(err) : resolve()));
    });

  const touchAsync = (
    store: InstanceType<typeof SqliteSessionStore>,
    sid: string,
    data: session.SessionData,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      store.touch(sid, data, (err) => (err ? reject(err) : resolve()));
    });

  it("round-trips set/get", async () => {
    const store = new SqliteSessionStore();
    await setAsync(store, "sid-roundtrip", fakeSessionData({ shopId: "shop-1" }, 60_000));

    const got = await getAsync(store, "sid-roundtrip");
    expect(got).toMatchObject({ shopId: "shop-1" });
  });

  it("get() resolves undefined (does not throw) for a sid that was never set", async () => {
    const store = new SqliteSessionStore();
    await expect(getAsync(store, "never-existed")).resolves.toBeUndefined();
  });

  it("does not return an expired session (and lazily sweeps the row on read)", async () => {
    const store = new SqliteSessionStore();
    await setAsync(store, "sid-expired", fakeSessionData({ shopId: "shop-expired" }, -1_000));

    const got = await getAsync(store, "sid-expired");
    expect(got).toBeUndefined();

    const row = db.prepare("SELECT 1 FROM sessions WHERE sid = ?").get("sid-expired");
    expect(row).toBeUndefined();
  });

  it("the periodic sweep removes an expired row that was never read", async () => {
    const store = new SqliteSessionStore();
    await setAsync(store, "sid-swept", fakeSessionData({ shopId: "shop-swept" }, -1_000));

    // Row exists pre-sweep (bypassing get(), which would lazily delete it).
    expect(db.prepare("SELECT 1 FROM sessions WHERE sid = ?").get("sid-swept")).toBeTruthy();

    const removed = sweepExpiredSessions(Date.now());
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(db.prepare("SELECT 1 FROM sessions WHERE sid = ?").get("sid-swept")).toBeUndefined();
  });

  it("a session that has not expired is unaffected by the sweep", async () => {
    const store = new SqliteSessionStore();
    await setAsync(store, "sid-alive", fakeSessionData({ shopId: "shop-alive" }, 60_000));

    sweepExpiredSessions(Date.now());

    const got = await getAsync(store, "sid-alive");
    expect(got).toMatchObject({ shopId: "shop-alive" });
  });

  it("destroy removes the session", async () => {
    const store = new SqliteSessionStore();
    await setAsync(store, "sid-destroy", fakeSessionData({ shopId: "shop-destroy" }, 60_000));

    await destroyAsync(store, "sid-destroy");

    await expect(getAsync(store, "sid-destroy")).resolves.toBeUndefined();
  });

  it("touch extends expiry without clobbering shopId or other session data", async () => {
    const store = new SqliteSessionStore();
    await setAsync(
      store,
      "sid-touch",
      fakeSessionData({ shopId: "shop-touch", csrfToken: "csrf-abc" }, 1_000),
    );
    const before = db
      .prepare("SELECT expires_at FROM sessions WHERE sid = ?")
      .get("sid-touch") as { expires_at: number };

    await touchAsync(
      store,
      "sid-touch",
      fakeSessionData({ shopId: "shop-touch", csrfToken: "csrf-abc" }, 24 * 60 * 60 * 1000),
    );

    const after = db
      .prepare("SELECT data, expires_at FROM sessions WHERE sid = ?")
      .get("sid-touch") as { data: string; expires_at: number };
    expect(after.expires_at).toBeGreaterThan(before.expires_at);

    const parsed = JSON.parse(after.data);
    expect(parsed.shopId).toBe("shop-touch");
    expect(parsed.csrfToken).toBe("csrf-abc");
  });

  it("touch falls back to a full upsert if the row was already reclaimed (never drops the session)", async () => {
    const store = new SqliteSessionStore();
    // No prior set() - simulates the row having expired and been swept
    // between requests, which must not silently lose the session.
    await touchAsync(store, "sid-recovered", fakeSessionData({ shopId: "shop-recovered" }, 60_000));

    const got = await getAsync(store, "sid-recovered");
    expect(got).toMatchObject({ shopId: "shop-recovered" });
  });

  it("set() upserts - a second set for the same sid replaces the data", async () => {
    const store = new SqliteSessionStore();
    await setAsync(store, "sid-upsert", fakeSessionData({ shopId: "shop-a" }, 60_000));
    await setAsync(store, "sid-upsert", fakeSessionData({ shopId: "shop-b" }, 60_000));

    const got = await getAsync(store, "sid-upsert");
    expect(got).toMatchObject({ shopId: "shop-b" });
    expect((got as Record<string, unknown>).shopId).not.toBe("shop-a");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a real shop session, established through the normal Shoper
// OAuth flow over HTTP, must still authorise a shop-scoped route when read
// back via a brand-new SqliteSessionStore instance - i.e. it survives
// independently of any single Express app/process's in-memory state.
// ---------------------------------------------------------------------------

describe("SqliteSessionStore - end to end", () => {
  let server: Server | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("a shop session survives a fresh store instance reading the same on-disk table", async () => {
    const dbPath = makeTempPath("e2e");
    createdPaths.push(dbPath);

    vi.resetModules();
    process.env.DATABASE_PATH = dbPath;

    vi.spyOn(axios, "post").mockImplementation(async (url: unknown) => {
      if (typeof url === "string" && url.includes("/webapi/rest/oauth/token")) {
        return {
          data: {
            access_token: `access-${randomUUID()}`,
            refresh_token: `refresh-${randomUUID()}`,
            token_type: "bearer",
          },
        };
      }
      throw new Error(`Unexpected axios.post to ${String(url)} in test`);
    });
    vi.spyOn(axios, "get").mockImplementation(async (url: unknown) => {
      if (typeof url === "string" && url.includes("/webapi/rest/application-info")) {
        const host = new URL(url).host;
        return { data: { shop_id: host.split(".")[0] } };
      }
      if (typeof url === "string" && url.includes("/webapi/rest/application-config")) {
        return { data: {} };
      }
      throw new Error(`Unexpected axios.get to ${String(url)} in test`);
    });

    const { createApp } = await import("../src/app");

    // "Instance 1": establish the shop session the normal way.
    const app1 = createApp();
    server = createServer(app1);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const address1 = server.address() as AddressInfo;
    const baseUrl1 = `http://127.0.0.1:${address1.port}`;

    const oauthRes = await fetch(
      `${baseUrl1}/oauth/callback?code=${encodeURIComponent(randomUUID())}&shop_url=${encodeURIComponent("session-store-e2e.example-shoper.pl")}`,
      { redirect: "manual" },
    );
    expect(oauthRes.status).toBe(302);

    const setCookieHeaders = oauthRes.headers.getSetCookie
      ? oauthRes.headers.getSetCookie()
      : [oauthRes.headers.get("set-cookie") ?? ""];
    const sessionCookiePair = setCookieHeaders
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith("shoper_idoxxy.sid="));
    expect(sessionCookiePair).toBeTruthy();

    // Sanity check on instance 1 before moving on.
    const configOnInstance1 = await fetch(`${baseUrl1}/settings/config`, {
      headers: { Cookie: sessionCookiePair! },
    });
    expect(configOnInstance1.status).toBe(200);

    await new Promise<void>((resolve) => server!.close(() => resolve()));

    // "Instance 2": a brand-new app (and therefore a brand-new
    // SqliteSessionStore instance, wired up fresh inside createApp()) reading
    // the SAME sessions table on disk. If this were still MemoryStore, this
    // session would already be gone - that's the defect this replaces.
    const app2 = createApp();
    server = createServer(app2);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const address2 = server.address() as AddressInfo;
    const baseUrl2 = `http://127.0.0.1:${address2.port}`;

    const configOnInstance2 = await fetch(`${baseUrl2}/settings/config`, {
      headers: { Cookie: sessionCookiePair! },
    });
    expect(configOnInstance2.status).toBe(200);
    const body = await configOnInstance2.json();
    expect(body.ok).not.toBe(false);
  });
});
