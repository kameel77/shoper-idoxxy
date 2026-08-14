import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * End-to-end coverage for Defect B: POST /uninstall (and, by the same
 * middleware, /billing/subscription and /billing/automatic-messages) must
 * verify Shoper's App Store callback signature before making any state
 * change, while still always answering 200 (Shoper requires this regardless
 * of outcome). Fresh module graph + temp SQLite file per test, same pattern
 * as tests/webhooks.test.ts, so SHOPER_APPSTORE_SECRET can be configured
 * without affecting other test files.
 */

let server: Server;
let baseUrl: string;
let shopConnectionService: typeof import("../src/services/shopConnectionService").shopConnectionService;
let computeAppStoreCallbackHash: typeof import("../src/middleware/shoperSignature").computeAppStoreCallbackHash;

const APPSTORE_SECRET = "e2e-test-appstore-secret";

beforeEach(async () => {
  vi.resetModules();
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `idoxxy-test-appstore-${randomUUID()}.db`);
  process.env.SHOPER_APPSTORE_SECRET = APPSTORE_SECRET;

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
  delete process.env.SHOPER_APPSTORE_SECRET;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const postForm = (formPath: string, params: Record<string, string>) =>
  fetch(`${baseUrl}${formPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });

const getQuery = (formPath: string, params: Record<string, string>) =>
  fetch(`${baseUrl}${formPath}?${new URLSearchParams(params).toString()}`, { method: "GET" });

const setUpLinkedShop = (shopId: string, shopUrl: string) => {
  shopConnectionService.registerInstallation(shopId, shopUrl);
  shopConnectionService.markLinked(shopId, "workspace-1", "an-idoxxy-token");
  expect(shopConnectionService.getConnection(shopId)?.status).toBe("linked");
};

describe("POST /uninstall signature verification", () => {
  it("with no signature at all: returns 200 and leaves the connection status unchanged", async () => {
    const shopId = "shop-uninstall-no-sig";
    const shopUrl = "https://shop-uninstall-no-sig.example.com";
    setUpLinkedShop(shopId, shopUrl);

    const res = await postForm("/uninstall", { shop_url: shopUrl, action: "uninstall" });

    expect(res.status).toBe(200);
    expect(shopConnectionService.getConnection(shopId)?.status).toBe("linked");
  });

  it("with an invalid hash: returns 200 and leaves the connection status unchanged", async () => {
    const shopId = "shop-uninstall-bad-sig";
    const shopUrl = "https://shop-uninstall-bad-sig.example.com";
    setUpLinkedShop(shopId, shopUrl);

    const res = await postForm("/uninstall", {
      shop_url: shopUrl,
      action: "uninstall",
      hash: "0".repeat(128),
    });

    expect(res.status).toBe(200);
    expect(shopConnectionService.getConnection(shopId)?.status).toBe("linked");
  });

  it("with a valid hash: revokes the connection", async () => {
    const shopId = "shop-uninstall-good-sig";
    const shopUrl = "https://shop-uninstall-good-sig.example.com";
    setUpLinkedShop(shopId, shopUrl);

    const params = { shop_url: shopUrl, action: "uninstall" };
    const hash = computeAppStoreCallbackHash(APPSTORE_SECRET, params);

    const res = await postForm("/uninstall", { ...params, hash });

    expect(res.status).toBe(200);
    expect(shopConnectionService.getConnection(shopId)?.status).toBe("revoked");
  });
});

describe("GET /settings?action=uninstall signature verification", () => {
  it("with no signature at all: returns 200 HTML and leaves the connection linked with tokens intact", async () => {
    const shopId = "shop-get-uninstall-no-sig";
    const shopUrl = "https://shop-get-uninstall-no-sig.example.com";
    setUpLinkedShop(shopId, shopUrl);
    shopConnectionService.saveShoperTokens(shopId, "shoper-access-token", "shoper-refresh-token");

    const res = await getQuery("/settings", { action: "uninstall", shop_url: shopUrl });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const connection = shopConnectionService.getConnection(shopId);
    expect(connection?.status).toBe("linked");
    expect(connection?.idoxxyTokenEncrypted).toBeTruthy();
    expect(connection?.shoperAccessToken).toBeTruthy();
    expect(connection?.shoperRefreshToken).toBeTruthy();
  });

  it("with an invalid hash: returns 200 HTML and leaves the connection linked with tokens intact", async () => {
    const shopId = "shop-get-uninstall-bad-sig";
    const shopUrl = "https://shop-get-uninstall-bad-sig.example.com";
    setUpLinkedShop(shopId, shopUrl);
    shopConnectionService.saveShoperTokens(shopId, "shoper-access-token", "shoper-refresh-token");

    const res = await getQuery("/settings", {
      action: "uninstall",
      shop_url: shopUrl,
      hash: "0".repeat(128),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const connection = shopConnectionService.getConnection(shopId);
    expect(connection?.status).toBe("linked");
    expect(connection?.idoxxyTokenEncrypted).toBeTruthy();
    expect(connection?.shoperAccessToken).toBeTruthy();
    expect(connection?.shoperRefreshToken).toBeTruthy();
  });

  it("with a valid hash: revokes the connection, wipes all three token columns, and still serves 200 HTML", async () => {
    const shopId = "shop-get-uninstall-good-sig";
    const shopUrl = "https://shop-get-uninstall-good-sig.example.com";
    setUpLinkedShop(shopId, shopUrl);
    shopConnectionService.saveShoperTokens(shopId, "shoper-access-token", "shoper-refresh-token");

    const params = { action: "uninstall", shop_url: shopUrl };
    const hash = computeAppStoreCallbackHash(APPSTORE_SECRET, params);

    const res = await getQuery("/settings", { ...params, hash });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const connection = shopConnectionService.getConnection(shopId);
    expect(connection?.status).toBe("revoked");
    expect(connection?.idoxxyTokenEncrypted).toBeUndefined();
    expect(connection?.shoperAccessToken).toBeUndefined();
    expect(connection?.shoperRefreshToken).toBeUndefined();
  });

  it("is skipped entirely (no state change) when SHOPER_APPSTORE_SECRET is unset", async () => {
    delete process.env.SHOPER_APPSTORE_SECRET;
    vi.resetModules();
    process.env.DATABASE_PATH = path.join(os.tmpdir(), `idoxxy-test-appstore-nosecret-${randomUUID()}.db`);

    const { createApp: createAppNoSecret } = await import("../src/app");
    const { shopConnectionService: scsNoSecret } = await import("../src/services/shopConnectionService");
    const { computeAppStoreCallbackHash: computeHashNoSecret } = await import(
      "../src/middleware/shoperSignature"
    );

    const noSecretApp = createAppNoSecret();
    const noSecretServer = createServer(noSecretApp);
    await new Promise<void>((resolve) => noSecretServer.listen(0, resolve));
    const address = noSecretServer.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const noSecretBaseUrl = `http://127.0.0.1:${port}`;

    try {
      const shopId = "shop-get-uninstall-no-secret";
      const shopUrl = "https://shop-get-uninstall-no-secret.example.com";
      scsNoSecret.registerInstallation(shopId, shopUrl);
      scsNoSecret.markLinked(shopId, "workspace-1", "an-idoxxy-token");

      // A "valid" hash under a secret that isn't even configured is
      // meaningless, but included anyway to prove the branch never even
      // attempts verification when SHOPER_APPSTORE_SECRET is unset.
      const params = { action: "uninstall", shop_url: shopUrl };
      const hash = computeHashNoSecret("some-secret-not-actually-configured", params);

      const res = await fetch(
        `${noSecretBaseUrl}/settings?${new URLSearchParams({ ...params, hash }).toString()}`,
      );

      expect(res.status).toBe(200);
      expect(scsNoSecret.getConnection(shopId)?.status).toBe("linked");
    } finally {
      await new Promise<void>((resolve) => noSecretServer.close(() => resolve()));
    }
  });
});

describe("POST /billing/automatic-messages signature verification", () => {
  it("with an invalid hash: returns 200 and does not record the install", async () => {
    const res = await postForm("/billing/automatic-messages", {
      action: "install",
      shop: "shop-billing-bad-sig",
      shop_url: "https://shop-billing-bad-sig.example.com",
      hash: "not-a-valid-hash",
    });

    expect(res.status).toBe(200);

    const { recentInstallsRepository } = await import("../src/repositories/recentInstallsRepository");
    expect(
      recentInstallsRepository.getRecentInstalls().some((i) => i.shopId === "shop-billing-bad-sig"),
    ).toBe(false);
  });

  it("with a valid hash: records the install", async () => {
    const params = {
      action: "install",
      shop: "shop-billing-good-sig",
      shop_url: "https://shop-billing-good-sig.example.com",
    };
    const hash = computeAppStoreCallbackHash(APPSTORE_SECRET, params);

    const res = await postForm("/billing/automatic-messages", { ...params, hash });

    expect(res.status).toBe(200);

    const { recentInstallsRepository } = await import("../src/repositories/recentInstallsRepository");
    expect(
      recentInstallsRepository.getRecentInstalls().some((i) => i.shopId === "shop-billing-good-sig"),
    ).toBe(true);
  });
});
