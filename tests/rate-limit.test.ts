import { createServer, type Server } from "node:http";

import express from "express";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { createApp } from "../src/app";
import { createRateLimiter } from "../src/middleware/rateLimit";

/**
 * Item 4 of the hardening task - in-memory rate limiting. Uses the module
 * graph tests/setup.ts already establishes (single shared DATABASE_PATH for
 * this whole file), same as most other test files - the login limiter's
 * bucket state is per-process (module-level Map in
 * src/middleware/rateLimit.ts), so a single server/app instance for the
 * whole file is what actually exercises the limiter across repeated
 * requests.
 */

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const login = (password: string) =>
  fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  });

describe("POST /auth/login rate limiting", () => {
  it("allows the first several attempts through (each answering 401 for a wrong password, not 429)", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login(`wrong-password-${i}`);
      expect(res.status).toBe(401);
    }
  });

  it("eventually responds 429 with a Retry-After header once the per-IP limit is exceeded", async () => {
    // The 5 requests above already count against this same IP's window (the
    // limiter is process-global, keyed by IP - see src/middleware/rateLimit.ts).
    // LOGIN_RATE_LIMIT_OPTIONS.max is 10, so a further handful of attempts is
    // guaranteed to cross it.
    let sawLimitResponse = false;
    let res: Response | undefined;
    for (let i = 0; i < 10; i++) {
      res = await login(`another-wrong-password-${i}`);
      if (res.status === 429) {
        sawLimitResponse = true;
        break;
      }
    }

    expect(sawLimitResponse).toBe(true);
    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toBeTruthy();
    const body = await res!.json();
    expect(body).toEqual({ ok: false, error: expect.any(String) });
    // Polish message.
    expect(body.error).toMatch(/prób|logowania|później/);
  });
});

/**
 * createRateLimiter's "silent-ok" mode (used only for App Store lifecycle/
 * billing callbacks - see APPSTORE_CALLBACK_RATE_LIMIT_OPTIONS) exercised
 * directly against small, test-local limits rather than the real production
 * constants (600/min - too many requests to usefully exercise in a unit
 * test). Confirms the never-429 design decision documented in
 * src/middleware/rateLimit.ts: Shoper requires HTTP 200 on these endpoints
 * unconditionally and retries failed messages with escalating backoff, so a
 * tripped limiter must still answer 200, not compound the problem with a 429.
 */
describe("createRateLimiter", () => {
  const buildApp = (limiter: ReturnType<typeof createRateLimiter>) => {
    const app = express();
    app.get("/probe", limiter, (_req, res) => res.status(200).send("handler-ran"));
    return app;
  };

  it("'block' mode: responds 429 with Retry-After once max is exceeded, and never calls the handler", async () => {
    const limiter = createRateLimiter({
      name: `test-block-${Math.random()}`,
      windowMs: 60_000,
      max: 2,
      mode: "block",
      message: "za dużo",
    });
    const app = buildApp(limiter);
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    try {
      expect((await fetch(`${base}/probe`)).status).toBe(200);
      expect((await fetch(`${base}/probe`)).status).toBe(200);
      const third = await fetch(`${base}/probe`);
      expect(third.status).toBe(429);
      expect(third.headers.get("Retry-After")).toBeTruthy();
      expect(await third.text()).not.toContain("handler-ran");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("'silent-ok' mode: responds 200 'OK' (never 429) once max is exceeded, and never calls the handler", async () => {
    const limiter = createRateLimiter({
      name: `test-silent-ok-${Math.random()}`,
      windowMs: 60_000,
      max: 2,
      mode: "silent-ok",
    });
    const app = buildApp(limiter);
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    try {
      expect((await fetch(`${base}/probe`)).status).toBe(200);
      expect((await fetch(`${base}/probe`)).status).toBe(200);
      const third = await fetch(`${base}/probe`);
      expect(third.status).toBe(200);
      const text = await third.text();
      expect(text).toBe("OK");
      expect(text).not.toContain("handler-ran");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
