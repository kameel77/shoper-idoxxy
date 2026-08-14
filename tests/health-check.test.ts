import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Item 3 of the hardening task - GET /health must actually check the
 * database rather than unconditionally reporting healthy. Fresh module
 * graph + temp SQLite file per test (same pattern as
 * tests/appstore-callbacks.test.ts) so closing the db handle in the second
 * test can't affect any other test file.
 */

let server: Server;
let baseUrl: string;
let db: typeof import("../src/config/database").db;

beforeEach(async () => {
  vi.resetModules();
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `idoxxy-test-health-${randomUUID()}.db`);

  const { createApp } = await import("../src/app");
  ({ db } = await import("../src/config/database"));

  const app = createApp();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /health", () => {
  it("returns 200 { status: 'ok' } when the database is reachable", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 503 { status: 'error' } when the database is unreachable", async () => {
    db.close();

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "error" });
  });

  it("requires no authentication", async () => {
    // No cookies/session set up at all in this file - if this endpoint ever
    // grew an auth requirement, this test (not just a code review) would catch it.
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).not.toBe(401);
  });
});
