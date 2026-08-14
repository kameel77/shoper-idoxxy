import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request } from "express";

/**
 * Build a minimal fake Express Request exposing only what resolveShopId reads:
 * header() (case-insensitive, like Express) and body.
 */
const makeReq = (headers: Record<string, string>, body: unknown = {}): Request => {
  const lowered = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    header: (name: string) => lowered.get(name.toLowerCase()),
    body,
  } as unknown as Request;
};

// resolveShopId touches shop_connections through shopConnectionService, so each
// test gets a fully fresh module graph + temp SQLite file via vi.resetModules().
// This makes assertions like "exactly one linked shop" trustworthy instead of
// depending on the accumulated state of earlier tests in this file.
let resolveShopId: typeof import("../src/routes/webhooks").resolveShopId;
let shopConnectionService: typeof import("../src/services/shopConnectionService").shopConnectionService;

beforeEach(async () => {
  vi.resetModules();
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `idoxxy-test-webhooks-${randomUUID()}.db`);
  ({ resolveShopId } = await import("../src/routes/webhooks"));
  ({ shopConnectionService } = await import("../src/services/shopConnectionService"));
});

describe("resolveShopId", () => {
  it("resolves from an explicit X-Shoper-Shop-Id header", () => {
    const req = makeReq({ "X-Shoper-Shop-Id": "explicit-123" });
    expect(resolveShopId(req)).toBe("explicit-123");
  });

  it("resolves from shop_id in the JSON body when no header is present", () => {
    const req = makeReq({}, { shop_id: "body-shop-1" });
    expect(resolveShopId(req)).toBe("body-shop-1");
  });

  it("resolves via X-Shop-Domain matched against a stored shopUrl", () => {
    shopConnectionService.registerInstallation("shop-url-match", "https://known-shop.example.com");
    const req = makeReq({ "X-Shop-Domain": "known-shop.example.com" });
    expect(resolveShopId(req)).toBe("shop-url-match");
  });

  it("resolves via numeric-id extraction matched against an existing connection", () => {
    shopConnectionService.registerInstallation("998877", undefined);
    const req = makeReq({ "X-Shop-Domain": "devshop-998877.shoparena.pl" });
    expect(resolveShopId(req)).toBe("998877");
  });

  it("backfills shopUrl on numeric-id match without touching an existing token", () => {
    const connection = shopConnectionService.saveLink({
      shopId: "112233",
      shopUrl: undefined,
      idoxxyBaseUrl: undefined,
      idoxxyWorkspaceId: undefined,
      token: "super-secret-token",
      status: "linked",
      tokenLastVerifiedAt: Date.now(),
    });
    expect(connection.idoxxyTokenEncrypted).toBeTruthy();

    const req = makeReq({ "X-Shop-Domain": "devshop-112233.shoparena.pl" });
    expect(resolveShopId(req)).toBe("112233");

    // The token must be untouched by the shopUrl backfill side effect.
    expect(shopConnectionService.getToken("112233")).toBe("super-secret-token");
    expect(shopConnectionService.getConnection("112233")?.shopUrl).toBe(
      "https://devshop-112233.shoparena.pl",
    );
  });

  it("resolves via Origin matched against a stored shopUrl", () => {
    shopConnectionService.registerInstallation("origin-shop", "https://origin-shop.example.com");
    const req = makeReq({ Origin: "https://origin-shop.example.com" });
    expect(resolveShopId(req)).toBe("origin-shop");
  });

  it("returns undefined for an unrecognised X-Shop-Domain (deleted fallback 2c)", () => {
    // No connections registered at all, so URL/numeric-id matching cannot
    // succeed either - this exercises the removed "use the domain as shopId"
    // fallback specifically.
    const req = makeReq({ "X-Shop-Domain": "totally-unknown-domain.example.com" });
    expect(resolveShopId(req)).toBeUndefined();
  });

  it("returns undefined when exactly one linked shop exists and nothing matches (deleted fallback 4)", () => {
    shopConnectionService.saveLink({
      shopId: "the-only-linked-shop",
      shopUrl: undefined,
      idoxxyBaseUrl: undefined,
      idoxxyWorkspaceId: undefined,
      token: "tok",
      status: "linked",
      tokenLastVerifiedAt: Date.now(),
    });

    const connections = shopConnectionService.listConnections();
    expect(connections.filter((c) => c.status === "linked")).toHaveLength(1);

    const req = makeReq({});
    expect(resolveShopId(req)).toBeUndefined();
  });

  it("returns undefined when nothing at all is present on the request", () => {
    const req = makeReq({});
    expect(resolveShopId(req)).toBeUndefined();
  });
});
