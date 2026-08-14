import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Reproduces the "TOKEN_ENCRYPTION_KEY changed/rotated" incident: a token
 * encrypted under one key can never be decrypted under a different one (that
 * is the whole point of AES-GCM authentication). shopConnectionService must
 * degrade to "this shop needs to be re-linked" rather than let the raw crypto
 * error escape into every caller (webhook handlers, settings endpoints).
 *
 * Each stage gets its own fresh module graph (vi.resetModules()) so the
 * right TOKEN_ENCRYPTION_KEY is picked up by src/config/env.ts at each step,
 * same pattern as tests/database-migration.test.ts - and each stage's
 * better-sqlite3 connection is explicitly closed before the next one opens
 * the same file.
 */

const makeTempPath = () => path.join(os.tmpdir(), `idoxxy-test-key-rotation-${randomUUID()}.db`);

const cleanupSqliteFiles = (dbPath: string) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
};

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

describe("a token encrypted under a different TOKEN_ENCRYPTION_KEY", () => {
  const createdPaths: string[] = [];
  const originalTokenKey = process.env.TOKEN_ENCRYPTION_KEY;

  afterEach(() => {
    for (const p of createdPaths.splice(0)) {
      cleanupSqliteFiles(p);
    }
    process.env.TOKEN_ENCRYPTION_KEY = originalTokenKey;
  });

  it("degrades to undefined + token_invalid instead of throwing, and touches no other column", async () => {
    const shopId = "shop-key-rotated";
    const shopUrl = "https://shop-key-rotated.example.com";
    const dbPath = makeTempPath();
    createdPaths.push(dbPath);
    process.env.DATABASE_PATH = dbPath;

    // Stage 1: encrypt a token under key A.
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    vi.resetModules();
    const stageA = await import("../src/services/tokenCrypto");
    const ciphertextUnderKeyA = stageA.encryptToken("idoxxy-token-encrypted-under-key-a");

    // Stage 2: write a row holding that ciphertext directly via the
    // repository (which has no dependency on the encryption key at all).
    vi.resetModules();
    const dbStage2 = await import("../src/config/database");
    const repoStage2 = await import("../src/repositories/shopConnectionRepository");
    repoStage2.shopConnectionRepository.upsert({
      shopId,
      shopUrl,
      idoxxyWorkspaceId: "workspace-1",
      idoxxyBaseUrl: "https://idoxxy.example.com",
      idoxxyTokenEncrypted: ciphertextUnderKeyA,
      shoperAccessToken: undefined,
      shoperRefreshToken: undefined,
      tokenLastVerifiedAt: 999,
      status: "linked",
      auditMetadata: { note: "pre-rotation" },
      revokedAt: undefined,
      revokedBy: undefined,
      lastError: undefined,
      lastSyncAt: undefined,
      lastSyncStatus: undefined,
    });
    const before = repoStage2.shopConnectionRepository.get(shopId)!;
    expect(before.status).toBe("linked");
    expect(before.idoxxyTokenEncrypted).toBe(ciphertextUnderKeyA);
    dbStage2.db.close();

    // Stage 3: read it back under a DIFFERENT key (simulating rotation, or
    // an ephemeral dev key regenerated across a restart).
    process.env.TOKEN_ENCRYPTION_KEY = KEY_B;
    vi.resetModules();
    const dbStage3 = await import("../src/config/database");
    const { shopConnectionService } = await import("../src/services/shopConnectionService");
    const { shopConnectionRepository } = await import("../src/repositories/shopConnectionRepository");

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    let decoded: string | undefined;
    expect(() => {
      decoded = shopConnectionService.getToken(shopId);
    }).not.toThrow();
    expect(decoded).toBeUndefined();

    // Logged context is safe: shopId/column only, never the token, the
    // ciphertext or either key.
    expect(consoleErrorSpy).toHaveBeenCalled();
    const loggedArgs = consoleErrorSpy.mock.calls.flat();
    const loggedText = JSON.stringify(loggedArgs);
    expect(loggedText).not.toContain(ciphertextUnderKeyA);
    expect(loggedText).not.toContain(KEY_A);
    expect(loggedText).not.toContain(KEY_B);
    expect(loggedText).toContain(shopId);
    consoleErrorSpy.mockRestore();

    const after = shopConnectionRepository.get(shopId)!;
    expect(after.status).toBe("token_invalid");
    expect(after.lastError).toBeTruthy();

    // The undecryptable ciphertext itself is preserved as-is (not cleared,
    // not clobbered) - if the correct key is restored later, the value is
    // still there to recover.
    expect(after.idoxxyTokenEncrypted).toBe(ciphertextUnderKeyA);

    // Every other column on the row is untouched.
    expect(after.shopUrl).toBe(before.shopUrl);
    expect(after.idoxxyWorkspaceId).toBe(before.idoxxyWorkspaceId);
    expect(after.idoxxyBaseUrl).toBe(before.idoxxyBaseUrl);
    expect(after.tokenLastVerifiedAt).toBe(before.tokenLastVerifiedAt);
    expect(after.auditMetadata).toEqual(before.auditMetadata);
    expect(after.createdAt).toBe(before.createdAt);

    dbStage3.db.close();
  });
});
