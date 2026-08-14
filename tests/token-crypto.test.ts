import { describe, it, expect } from "vitest";

import { encryptToken, decryptToken, isLegacyEncodedToken } from "../src/services/tokenCrypto";

// tests/setup.ts pins TOKEN_ENCRYPTION_KEY to a fixed 32-byte key for the
// whole process, so encryptToken/decryptToken here exercise the real
// AES-256-GCM path (not the ephemeral dev-key fallback).

describe("encryptToken / decryptToken", () => {
  it("round-trips a plaintext token", () => {
    const plaintext = "super-secret-idoxxy-workspace-token";
    const encrypted = encryptToken(plaintext);
    expect(decryptToken(encrypted)).toBe(plaintext);
  });

  it("produces a different ciphertext each call for the same plaintext (random IV)", () => {
    const plaintext = "same-plaintext-every-time";
    const first = encryptToken(plaintext);
    const second = encryptToken(plaintext);
    expect(first).not.toBe(second);
    // Both still decrypt back to the same plaintext.
    expect(decryptToken(first)).toBe(plaintext);
    expect(decryptToken(second)).toBe(plaintext);
  });

  it("stores the self-describing iv:authTag:ciphertext format", () => {
    const encrypted = encryptToken("whatever");
    const parts = encrypted.split(":");
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(() => Buffer.from(part, "base64")).not.toThrow();
    }
  });

  it("throws (rather than returning garbage) when the auth tag is tampered", () => {
    const encrypted = encryptToken("integrity-matters");
    const [iv, authTag, ciphertext] = encrypted.split(":");
    // Flip the auth tag's base64 payload by re-encoding different bytes.
    const tamperedTag = Buffer.from(authTag!, "base64");
    tamperedTag[0] = tamperedTag[0]! ^ 0xff;
    const tampered = [iv, tamperedTag.toString("base64"), ciphertext].join(":");

    expect(() => decryptToken(tampered)).toThrow();
  });

  it("throws (rather than returning garbage) when the ciphertext is tampered", () => {
    const encrypted = encryptToken("integrity-matters-2");
    const [iv, authTag, ciphertext] = encrypted.split(":");
    const tamperedCiphertext = Buffer.from(ciphertext!, "base64");
    tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 0xff;
    const tampered = [iv, authTag, tamperedCiphertext.toString("base64")].join(":");

    expect(() => decryptToken(tampered)).toThrow();
  });
});

describe("legacy base64 format compatibility", () => {
  it("detects a legacy plain-base64 value as legacy", () => {
    const legacy = Buffer.from("an-old-plaintext-token", "utf8").toString("base64");
    expect(isLegacyEncodedToken(legacy)).toBe(true);
  });

  it("does not flag a current-format value as legacy", () => {
    const current = encryptToken("a-token");
    expect(isLegacyEncodedToken(current)).toBe(false);
  });

  it("decodes a legacy base64 value back to its original plaintext", () => {
    const plaintext = "legacy-shoper-access-token";
    const legacy = Buffer.from(plaintext, "utf8").toString("base64");
    expect(decryptToken(legacy)).toBe(plaintext);
  });
});
