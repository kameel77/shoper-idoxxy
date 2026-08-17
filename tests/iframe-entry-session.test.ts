import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import axios from "axios";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * End-to-end coverage for the third shop-session trust boundary entry point:
 * Shoper's signed iframe entry (GET /settings with admin-hash/hash-signed
 * query params - see src/middleware/shoperSignature.ts's
 * verifyIframeEntrySignature and the "Third trusted way to establish a shop
 * session" block in src/routes/settings.ts).
 *
 * Fresh module graph + temp SQLite file per test, same pattern as
 * tests/appstore-callbacks.test.ts, so SHOPER_APPSTORE_SECRET can be
 * configured without affecting other test files.
 */

let server: Server;
let baseUrl: string;
let shopConnectionService: typeof import("../src/services/shopConnectionService").shopConnectionService;
let computeAppStoreCallbackHash: typeof import("../src/middleware/shoperSignature").computeAppStoreCallbackHash;

const APPSTORE_SECRET = "e2e-test-appstore-secret-for-iframe-entry";

class Agent {
  private cookies = new Map<string, string>();

  constructor(private readonly base: string) {}

  private cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async raw(reqPath: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookieHeader = this.cookieHeader();
    if (cookieHeader) headers.set("Cookie", cookieHeader);

    const res = await fetch(`${this.base}${reqPath}`, {
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

  async json(reqPath: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
    const res = await this.raw(reqPath, init);
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

beforeEach(async () => {
  vi.resetModules();
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `idoxxy-test-iframe-entry-${randomUUID()}.db`);
  process.env.SHOPER_APPSTORE_SECRET = APPSTORE_SECRET;

  // Mock the two top-level axios calls the OAuth install branches make
  // directly, same as tests/shop-session-auth.test.ts.
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
  ({ shopConnectionService } = await import("../src/services/shopConnectionService"));
  ({ computeAppStoreCallbackHash } = await import("../src/middleware/shoperSignature"));

  const app = createApp();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.SHOPER_APPSTORE_SECRET;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const NOW_SECONDS = () => Math.floor(Date.now() / 1000);

const signAdminHash = (fields: {
  adminId: string;
  adminName: string;
  place: string;
  shop: string;
  timestamp: string;
}): string =>
  computeAppStoreCallbackHash(APPSTORE_SECRET, {
    "admin-id": fields.adminId,
    "admin-name": fields.adminName,
    place: fields.place,
    shop: fields.shop,
    timestamp: fields.timestamp,
  });

const signLegacyHash = (fields: { place: string; shop: string; timestamp: string }): string =>
  computeAppStoreCallbackHash(APPSTORE_SECRET, {
    place: fields.place,
    shop: fields.shop,
    timestamp: fields.timestamp,
  });

const iframeUrl = (params: Record<string, string>): string => {
  const qs = new URLSearchParams(params).toString();
  return `/settings?${qs}`;
};

describe("GET /settings - signature-verified iframe entry", () => {
  it("establishes a shop session from a valid admin-hash and resolves shopId via shoper_license", async () => {
    const shopId = "shop-iframe-admin-hash";
    const license = "license-aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
    shopConnectionService.registerInstallation(shopId, "https://shop-iframe-admin-hash.example.com");
    shopConnectionService.recordShoperLicense(shopId, license);

    const fields = {
      adminId: "admin-1",
      adminName: "Test Admin",
      place: "shop_panel",
      shop: license,
      timestamp: String(NOW_SECONDS()),
    };
    const adminHash = signAdminHash(fields);

    const agent = new Agent(baseUrl);
    const res = await agent.raw(
      iframeUrl({
        application: "idoxxy",
        shop: fields.shop,
        timestamp: fields.timestamp,
        place: fields.place,
        "admin-id": fields.adminId,
        "admin-name": fields.adminName,
        "admin-hash": adminHash,
      }),
    );
    expect(res.status).toBe(200);

    // The session cookie issued by that request must now grant access to
    // this exact shop's data, with no OAuth exchange having occurred.
    const configRes = await agent.json("/settings/config");
    expect(configRes.status).toBe(200);
  });

  it("accepts a valid legacy hash (no admin-id/admin-name) the same way", async () => {
    const shopId = "shop-iframe-legacy-hash";
    const license = "license-bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
    shopConnectionService.registerInstallation(shopId, "https://shop-iframe-legacy-hash.example.com");
    shopConnectionService.recordShoperLicense(shopId, license);

    const fields = { place: "shop_panel", shop: license, timestamp: String(NOW_SECONDS()) };
    const legacyHash = signLegacyHash(fields);

    const agent = new Agent(baseUrl);
    const res = await agent.raw(
      iframeUrl({ shop: fields.shop, timestamp: fields.timestamp, place: fields.place, hash: legacyHash }),
    );
    expect(res.status).toBe(200);

    const configRes = await agent.json("/settings/config");
    expect(configRes.status).toBe(200);
  });

  it("does not establish a session on a tampered signature", async () => {
    const shopId = "shop-iframe-tampered";
    const license = "license-cccc3333cccc3333cccc3333cccc3333cccc3333";
    shopConnectionService.registerInstallation(shopId, "https://shop-iframe-tampered.example.com");
    shopConnectionService.recordShoperLicense(shopId, license);

    const agent = new Agent(baseUrl);
    const res = await agent.raw(
      iframeUrl({
        shop: license,
        timestamp: String(NOW_SECONDS()),
        place: "shop_panel",
        "admin-id": "admin-1",
        "admin-name": "Test Admin",
        "admin-hash": "0".repeat(128),
      }),
    );
    expect(res.status).toBe(200);

    const configRes = await agent.json("/settings/config");
    expect(configRes.status).toBe(401);
  });

  it("does not establish a session with a hash computed under the wrong secret", async () => {
    const shopId = "shop-iframe-wrong-secret";
    const license = "license-dddd4444dddd4444dddd4444dddd4444dddd4444";
    shopConnectionService.registerInstallation(shopId, "https://shop-iframe-wrong-secret.example.com");
    shopConnectionService.recordShoperLicense(shopId, license);

    const fields = {
      adminId: "admin-1",
      adminName: "Test Admin",
      place: "shop_panel",
      shop: license,
      timestamp: String(NOW_SECONDS()),
    };
    const wrongSecretHash = computeAppStoreCallbackHash("a-completely-different-secret", {
      "admin-id": fields.adminId,
      "admin-name": fields.adminName,
      place: fields.place,
      shop: fields.shop,
      timestamp: fields.timestamp,
    });

    const agent = new Agent(baseUrl);
    await agent.raw(
      iframeUrl({
        shop: fields.shop,
        timestamp: fields.timestamp,
        place: fields.place,
        "admin-id": fields.adminId,
        "admin-name": fields.adminName,
        "admin-hash": wrongSecretHash,
      }),
    );

    const configRes = await agent.json("/settings/config");
    expect(configRes.status).toBe(401);
  });

  it("does not establish a session when no signature is present at all", async () => {
    const shopId = "shop-iframe-no-sig";
    const license = "license-eeee5555eeee5555eeee5555eeee5555eeee5555";
    shopConnectionService.registerInstallation(shopId, "https://shop-iframe-no-sig.example.com");
    shopConnectionService.recordShoperLicense(shopId, license);

    const agent = new Agent(baseUrl);
    const res = await agent.raw(iframeUrl({ shop: license, place: "shop_panel" }));
    expect(res.status).toBe(200);

    const configRes = await agent.json("/settings/config");
    expect(configRes.status).toBe(401);
  });

  it("does not establish a session when the shop value is mutated after signing", async () => {
    const shopId = "shop-iframe-mutated-shop";
    const license = "license-ffff6666ffff6666ffff6666ffff6666ffff6666";
    shopConnectionService.registerInstallation(shopId, "https://shop-iframe-mutated-shop.example.com");
    shopConnectionService.recordShoperLicense(shopId, license);

    const fields = {
      adminId: "admin-1",
      adminName: "Test Admin",
      place: "shop_panel",
      shop: license,
      timestamp: String(NOW_SECONDS()),
    };
    const adminHash = signAdminHash(fields);

    const agent = new Agent(baseUrl);
    await agent.raw(
      iframeUrl({
        shop: "a-different-license-entirely-000000000000000",
        timestamp: fields.timestamp,
        place: fields.place,
        "admin-id": fields.adminId,
        "admin-name": fields.adminName,
        "admin-hash": adminHash,
      }),
    );

    const configRes = await agent.json("/settings/config");
    expect(configRes.status).toBe(401);
  });

  it("rejects an expired timestamp", async () => {
    const shopId = "shop-iframe-expired";
    const license = "license-1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa";
    shopConnectionService.registerInstallation(shopId, "https://shop-iframe-expired.example.com");
    shopConnectionService.recordShoperLicense(shopId, license);

    const fields = {
      adminId: "admin-1",
      adminName: "Test Admin",
      place: "shop_panel",
      shop: license,
      timestamp: String(NOW_SECONDS() - 10 * 60), // 10 minutes stale
    };
    const adminHash = signAdminHash(fields);

    const agent = new Agent(baseUrl);
    await agent.raw(
      iframeUrl({
        shop: fields.shop,
        timestamp: fields.timestamp,
        place: fields.place,
        "admin-id": fields.adminId,
        "admin-name": fields.adminName,
        "admin-hash": adminHash,
      }),
    );

    const configRes = await agent.json("/settings/config");
    expect(configRes.status).toBe(401);
  });

  it("rejects a far-future timestamp", async () => {
    const shopId = "shop-iframe-future";
    const license = "license-2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb";
    shopConnectionService.registerInstallation(shopId, "https://shop-iframe-future.example.com");
    shopConnectionService.recordShoperLicense(shopId, license);

    const fields = {
      adminId: "admin-1",
      adminName: "Test Admin",
      place: "shop_panel",
      shop: license,
      timestamp: String(NOW_SECONDS() + 10 * 60), // 10 minutes ahead
    };
    const adminHash = signAdminHash(fields);

    const agent = new Agent(baseUrl);
    await agent.raw(
      iframeUrl({
        shop: fields.shop,
        timestamp: fields.timestamp,
        place: fields.place,
        "admin-id": fields.adminId,
        "admin-name": fields.adminName,
        "admin-hash": adminHash,
      }),
    );

    const configRes = await agent.json("/settings/config");
    expect(configRes.status).toBe(401);
  });

  it("a valid signature with no prior shoper_license mapping auto-provisions connection and establishes session", async () => {
    // No shop_connections row initially - simulates a fresh shop/server entry
    const fields = {
      adminId: "admin-1",
      adminName: "Test Admin",
      place: "shop_panel",
      shop: "license-never-installed-0000000000000000000000",
      timestamp: String(NOW_SECONDS()),
    };
    const adminHash = signAdminHash(fields);

    const agent = new Agent(baseUrl);
    const res = await agent.raw(
      iframeUrl({
        shop: fields.shop,
        timestamp: fields.timestamp,
        place: fields.place,
        "admin-id": fields.adminId,
        "admin-name": fields.adminName,
        "admin-hash": adminHash,
      }),
    );
    expect(res.status).toBe(200);

    const configRes = await agent.json("/settings/config");
    expect(configRes.status).toBe(200);
    expect(configRes.body).toBeDefined();
  });

  it("skips the iframe-entry path entirely (never establishes a session) when SHOPER_APPSTORE_SECRET is unset", async () => {
    delete process.env.SHOPER_APPSTORE_SECRET;
    vi.resetModules();
    process.env.DATABASE_PATH = path.join(os.tmpdir(), `idoxxy-test-iframe-entry-nosecret-${randomUUID()}.db`);

    vi.spyOn(axios, "post").mockImplementation(async () => {
      throw new Error("not expected in this test");
    });
    vi.spyOn(axios, "get").mockImplementation(async () => {
      throw new Error("not expected in this test");
    });

    const { createApp } = await import("../src/app");
    const { shopConnectionService: freshService } = await import("../src/services/shopConnectionService");

    const shopId = "shop-iframe-no-secret";
    const license = "license-3333cccc3333cccc3333cccc3333cccc3333cccc";
    freshService.registerInstallation(shopId, "https://shop-iframe-no-secret.example.com");
    freshService.recordShoperLicense(shopId, license);

    const freshApp = createApp();
    const freshServer = createServer(freshApp);
    await new Promise<void>((resolve) => freshServer.listen(0, resolve));
    const address = freshServer.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const freshBaseUrl = `http://127.0.0.1:${port}`;

    try {
      const agent = new Agent(freshBaseUrl);
      // Even a syntactically "valid-looking" admin-hash query can't be
      // verified without a secret configured - and must not be trusted.
      await agent.raw(
        `${iframeUrl({
          shop: license,
          timestamp: String(NOW_SECONDS()),
          place: "shop_panel",
          "admin-id": "admin-1",
          "admin-name": "Test Admin",
        })}&admin-hash=${"a".repeat(128)}`,
      );

      const configRes = await agent.json("/settings/config");
      expect(configRes.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => freshServer.close(() => resolve()));
    }
  });
});

describe("shoper_license persistence", () => {
  it("is recorded by the settings.ts OAuth install branch (action=install with shop=<license>)", async () => {
    const host = "install-license-settings.example-shoper.pl";
    const license = "license-4444dddd4444dddd4444dddd4444dddd4444dddd";

    const agent = new Agent(baseUrl);
    const res = await agent.raw(
      `/settings?action=install&auth_code=${encodeURIComponent(randomUUID())}&shop_url=${encodeURIComponent(host)}&shop=${encodeURIComponent(license)}`,
    );
    expect(res.status).toBe(302);

    const shopId = host.split(".")[0]!;
    const connection = shopConnectionService.getConnection(shopId);
    expect(connection?.shoperLicense).toBe(license);
    expect(shopConnectionService.getShopIdByLicense(license)).toBe(shopId);
  });

  it("is recorded by POST /billing/automatic-messages for action=install, matched by shop_url", async () => {
    const shopId = "shop-billing-license-install";
    const shopUrl = "https://shop-billing-license-install.example.com";
    const license = "license-5555eeee5555eeee5555eeee5555eeee5555eeee";
    shopConnectionService.registerInstallation(shopId, shopUrl);

    const params = { action: "install", shop: license, shop_url: shopUrl };
    const hash = computeAppStoreCallbackHash(APPSTORE_SECRET, params);

    const res = await fetch(`${baseUrl}/billing/automatic-messages`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, hash }).toString(),
    });
    expect(res.status).toBe(200);

    expect(shopConnectionService.getConnection(shopId)?.shoperLicense).toBe(license);
    expect(shopConnectionService.getShopIdByLicense(license)).toBe(shopId);
  });
});
