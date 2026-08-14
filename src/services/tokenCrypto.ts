import crypto from "node:crypto";

import { tokenEncryptionKey } from "../config/env";

/**
 * Authenticated encryption for tenant secrets at rest (iDoxxy workspace tokens,
 * Shoper OAuth access/refresh tokens - see src/services/shopConnectionService.ts).
 *
 * Format: "iv:authTag:ciphertext", each segment base64-encoded. This makes the
 * stored value self-describing (no external metadata needed to decrypt) and
 * rotatable (the IV travels with the ciphertext, so re-encrypting under a new
 * key is just decrypt-then-encrypt).
 *
 * Backward compatibility: values written before this module existed are plain
 * base64 of the UTF-8 token (see the old encodeToken/decodeToken in
 * shopConnectionService.ts). decryptToken() transparently detects and decodes
 * that legacy format - see isLegacyEncodedToken() and the lazy re-encryption
 * call sites in shopConnectionService.ts.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12; // 96-bit IV, the size AES-GCM is designed for.
const AUTH_TAG_LENGTH_BYTES = 16;

// Matches "base64:base64:base64" - the shape of anything encryptToken() ever
// produces. A legacy value (raw base64 of the plaintext token) essentially
// never happens to contain two ':' characters, since ':' is outside the
// base64 alphabet; the byte-length checks below are a further guard against a
// legacy token that coincidentally contains stray ':' characters after
// base64 padding weirdness.
const NEW_FORMAT_PATTERN = /^[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/;

const looksLikeCurrentFormat = (stored: string): boolean => {
  if (!NEW_FORMAT_PATTERN.test(stored)) {
    return false;
  }

  const parts = stored.split(":");
  if (parts.length !== 3) {
    return false;
  }

  const [ivB64, authTagB64] = parts as [string, string, string];

  try {
    return (
      Buffer.from(ivB64, "base64").length === IV_LENGTH_BYTES &&
      Buffer.from(authTagB64, "base64").length === AUTH_TAG_LENGTH_BYTES
    );
  } catch {
    return false;
  }
};

/** True when `stored` is the legacy (pre-encryption) plain-base64 format. */
export const isLegacyEncodedToken = (stored: string): boolean => !looksLikeCurrentFormat(stored);

/**
 * Encrypt a plaintext token with AES-256-GCM under a fresh random IV.
 * Two calls with the same plaintext produce different ciphertexts.
 */
export const encryptToken = (plaintext: string): string => {
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, tokenEncryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
};

/**
 * Decrypt a value previously produced by encryptToken(), or transparently
 * decode a legacy plain-base64 value. A tampered ciphertext or auth tag
 * throws (GCM authentication failure) rather than returning garbage.
 *
 * Callers that persist data (shopConnectionService) are responsible for
 * checking isLegacyEncodedToken() themselves and re-encrypting + writing back
 * on read - this function is a pure transform with no DB access.
 */
export const decryptToken = (stored: string): string => {
  if (!looksLikeCurrentFormat(stored)) {
    return Buffer.from(stored, "base64").toString("utf8");
  }

  const [ivB64, authTagB64, ciphertextB64] = stored.split(":") as [string, string, string];
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, tokenEncryptionKey, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
};
