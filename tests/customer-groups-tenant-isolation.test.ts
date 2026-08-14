import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import axios from "axios";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

import { createApp } from "../src/app";
import { shopConnectionService } from "../src/services/shopConnectionService";

/**
 * End-to-end coverage for the cross-tenant leak fixed in
 * src/routes/customerGroups.ts / src/services/customerGroupsService.ts /
 * src/services/customerGroupsCache.ts:
 *
 *  1. The per-shop iDoxxy client used by /customers/* must be the calling
 *     shop's own (resolveShopClient(req)), never a platform-wide default.
 *  2. A shop with a valid session but no linked iDoxxy token gets 428, not
 *     500 (idoxxyService.getClientForShop's statusCode propagation).
 *  3. The customerGroups cache must not serve shop A's cached data for a
 *     customer id to shop B asking about "the same" id.
 *  4. Bulk assignment must invalidate only the calling shop's cache entries.
 *
 * Same harness shape as tests/shop-session-auth.test.ts (no supertest, no
 * new dependency): createApp() driven directly over node:http with a tiny
 * cookie-jar fetch wrapper. In addition to that file's axios.post/get mocks
 * (for the OAuth token exchange install.ts performs directly), this file
 * also stubs axios.create - the factory IdoxxyClient uses for its own HTTP
 * instance - so requests toward "iDoxxy" can be inspected without any real
 * network access, and so a fake per-token backend can return different data
 * per shop.
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

  async csrfToken(): Promise<string> {
    const res = await this.json("/settings/csrf");
    expect(res.status).toBe(200);
    return res.body.csrfToken as string;
  }
}

let anon: Agent;
let shopA: Agent;
let shopB: Agent;
let shopC: Agent; // installed but never linked to iDoxxy

const SHOP_A_HOST = "tenant-a.example-shoper.pl";
const SHOP_B_HOST = "tenant-b.example-shoper.pl";
const SHOP_C_HOST = "tenant-c.example-shoper.pl";

const SHOP_A_TOKEN = "idoxxy-token-shop-a";
const SHOP_B_TOKEN = "idoxxy-token-shop-b";

let shopAId: string;
let shopBId: string;

// Every request IdoxxyClient makes through its axios instance ends up here,
// so tests can assert which shop's token actually went out over the wire.
type CapturedRequest = {
  method?: string;
  url?: string;
  apiKey?: string;
  params?: any;
  data?: any;
};
let capturedRequests: CapturedRequest[] = [];

// Fake per-tenant iDoxxy backend, keyed by the X-API-KEY (the shop's linked
// token) the request carries - mirrors the real API scoping every group/
// customer lookup to the caller's own workspace.
const backendGroupsByToken = new Map<string, Map<string, Array<{ id: string; groupName: string }>>>();

const backendFor = (token: string | undefined) => {
  if (!token) return new Map<string, Array<{ id: string; groupName: string }>>();
  let groups = backendGroupsByToken.get(token);
  if (!groups) {
    groups = new Map();
    backendGroupsByToken.set(token, groups);
  }
  return groups;
};

const oauthLogin = async (agent: Agent, host: string): Promise<string> => {
  const res = await agent.raw(
    `/oauth/callback?code=${encodeURIComponent(randomUUID())}&shop_url=${encodeURIComponent(host)}`,
  );
  expect(res.status).toBe(302);
  return host.split(".")[0]!;
};

beforeAll(async () => {
  // Same narrow axios.post/get mocks as tests/shop-session-auth.test.ts, for
  // install.ts's direct OAuth token exchange + application-info/-config
  // lookups. IdoxxyClient never uses these - it builds its own instance via
  // axios.create(), stubbed separately below.
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

  // Stub the axios instance IdoxxyClient builds for itself
  // (axios.create(...)) so every "iDoxxy API" call is captured and answered
  // by the fake per-token backend above, with no real network access.
  vi.spyOn(axios, "create").mockImplementation((config?: any) => {
    const instance: any = {
      defaults: { ...(config ?? {}) },
      interceptors: {
        request: { use: () => 0 },
        response: { use: () => 0 },
      },
      request: vi.fn(async (reqConfig: any) => {
        const method = (reqConfig.method ?? "get").toLowerCase();
        const url: string = reqConfig.url ?? "";
        const apiKey = reqConfig.headers?.["X-API-KEY"];

        capturedRequests.push({
          method,
          url,
          apiKey,
          params: reqConfig.params,
          data: reqConfig.data,
        });

        if (method === "get" && url === "/groups/list-customers-with-groups") {
          const customerId = reqConfig.params?.searchQuery;
          const backend = backendFor(apiKey);
          let content: any[] = [];
          if (customerId) {
            const groups = backend.get(customerId) ?? [];
            content = [{ id: customerId, email: `${customerId}@example.com`, customerGroups: groups }];
          } else {
            content = Array.from(backend.entries()).map(([cId, groups]) => ({
              id: cId,
              email: `${cId}@example.com`,
              customerGroups: groups,
            }));
          }
          return { data: { content, totalPages: 1, last: true }, status: 200, config: reqConfig, headers: {} };
        }

        if (method === "get" && /^\/groups\/[^/]+$/.test(url)) {
          return { data: { id: url.split("/")[2], groupName: "Mock Group", customers: [] }, status: 200, config: reqConfig, headers: {} };
        }

        if (method === "put" && /^\/groups\//.test(url)) {
          return { data: { ok: true }, status: 200, config: reqConfig, headers: {} };
        }

        throw new Error(`Unexpected fake iDoxxy request in test: ${method} ${url}`);
      }),
    };
    return instance;
  });

  const app = createApp();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  anon = new Agent(baseUrl);
  shopA = new Agent(baseUrl);
  shopB = new Agent(baseUrl);
  shopC = new Agent(baseUrl);

  shopAId = await oauthLogin(shopA, SHOP_A_HOST);
  shopBId = await oauthLogin(shopB, SHOP_B_HOST);
  await oauthLogin(shopC, SHOP_C_HOST);

  // Link A and B to iDoxxy with distinct tokens (shop C is deliberately left
  // "installed_not_linked" for the 428 case). Using shopConnectionService
  // directly, same pattern as tests/webhooks.test.ts, rather than driving
  // the /settings/link HTTP flow.
  shopConnectionService.saveLink({
    shopId: shopAId,
    token: SHOP_A_TOKEN,
    status: "linked",
    tokenLastVerifiedAt: Date.now(),
    shopUrl: undefined,
    idoxxyWorkspaceId: undefined,
    idoxxyBaseUrl: undefined,
  });
  shopConnectionService.saveLink({
    shopId: shopBId,
    token: SHOP_B_TOKEN,
    status: "linked",
    tokenLastVerifiedAt: Date.now(),
    shopUrl: undefined,
    idoxxyWorkspaceId: undefined,
    idoxxyBaseUrl: undefined,
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /customers/:customerId/groups is scoped to the calling shop's own iDoxxy token", () => {
  it("shop A's request goes out with shop A's token and shop B's with shop B's", async () => {
    const customerId = randomUUID();
    const groupIdA = randomUUID();
    const groupIdB = randomUUID();

    backendFor(SHOP_A_TOKEN).set(customerId, [{ id: groupIdA, groupName: "Grupa A" }]);
    backendFor(SHOP_B_TOKEN).set(customerId, [{ id: groupIdB, groupName: "Grupa B" }]);

    const resA = await shopA.json(`/customers/${customerId}/groups`);
    expect(resA.status).toBe(200);
    expect(resA.body).toEqual({ ok: true, groups: [{ id: groupIdA, groupName: "Grupa A" }] });

    const resB = await shopB.json(`/customers/${customerId}/groups`);
    expect(resB.status).toBe(200);
    expect(resB.body).toEqual({ ok: true, groups: [{ id: groupIdB, groupName: "Grupa B" }] });

    const requestsForCustomer = capturedRequests.filter(
      (r) => r.url === "/groups/list-customers-with-groups" && r.params?.searchQuery === customerId,
    );
    expect(requestsForCustomer.map((r) => r.apiKey).sort()).toEqual(
      [SHOP_A_TOKEN, SHOP_B_TOKEN].sort(),
    );
  });

  it("a shop with a valid session but no linked iDoxxy token gets 428, not 500", async () => {
    const res = await shopC.json(`/customers/${randomUUID()}/groups`);
    expect(res.status).toBe(428);
    expect(res.body?.ok).toBe(false);
  });
});

describe("the customer-groups cache does not leak across shops", () => {
  it("shop A populating the cache for a customer id does not affect what shop B receives for the same id", async () => {
    const customerId = randomUUID();
    const groupIdA = randomUUID();
    const groupIdB = randomUUID();

    backendFor(SHOP_A_TOKEN).set(customerId, [{ id: groupIdA, groupName: "A-only group" }]);
    backendFor(SHOP_B_TOKEN).set(customerId, [{ id: groupIdB, groupName: "B-only group" }]);

    // Shop A fetches first, populating (if the cache were unscoped) an entry
    // keyed only on customerId.
    const resA = await shopA.json(`/customers/${customerId}/groups`);
    expect(resA.status).toBe(200);
    expect(resA.body.groups).toEqual([{ id: groupIdA, groupName: "A-only group" }]);

    // Shop B must still see its own data, not shop A's cached entry.
    const resB = await shopB.json(`/customers/${customerId}/groups`);
    expect(resB.status).toBe(200);
    expect(resB.body.groups).toEqual([{ id: groupIdB, groupName: "B-only group" }]);

    const requestsForCustomer = capturedRequests.filter(
      (r) => r.url === "/groups/list-customers-with-groups" && r.params?.searchQuery === customerId,
    );
    // Both shops had to make their own outbound call - shop B was never
    // satisfied out of shop A's cache entry.
    expect(requestsForCustomer).toHaveLength(2);
    expect(requestsForCustomer.map((r) => r.apiKey).sort()).toEqual(
      [SHOP_A_TOKEN, SHOP_B_TOKEN].sort(),
    );
  });
});

describe("POST /customers/groups/:groupId/customers/bulk invalidates only the calling shop's cache", () => {
  it("shop A's bulk assignment invalidates shop A's cache entry but leaves shop B's untouched", async () => {
    const customerId = randomUUID();
    const groupId = randomUUID();
    const groupIdA = randomUUID();
    const groupIdB = randomUUID();

    backendFor(SHOP_A_TOKEN).set(customerId, [{ id: groupIdA, groupName: "A group" }]);
    backendFor(SHOP_B_TOKEN).set(customerId, [{ id: groupIdB, groupName: "B group" }]);

    // Prime both shops' caches for the same customer id.
    await shopA.json(`/customers/${customerId}/groups`);
    await shopB.json(`/customers/${customerId}/groups`);

    const countRequests = () =>
      capturedRequests.filter(
        (r) => r.url === "/groups/list-customers-with-groups" && r.params?.searchQuery === customerId,
      ).length;

    expect(countRequests()).toBe(2);

    // Shop A performs a bulk assignment that includes this customer id.
    const csrfToken = await shopA.csrfToken();
    const bulkRes = await shopA.json(`/customers/groups/${groupId}/customers/bulk`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      json: { customerIds: [customerId] },
    });
    expect(bulkRes.status).toBe(200);
    expect(bulkRes.body.ok).toBe(true);

    // Shop A's next read must hit iDoxxy again (its cache entry was
    // invalidated) ...
    const resAAfter = await shopA.json(`/customers/${customerId}/groups`);
    expect(resAAfter.status).toBe(200);
    expect(countRequests()).toBe(3);

    // ... but shop B's cache entry for the same customer id must be
    // untouched: no new outbound request, and its own data is still served.
    const resBAfter = await shopB.json(`/customers/${customerId}/groups`);
    expect(resBAfter.status).toBe(200);
    expect(resBAfter.body.groups).toEqual([{ id: groupIdB, groupName: "B group" }]);
    expect(countRequests()).toBe(3);
  });
});
