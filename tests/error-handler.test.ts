import { describe, it, expect } from "vitest";
import express, { type Request, type Response } from "express";
import { createServer, type Server } from "node:http";

import { errorHandler } from "../src/middleware/errorHandler";

/**
 * Unit coverage for the global error handler (Item 2 of the hardening task -
 * "no global error handler"). Deliberately built against a minimal
 * standalone Express app (not src/app.ts's createApp()) so it exercises
 * exactly errorHandler's own contract: always respond with the app's
 * standard { ok:false, error } shape, honour err.statusCode, never leak a
 * stack/message/secret, and leave normal 404s alone.
 */

const buildTestApp = () => {
  const app = express();

  app.get("/boom-default", () => {
    throw new Error("leaked internal detail: SELECT * FROM shop_connections; token=super-secret");
  });

  app.get("/boom-with-status", () => {
    const err = Object.assign(new Error("not found, sort of"), { statusCode: 428 });
    throw err;
  });

  app.get("/async-boom", async () => {
    // Express 5 auto-forwards a rejected async handler's promise to next(err) -
    // this is exactly the shape src/routes/webhooks.ts's handlers use (throw
    // after logging, no catch of their own).
    throw new Error("async explosion");
  });

  app.use(errorHandler);

  return app;
};

const withServer = async (fn: (baseUrl: string) => Promise<void>) => {
  const app = buildTestApp();
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

describe("errorHandler", () => {
  it("responds 500 with the standard { ok:false, error } shape for an error with no statusCode", async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/boom-default`);
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body).toEqual({
        ok: false,
        error: expect.any(String),
      });
    });
  });

  it("never leaks the underlying error message, a stack trace, or embedded secrets/SQL", async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/boom-default`);
      const text = await res.text();

      expect(text).not.toContain("SELECT");
      expect(text).not.toContain("super-secret");
      expect(text).not.toContain("leaked internal detail");
      expect(text).not.toContain(" at "); // crude stack-trace-line marker
      expect(text).not.toContain(".ts:");
    });
  });

  it("responds with a Polish user-facing message", async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/boom-default`);
      const body = await res.json();
      // Polish diacritics or at least a recognisably-Polish phrase - loose
      // assertion since the exact wording isn't a contract, but it must not
      // be English/empty.
      expect(body.error.length).toBeGreaterThan(0);
      expect(body.error).toMatch(/błąd|Błąd/);
    });
  });

  it("honours err.statusCode when the thrower set one", async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/boom-with-status`);
      expect(res.status).toBe(428);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });
  });

  it("catches an error thrown from an async handler (the pattern webhooks.ts uses)", async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/async-boom`);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });
  });

  it("does not turn an ordinary 404 (unmatched route) into a JSON error blob", async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/this-route-does-not-exist`);
      expect(res.status).toBe(404);
      // Express's default 404 handler - not our errorHandler, which is never
      // invoked for an unmatched route (no thrown/forwarded error occurred).
      const contentType = res.headers.get("content-type") ?? "";
      expect(contentType).not.toContain("application/json");
    });
  });
});
