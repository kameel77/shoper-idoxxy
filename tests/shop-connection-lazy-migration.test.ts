import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach } from "vitest";

// Fresh module graph + temp SQLite file per test (same pattern as
// tests/webhooks.test.ts) so assertions about "every other column untouched"
// are trustworthy rather than depending on accumulated state.
let shopConnectionService: typeof import("../src/services/shopConnectionService").shopConnectionService;
let shopConnectionRepository: typeof import("../src/repositories/shopConnectionRepository").shopConnectionRepository;

beforeEach(async () => {
  const { vi } = await import("vitest");
  vi.resetModules();
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `idoxxy-test-lazy-migration-${randomUUID()}.db`);
  ({ shopConnectionService } = await import("../src/services/shopConnectionService"));
  ({ shopConnectionRepository } = await import("../src/repositories/shopConnectionRepository"));
});

describe("legacy token lazy re-encryption on read", () => {
  it("decodes a legacy base64 idoxxy token and transparently re-encrypts it in place", () => {
    const shopId = "legacy-shop-1";
    const plaintext = "legacy-idoxxy-workspace-token";
    const legacyEncoded = Buffer.from(plaintext, "utf8").toString("base64");

    // Simulate a row written by the old plain-base64 encodeToken(), including
    // sibling data that must survive the migration untouched.
    shopConnectionRepository.upsert({
      shopId,
      shopUrl: "https://legacy-shop.example.com",
      idoxxyWorkspaceId: "workspace-42",
      idoxxyBaseUrl: "https://idoxxy.example.com",
      idoxxyTokenEncrypted: legacyEncoded,
      shoperAccessToken: undefined,
      shoperRefreshToken: undefined,
      tokenLastVerifiedAt: 12345,
      status: "linked",
      auditMetadata: { note: "pre-migration row" },
      revokedAt: undefined,
      revokedBy: undefined,
      lastError: undefined,
      lastSyncAt: undefined,
      lastSyncStatus: undefined,
    });

    const before = shopConnectionService.getConnection(shopId)!;
    expect(before.idoxxyTokenEncrypted).toBe(legacyEncoded);

    // Read: should decode correctly AND upgrade the stored value.
    const decoded = shopConnectionService.getToken(shopId);
    expect(decoded).toBe(plaintext);

    const after = shopConnectionService.getConnection(shopId)!;
    expect(after.idoxxyTokenEncrypted).not.toBe(legacyEncoded);
    expect(after.idoxxyTokenEncrypted!.split(":")).toHaveLength(3);

    // The migrated value still decrypts to the same plaintext.
    expect(shopConnectionService.getToken(shopId)).toBe(plaintext);

    // Every other column is untouched by the write-back.
    expect(after.shopUrl).toBe(before.shopUrl);
    expect(after.idoxxyWorkspaceId).toBe(before.idoxxyWorkspaceId);
    expect(after.idoxxyBaseUrl).toBe(before.idoxxyBaseUrl);
    expect(after.tokenLastVerifiedAt).toBe(before.tokenLastVerifiedAt);
    expect(after.status).toBe(before.status);
    expect(after.auditMetadata).toEqual(before.auditMetadata);
    expect(after.shoperAccessToken).toBe(before.shoperAccessToken);
    expect(after.shoperRefreshToken).toBe(before.shoperRefreshToken);
    expect(after.createdAt).toBe(before.createdAt);
  });

  it("decodes legacy Shoper access/refresh tokens and re-encrypts each independently", () => {
    const shopId = "legacy-shop-2";
    const accessPlain = "legacy-shoper-access-token";
    const refreshPlain = "legacy-shoper-refresh-token";

    shopConnectionRepository.upsert({
      shopId,
      shopUrl: undefined,
      idoxxyWorkspaceId: undefined,
      idoxxyBaseUrl: undefined,
      idoxxyTokenEncrypted: undefined,
      shoperAccessToken: Buffer.from(accessPlain, "utf8").toString("base64"),
      shoperRefreshToken: Buffer.from(refreshPlain, "utf8").toString("base64"),
      tokenLastVerifiedAt: undefined,
      status: "installed_not_linked",
      auditMetadata: undefined,
      revokedAt: undefined,
      revokedBy: undefined,
      lastError: undefined,
      lastSyncAt: undefined,
      lastSyncStatus: undefined,
    });

    const tokens = shopConnectionService.getShoperTokens(shopId);
    expect(tokens.shoperAccessToken).toBe(accessPlain);
    expect(tokens.shoperRefreshToken).toBe(refreshPlain);

    const after = shopConnectionService.getConnection(shopId)!;
    expect(after.shoperAccessToken!.split(":")).toHaveLength(3);
    expect(after.shoperRefreshToken!.split(":")).toHaveLength(3);
    // idoxxy token column was never set - must remain untouched (undefined).
    expect(after.idoxxyTokenEncrypted).toBeUndefined();
  });

  it("does not rewrite a value that is already in the current encrypted format", async () => {
    const shopId = "current-format-shop";
    shopConnectionService.registerInstallation(shopId, "https://shop.example.com");
    shopConnectionService.markLinked(shopId, "workspace-1", "already-encrypted-token");

    const first = shopConnectionService.getConnection(shopId)!.idoxxyTokenEncrypted;
    expect(shopConnectionService.getToken(shopId)).toBe("already-encrypted-token");
    const second = shopConnectionService.getConnection(shopId)!.idoxxyTokenEncrypted;

    // No legacy value was present, so the stored ciphertext must be stable
    // across reads (no unnecessary re-encryption / updated_at churn).
    expect(second).toBe(first);
  });
});
