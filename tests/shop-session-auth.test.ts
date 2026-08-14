import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import axios from "axios";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

import { createApp } from "../src/app";
import { userRepository } from "../src/repositories/userRepository";

/**
 * End-to-end HTTP tests for the shop-session trust boundary described in
 * AGENTS.md / the task brief: shopId may only ever enter req.session via a
 * verified Shoper OAuth exchange (src/routes/install.ts GET /oauth/callback,
 * or the install branch of src/routes/settings.ts GET /settings). Every
 * per-shop endpoint must require that session; every operator-only endpoint
 * must require an admin login (requireApiAuth); a shop session for one shop
 * must never be able to read or mutate another shop's data even when a
 * different shopId is supplied via query/body/URL; and every mutating
 * shop-session endpoint must enforce the double-submit CSRF token.
 *
 * No supertest available and no new dependency is allowed, so this drives
 * createApp() directly over node:http with a tiny cookie-jar fetch wrapper.
 */

let server: Server;
let baseUrl: string;

class Agent {
  private cookies = new Map<string, string>();

  constructor(private readonly base: string) {}

  private cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /** Raw value of a named cookie this agent currently holds (or undefined). */
  cookieValue(name: string): string | undefined {
    return this.cookies.get(name);
  }

  async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookieHeader = this.cookieHeader();
    if (cookieHeader) headers.set("Cookie", cookieHeader);

    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers,
      redirect: "manual",
    });

    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const cookie of setCookies) {
      const pair = cookie.split(";")[0];
      const eqIndex = pair?.indexOf("=") ?? -1;
      if (pair && eqIndex > 0) {
        this.cookies.set(pair.slice(0, eqIndex), pair.slice(eqIndex + 1));
      }
    }

    return res;
  }

  async json(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<{ status: number; body: any }> {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("Content-Type", "application/json");
    const res = await this.raw(path, {
      ...rest,
      headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }
}

let anon: Agent;
let shopA: Agent;
let shopB: Agent;
let adminAgent: Agent;

const SHOP_A_HOST = "shop-a.example-shoper.pl";
const SHOP_B_HOST = "shop-b.example-shoper.pl";
let shopAId: string;
let shopBId: string;

const oauthLogin = async (agent: Agent, host: string): Promise<string> => {
  const res = await agent.raw(
    `/oauth/callback?code=${encodeURIComponent(randomUUID())}&shop_url=${encodeURIComponent(host)}`,
  );
  expect(res.status).toBe(302);
  // shop id is derived by our axios.get mock below from the host's first label
  return host.split(".")[0]!;
};

beforeAll(async () => {
  // Mock only the two top-level axios calls install.ts makes directly
  // (token exchange + application-info/application-config lookups). Every
  // other axios usage in the app goes through IdoxxyClient's own
  // axios.create()'d instance, which this leaves untouched.
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

  const app = createApp();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  anon = new Agent(baseUrl);
  shopA = new Agent(baseUrl);
  shopB = new Agent(baseUrl);
  adminAgent = new Agent(baseUrl);

  shopAId = await oauthLogin(shopA, SHOP_A_HOST);
  shopBId = await oauthLogin(shopB, SHOP_B_HOST);

  await userRepository.createUser({
    username: "auth-test-admin",
    email: "auth-test-admin@example.com",
    password: "correct-horse-battery-staple",
    role: "admin",
  });
  const loginRes = await adminAgent.json("/auth/login", {
    method: "POST",
    json: { username: "auth-test-admin", password: "correct-horse-battery-staple" },
  });
  expect(loginRes.status).toBe(200);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("public endpoints stay reachable without any session", () => {
  it("GET /health", async () => {
    const res = await anon.json("/health");
    expect(res.status).toBe(200);
  });

  it("GET /settings serves the HTML shell", async () => {
    const res = await anon.raw("/settings");
    expect(res.status).toBe(200);
  });

  it("POST /webhooks/shoper/customer-created is reachable (not blocked by session auth)", async () => {
    const res = await anon.json("/webhooks/shoper/customer-created", {
      method: "POST",
      json: {},
    });
    // No SHOPER_WEBHOOK_SECRET configured in tests, so signature check is a
    // no-op; the request reaches the handler and fails for its own reasons
    // (missing shop id), never a 401/403 from our session/CSRF middleware.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

const SHOP_SESSION_PROTECTED: Array<{ method: string; path: string }> = [
  { method: "GET", path: "/settings/config" },
  { method: "GET", path: "/settings/groups" },
  { method: "GET", path: "/settings/documents" },
  { method: "GET", path: "/settings/test-connection" },
  { method: "GET", path: "/settings/csrf" },
  { method: "GET", path: "/settings/sync-logs" },
  { method: "GET", path: "/settings/sync-stats" },
  { method: "PUT", path: "/settings/credentials" },
  { method: "PUT", path: "/settings/default-groups" },
  { method: "PUT", path: "/settings/path-mappings" },
  { method: "POST", path: "/settings/mappings" },
  { method: "DELETE", path: "/settings/mappings/some-id" },
  { method: "POST", path: "/settings/link/test" },
  { method: "POST", path: "/settings/link" },
  { method: "GET", path: "/settings/link/status/some-id" },
  { method: "DELETE", path: "/settings/link/some-id" },

  { method: "GET", path: "/admin/idoxxy/settings/config" },
  { method: "GET", path: "/admin/idoxxy/settings/test-connection" },
  { method: "GET", path: "/admin/idoxxy/settings/groups" },
  { method: "GET", path: "/admin/idoxxy/settings/documents" },
  { method: "PUT", path: "/admin/idoxxy/settings/credentials" },
  { method: "PUT", path: "/admin/idoxxy/settings/default-groups" },
  { method: "POST", path: "/admin/idoxxy/settings/mappings" },
  { method: "DELETE", path: "/admin/idoxxy/settings/mappings/some-id" },
  { method: "GET", path: "/admin/idoxxy/settings" },
  { method: "PUT", path: "/admin/idoxxy/settings" },
  { method: "GET", path: "/admin/idoxxy/groups" },
  { method: "GET", path: "/admin/idoxxy/customers" },
  { method: "GET", path: "/admin/idoxxy/customers/some-id/groups" },
  { method: "PUT", path: "/admin/idoxxy/customers/some-id/groups" },
  { method: "POST", path: "/admin/idoxxy/customers/bulk-add-group" },
  { method: "POST", path: "/admin/idoxxy/customers/bulk" },
  { method: "GET", path: "/admin/idoxxy/debug/documents" },
  { method: "POST", path: "/admin/idoxxy/documents/some-doc/resend-notification" },

  { method: "GET", path: "/customers/some-customer/groups" },
  { method: "POST", path: "/customers/groups/some-group/customers/bulk" },
];

describe("shop-session-protected endpoints reject anonymous callers with 401", () => {
  for (const { method, path } of SHOP_SESSION_PROTECTED) {
    it(`${method} ${path}`, async () => {
      const res = await anon.json(path, { method, json: method === "GET" ? undefined : {} });
      expect(res.status).toBe(401);
      expect(res.body?.ok).toBe(false);
    });
  }
});

const OPERATOR_ONLY: Array<{ method: string; path: string }> = [
  { method: "GET", path: "/settings/link/connections" },
  { method: "GET", path: "/settings/recent-installs" },
  { method: "DELETE", path: "/settings/recent-installs/some-id" },
  { method: "GET", path: "/settings/test-shoper" },
];

describe("operator-only endpoints reject callers without an admin login", () => {
  for (const { method, path } of OPERATOR_ONLY) {
    it(`${method} ${path} - anonymous`, async () => {
      const res = await anon.json(path, { method });
      expect(res.status).toBe(401);
    });

    it(`${method} ${path} - a valid shop session is not enough`, async () => {
      const res = await shopA.json(path, { method });
      expect(res.status).toBe(401);
    });
  }

  it("GET /settings/link/connections succeeds for a logged-in admin", async () => {
    const res = await adminAgent.json("/settings/link/connections");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});

describe("cross-tenant isolation", () => {
  it("a shop session ignores a conflicting ?shopId= query param and returns only its own data", async () => {
    const groupA = randomUUID();
    const groupB = randomUUID();

    const csrfA = (await shopA.json("/settings/csrf")).body.csrfToken as string;
    const csrfB = (await shopB.json("/settings/csrf")).body.csrfToken as string;

    const saveA = await shopA.json("/settings/default-groups", {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfA },
      json: { fallbackRegistrationGroupIds: [groupA], fallbackOrderGroupIds: [] },
    });
    expect(saveA.status).toBe(200);

    const saveB = await shopB.json("/settings/default-groups", {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfB },
      json: { fallbackRegistrationGroupIds: [groupB], fallbackOrderGroupIds: [] },
    });
    expect(saveB.status).toBe(200);

    // Shop A tries to read shop B's config by supplying ?shopId=<shop B>.
    // The query param must be ignored for a non-operator session.
    const res = await shopA.json(`/settings/config?shopId=${encodeURIComponent(shopBId)}`);
    expect(res.status).toBe(200);
    expect(res.body.defaultGroupIds.registration).toEqual([groupA]);
    expect(res.body.defaultGroupIds.registration).not.toEqual([groupB]);
  });

  it("rejects a body shopId that disagrees with the session on POST /settings/link (403)", async () => {
    const csrfA = (await shopA.json("/settings/csrf")).body.csrfToken as string;

    const res = await shopA.json("/settings/link", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfA },
      json: { shopId: shopBId, token: "some-idoxxy-token" },
    });

    expect(res.status).toBe(403);
  });

  it("rejects a body shopId that disagrees with the session on POST /settings/link/test (403)", async () => {
    const csrfA = (await shopA.json("/settings/csrf")).body.csrfToken as string;

    const res = await shopA.json("/settings/link/test", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfA },
      json: { shopId: shopBId, token: "some-idoxxy-token" },
    });

    expect(res.status).toBe(403);
  });

  it("rejects a URL shopId that disagrees with the session on GET /settings/link/status/:shopId (403)", async () => {
    const res = await shopA.json(`/settings/link/status/${encodeURIComponent(shopBId)}`);
    expect(res.status).toBe(403);
  });

  it("rejects a URL shopId that disagrees with the session on DELETE /settings/link/:shopId (403)", async () => {
    const csrfA = (await shopA.json("/settings/csrf")).body.csrfToken as string;

    const res = await shopA.json(`/settings/link/${encodeURIComponent(shopBId)}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfA },
    });

    expect(res.status).toBe(403);
  });

  it("an admin operator may act on an explicitly selected shop via ?shopId=", async () => {
    const res = await adminAgent.json(`/settings/config?shopId=${encodeURIComponent(shopAId)}`);
    expect(res.status).toBe(200);
  });

  it("an admin operator without ?shopId= still gets 401 on a shop-session route", async () => {
    const res = await adminAgent.json("/settings/config");
    expect(res.status).toBe(401);
  });
});

describe("double-submit CSRF protection", () => {
  it("rejects a mutating request with no X-CSRF-Token header (403)", async () => {
    const res = await shopA.json("/settings/default-groups", {
      method: "PUT",
      json: { fallbackRegistrationGroupIds: [], fallbackOrderGroupIds: [] },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a mutating request with a wrong X-CSRF-Token header (403)", async () => {
    const res = await shopA.json("/settings/default-groups", {
      method: "PUT",
      headers: { "X-CSRF-Token": "totally-wrong-token" },
      json: { fallbackRegistrationGroupIds: [], fallbackOrderGroupIds: [] },
    });
    expect(res.status).toBe(403);
  });

  it("accepts a mutating request with the correct X-CSRF-Token header", async () => {
    const csrfRes = await shopA.json("/settings/csrf");
    expect(csrfRes.status).toBe(200);
    const csrfToken = csrfRes.body.csrfToken as string;
    expect(typeof csrfToken).toBe("string");
    expect(csrfToken.length).toBeGreaterThan(10);

    const res = await shopA.json("/settings/default-groups", {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      json: { fallbackRegistrationGroupIds: [], fallbackOrderGroupIds: [] },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("the 401 reauthorize hint", () => {
  it("is present when the failed request itself carries shop_url", async () => {
    const res = await anon.json(
      `/settings/config?shop_url=${encodeURIComponent("https://reauth-hint.example-shoper.pl/admin")}`,
    );
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.reauthorizeUrl).toBe(
      `/install?shop_url=${encodeURIComponent("reauth-hint.example-shoper.pl")}`,
    );
  });

  it("is absent when the failed request carries no shop_url (the normal XHR case)", async () => {
    const res = await anon.json("/settings/config");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.reauthorizeUrl).toBeUndefined();
  });
});

describe("session fixation defense on the OAuth entry points", () => {
  it("regenerates the session id across GET /oauth/callback", async () => {
    const agent = new Agent(baseUrl);
    const host = "fixation-test.example-shoper.pl";

    // First OAuth round-trip: no prior cookie, so there is nothing to fixate,
    // but this establishes a baseline session id to compare against.
    const firstShopId = await oauthLogin(agent, host);
    const cookieAfterFirstLogin = agent.cookieValue("shoper_idoxxy.sid");
    expect(cookieAfterFirstLogin).toBeTruthy();

    // Re-run the OAuth flow in the same agent/browser (e.g. the merchant
    // re-authorizes). If the pre-existing session were reused as-is instead
    // of regenerated, the cookie value would stay identical - which is
    // exactly what session fixation depends on.
    const secondShopId = await oauthLogin(agent, host);
    const cookieAfterSecondLogin = agent.cookieValue("shoper_idoxxy.sid");

    expect(secondShopId).toBe(firstShopId);
    expect(cookieAfterSecondLogin).toBeTruthy();
    expect(cookieAfterSecondLogin).not.toBe(cookieAfterFirstLogin);

    // The regenerated session still works end-to-end for its shop.
    const configRes = await agent.json("/settings/config");
    expect(configRes.status).toBe(200);
  });

  it("regenerates the session id across the settings.html install branch", async () => {
    const agent = new Agent(baseUrl);
    const host = "fixation-test-settings.example-shoper.pl";

    const firstRes = await agent.raw(
      `/settings?action=install&auth_code=${encodeURIComponent(randomUUID())}&shop_url=${encodeURIComponent(host)}`,
    );
    expect(firstRes.status).toBe(302);
    const cookieAfterFirstLogin = agent.cookieValue("shoper_idoxxy.sid");
    expect(cookieAfterFirstLogin).toBeTruthy();

    const secondRes = await agent.raw(
      `/settings?action=install&auth_code=${encodeURIComponent(randomUUID())}&shop_url=${encodeURIComponent(host)}`,
    );
    expect(secondRes.status).toBe(302);
    const cookieAfterSecondLogin = agent.cookieValue("shoper_idoxxy.sid");

    expect(cookieAfterSecondLogin).toBeTruthy();
    expect(cookieAfterSecondLogin).not.toBe(cookieAfterFirstLogin);
  });

  it("preserves an existing admin login across a shop OAuth in the same agent", async () => {
    const agent = new Agent(baseUrl);

    await userRepository.createUser({
      username: "fixation-test-admin",
      email: "fixation-test-admin@example.com",
      password: "correct-horse-battery-staple",
      role: "admin",
    });
    const loginRes = await agent.json("/auth/login", {
      method: "POST",
      json: { username: "fixation-test-admin", password: "correct-horse-battery-staple" },
    });
    expect(loginRes.status).toBe(200);

    const meBeforeOAuth = await agent.json("/auth/me");
    expect(meBeforeOAuth.status).toBe(200);
    expect(meBeforeOAuth.body.user.username).toBe("fixation-test-admin");

    const cookieBeforeOAuth = agent.cookieValue("shoper_idoxxy.sid");

    const host = "fixation-test-admin-shop.example-shoper.pl";
    const shopIdForOperator = await oauthLogin(agent, host);

    // The session id still changes (regenerate ran)...
    const cookieAfterOAuth = agent.cookieValue("shoper_idoxxy.sid");
    expect(cookieAfterOAuth).toBeTruthy();
    expect(cookieAfterOAuth).not.toBe(cookieBeforeOAuth);

    // ...but the admin login survives it.
    const meAfterOAuth = await agent.json("/auth/me");
    expect(meAfterOAuth.status).toBe(200);
    expect(meAfterOAuth.body.user.username).toBe("fixation-test-admin");

    // Because req.user is now set, this agent is an operator on shop-session
    // routes and must still supply ?shopId= explicitly (it does not silently
    // fall back to the shop id it just installed).
    const configWithoutShopId = await agent.json("/settings/config");
    expect(configWithoutShopId.status).toBe(401);

    const configWithShopId = await agent.json(
      `/settings/config?shopId=${encodeURIComponent(shopIdForOperator)}`,
    );
    expect(configWithShopId.status).toBe(200);
  });
});
