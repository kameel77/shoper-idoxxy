import crypto from "node:crypto";

import { describe, it, expect } from "vitest";

import {
  constantTimeEqual,
  computeEventWebhookSignature,
  verifyEventWebhookSignature,
  computeDocumentedWebhookSignature,
  verifyDocumentedWebhookSignature,
  computeAppStoreCallbackHash,
  verifyAppStoreCallbackSignature,
  verifyIframeEntrySignature,
} from "../src/middleware/shoperSignature";

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for a different value of the same length", () => {
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
  });

  it("returns false (never throws) for mismatched lengths", () => {
    expect(() => constantTimeEqual("short", "much-longer-value")).not.toThrow();
    expect(constantTimeEqual("short", "much-longer-value")).toBe(false);
  });

  it("returns false (never throws) for non-hex/garbage content", () => {
    expect(() => constantTimeEqual("not-hex-!!@@##", "0123456789abcdef")).not.toThrow();
    expect(constantTimeEqual("!!not-hex-garbage!!", "!!not-hex-garbage!!".split("").reverse().join(""))).toBe(
      false,
    );
  });
});

describe("verifyEventWebhookSignature (customer/order event webhooks)", () => {
  const secret = "unit-test-webhook-secret";
  const rawBody = Buffer.from(JSON.stringify({ customer: { id: "1", email: "a@b.com" } }));

  it("accepts a correctly computed signature", () => {
    const signature = computeEventWebhookSignature(secret, rawBody);
    expect(verifyEventWebhookSignature(signature, rawBody, secret)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    const wrongSignature = computeEventWebhookSignature("a-different-secret", rawBody);
    expect(verifyEventWebhookSignature(wrongSignature, rawBody, secret)).toBe(false);
  });

  it("rejects an absent signature header, without throwing", () => {
    expect(() => verifyEventWebhookSignature(undefined, rawBody, secret)).not.toThrow();
    expect(verifyEventWebhookSignature(undefined, rawBody, secret)).toBe(false);
  });

  it("rejects a wrong-length signature header, without throwing", () => {
    expect(() => verifyEventWebhookSignature("deadbeef", rawBody, secret)).not.toThrow();
    expect(verifyEventWebhookSignature("deadbeef", rawBody, secret)).toBe(false);
  });

  it("rejects a same-length non-hex signature header, without throwing", () => {
    const expected = computeEventWebhookSignature(secret, rawBody);
    const nonHex = "z".repeat(expected.length);
    expect(() => verifyEventWebhookSignature(nonHex, rawBody, secret)).not.toThrow();
    expect(verifyEventWebhookSignature(nonHex, rawBody, secret)).toBe(false);
  });

  it("rejects when the raw body is missing, without throwing", () => {
    const signature = computeEventWebhookSignature(secret, rawBody);
    expect(() => verifyEventWebhookSignature(signature, undefined, secret)).not.toThrow();
    expect(verifyEventWebhookSignature(signature, undefined, secret)).toBe(false);
  });

  it("accepts an uppercase-hex signature (case-insensitive comparison)", () => {
    const signature = computeEventWebhookSignature(secret, rawBody);
    expect(signature).not.toBe(signature.toUpperCase()); // sanity: digest actually has letters
    expect(verifyEventWebhookSignature(signature.toUpperCase(), rawBody, secret)).toBe(true);
  });
});

describe("verifyDocumentedWebhookSignature (Shoper's documented sha1(webhookId:secret:body) scheme)", () => {
  const secret = "unit-test-webhook-secret";
  const webhookId = "35";
  const rawBody = Buffer.from(JSON.stringify({ user_id: "1", email: "a@b.com" }));

  it("accepts a correctly computed signature", () => {
    const signature = computeDocumentedWebhookSignature(webhookId, secret, rawBody);
    expect(verifyDocumentedWebhookSignature(webhookId, signature, rawBody, secret)).toBe(true);
  });

  it("is a bare SHA-1 digest, not an HMAC (sanity check against the documented PHP formula)", () => {
    const expected = crypto
      .createHash("sha1")
      .update(`${webhookId}:${secret}:${rawBody.toString("utf8")}`)
      .digest("hex");
    expect(computeDocumentedWebhookSignature(webhookId, secret, rawBody)).toBe(expected);
  });

  it("rejects a wrong X-Webhook-Id", () => {
    const signature = computeDocumentedWebhookSignature(webhookId, secret, rawBody);
    expect(verifyDocumentedWebhookSignature("36", signature, rawBody, secret)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const signature = computeDocumentedWebhookSignature(webhookId, secret, rawBody);
    expect(verifyDocumentedWebhookSignature(webhookId, signature, rawBody, "a-different-secret")).toBe(false);
  });

  it("rejects a wrong/tampered body", () => {
    const signature = computeDocumentedWebhookSignature(webhookId, secret, rawBody);
    const tamperedBody = Buffer.from(JSON.stringify({ user_id: "2", email: "attacker@b.com" }));
    expect(verifyDocumentedWebhookSignature(webhookId, signature, tamperedBody, secret)).toBe(false);
  });

  it("rejects a missing X-Webhook-Id, without throwing", () => {
    const signature = computeDocumentedWebhookSignature(webhookId, secret, rawBody);
    expect(() => verifyDocumentedWebhookSignature(undefined, signature, rawBody, secret)).not.toThrow();
    expect(verifyDocumentedWebhookSignature(undefined, signature, rawBody, secret)).toBe(false);
  });

  it("rejects a missing signature header, without throwing", () => {
    expect(() => verifyDocumentedWebhookSignature(webhookId, undefined, rawBody, secret)).not.toThrow();
    expect(verifyDocumentedWebhookSignature(webhookId, undefined, rawBody, secret)).toBe(false);
  });

  it("rejects a missing raw body, without throwing", () => {
    const signature = computeDocumentedWebhookSignature(webhookId, secret, rawBody);
    expect(() => verifyDocumentedWebhookSignature(webhookId, signature, undefined, secret)).not.toThrow();
    expect(verifyDocumentedWebhookSignature(webhookId, signature, undefined, secret)).toBe(false);
  });

  it("accepts an uppercase-hex signature (case-insensitive comparison)", () => {
    const signature = computeDocumentedWebhookSignature(webhookId, secret, rawBody);
    expect(signature).not.toBe(signature.toUpperCase()); // sanity: digest actually has letters
    expect(verifyDocumentedWebhookSignature(webhookId, signature.toUpperCase(), rawBody, secret)).toBe(true);
  });
});

describe("verifyAppStoreCallbackSignature (App Store install/uninstall/billing callbacks)", () => {
  const secret = "unit-test-appstore-secret";

  const sign = (params: Record<string, string>): string => computeAppStoreCallbackHash(secret, params);

  it("accepts a correctly computed hash over sorted params", () => {
    const params = { action: "uninstall", shop: "123", shop_url: "shop.example.com" };
    const body = { ...params, hash: sign(params) };
    expect(verifyAppStoreCallbackSignature(body, secret)).toBe(true);
  });

  it("is order-independent (verifies regardless of key order in the body)", () => {
    const params = { action: "uninstall", shop: "123", shop_url: "shop.example.com" };
    const hash = sign(params);
    const body = { hash, shop_url: "shop.example.com", shop: "123", action: "uninstall" };
    expect(verifyAppStoreCallbackSignature(body, secret)).toBe(true);
  });

  it("rejects a wrong hash", () => {
    const params = { action: "uninstall", shop: "123" };
    const body = { ...params, hash: sign({ ...params, shop: "999" }) };
    expect(verifyAppStoreCallbackSignature(body, secret)).toBe(false);
  });

  it("rejects a tampered parameter even if the hash format looks right", () => {
    const params = { action: "uninstall", shop_url: "shop.example.com" };
    const body: Record<string, unknown> = { ...params, hash: sign(params) };
    body.shop_url = "attacker.example.com";
    expect(verifyAppStoreCallbackSignature(body, secret)).toBe(false);
  });

  it("rejects a missing hash field, without throwing", () => {
    const body = { action: "uninstall", shop: "123" };
    expect(() => verifyAppStoreCallbackSignature(body, secret)).not.toThrow();
    expect(verifyAppStoreCallbackSignature(body, secret)).toBe(false);
  });

  it("rejects an undefined body, without throwing", () => {
    expect(() => verifyAppStoreCallbackSignature(undefined, secret)).not.toThrow();
    expect(verifyAppStoreCallbackSignature(undefined, secret)).toBe(false);
  });

  it("matches the documented PHP reference algorithm (sorted k=v joined by &, HMAC-SHA512)", () => {
    const params = { b: "2", a: "1" };
    const expected = crypto.createHmac("sha512", secret).update("a=1&b=2").digest("hex");
    expect(computeAppStoreCallbackHash(secret, params)).toBe(expected);
  });

  it("accepts an uppercase-hex hash (case-insensitive comparison)", () => {
    const params = { action: "uninstall", shop_url: "shop.example.com" };
    const hash = sign(params);
    expect(hash).not.toBe(hash.toUpperCase()); // sanity: digest actually has letters
    const body = { ...params, hash: hash.toUpperCase() };
    expect(verifyAppStoreCallbackSignature(body, secret)).toBe(true);
  });
});

describe("verifyIframeEntrySignature (Shop Panel iframe entry, admin-hash / legacy hash)", () => {
  const secret = "unit-test-appstore-secret";
  const NOW_SECONDS = 1_755_000_000; // an arbitrary "current" Unix-seconds instant
  const NOW_MS = NOW_SECONDS * 1000;

  const signAdminHash = (fields: {
    adminId: string;
    adminName: string;
    place: string;
    shop: string;
    timestamp: string;
  }): string =>
    computeAppStoreCallbackHash(secret, {
      "admin-id": fields.adminId,
      "admin-name": fields.adminName,
      place: fields.place,
      shop: fields.shop,
      timestamp: fields.timestamp,
    });

  const signLegacyHash = (fields: { place: string; shop: string; timestamp: string }): string =>
    computeAppStoreCallbackHash(secret, {
      place: fields.place,
      shop: fields.shop,
      timestamp: fields.timestamp,
    });

  const baseFields = {
    adminId: "admin-7",
    adminName: "Jan Kowalski",
    place: "shop_panel",
    shop: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", // 40-char license-style string
    timestamp: String(NOW_SECONDS),
  };

  it("accepts a valid admin-hash over the five documented fields (shop version >= 5.8.14)", () => {
    const adminHash = signAdminHash(baseFields);
    const query = {
      application: "idoxxy",
      shop: baseFields.shop,
      timestamp: baseFields.timestamp,
      place: baseFields.place,
      "admin-id": baseFields.adminId,
      "admin-name": baseFields.adminName,
      "admin-hash": adminHash,
    };

    const result = verifyIframeEntrySignature(query, secret, NOW_MS);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.scheme).toBe("admin-hash");
      expect(result.shop).toBe(baseFields.shop);
      expect(result.adminId).toBe(baseFields.adminId);
      expect(result.adminName).toBe(baseFields.adminName);
    }
  });

  it("accepts a valid legacy hash when admin-id/admin-name are absent (shop version < 5.8.14)", () => {
    const legacyHash = signLegacyHash(baseFields);
    const query = {
      shop: baseFields.shop,
      timestamp: baseFields.timestamp,
      place: baseFields.place,
      hash: legacyHash,
    };

    const result = verifyIframeEntrySignature(query, secret, NOW_MS);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.scheme).toBe("hash");
      expect(result.shop).toBe(baseFields.shop);
      expect(result.adminId).toBeUndefined();
      expect(result.adminName).toBeUndefined();
    }
  });

  it("rejects a tampered admin-hash", () => {
    const query = {
      shop: baseFields.shop,
      timestamp: baseFields.timestamp,
      place: baseFields.place,
      "admin-id": baseFields.adminId,
      "admin-name": baseFields.adminName,
      "admin-hash": "0".repeat(128),
    };
    expect(verifyIframeEntrySignature(query, secret, NOW_MS).valid).toBe(false);
  });

  it("rejects a validly-formed signature computed with the wrong secret", () => {
    const adminHash = computeAppStoreCallbackHash("a-different-secret", {
      "admin-id": baseFields.adminId,
      "admin-name": baseFields.adminName,
      place: baseFields.place,
      shop: baseFields.shop,
      timestamp: baseFields.timestamp,
    });
    const query = {
      shop: baseFields.shop,
      timestamp: baseFields.timestamp,
      place: baseFields.place,
      "admin-id": baseFields.adminId,
      "admin-name": baseFields.adminName,
      "admin-hash": adminHash,
    };
    expect(verifyIframeEntrySignature(query, secret, NOW_MS).valid).toBe(false);
  });

  it("rejects when both admin-hash and legacy hash are entirely absent", () => {
    const query = {
      shop: baseFields.shop,
      timestamp: baseFields.timestamp,
      place: baseFields.place,
    };
    expect(verifyIframeEntrySignature(query, secret, NOW_MS).valid).toBe(false);
  });

  it("rejects a mutated shop value even if the rest of the signature looks right", () => {
    const adminHash = signAdminHash(baseFields);
    const query = {
      shop: "attacker-supplied-different-shop-license-000000000",
      timestamp: baseFields.timestamp,
      place: baseFields.place,
      "admin-id": baseFields.adminId,
      "admin-name": baseFields.adminName,
      "admin-hash": adminHash,
    };
    expect(verifyIframeEntrySignature(query, secret, NOW_MS).valid).toBe(false);
  });

  it("rejects an expired timestamp (more than 5 minutes in the past)", () => {
    const staleTimestamp = String(NOW_SECONDS - 6 * 60);
    const fields = { ...baseFields, timestamp: staleTimestamp };
    const adminHash = signAdminHash(fields);
    const query = {
      shop: fields.shop,
      timestamp: fields.timestamp,
      place: fields.place,
      "admin-id": fields.adminId,
      "admin-name": fields.adminName,
      "admin-hash": adminHash,
    };
    expect(verifyIframeEntrySignature(query, secret, NOW_MS).valid).toBe(false);
  });

  it("rejects a far-future timestamp (more than 1 minute ahead, beyond clock-skew tolerance)", () => {
    const futureTimestamp = String(NOW_SECONDS + 5 * 60);
    const fields = { ...baseFields, timestamp: futureTimestamp };
    const adminHash = signAdminHash(fields);
    const query = {
      shop: fields.shop,
      timestamp: fields.timestamp,
      place: fields.place,
      "admin-id": fields.adminId,
      "admin-name": fields.adminName,
      "admin-hash": adminHash,
    };
    expect(verifyIframeEntrySignature(query, secret, NOW_MS).valid).toBe(false);
  });

  it("accepts a timestamp within the small forward clock-skew allowance", () => {
    const slightlyFutureTimestamp = String(NOW_SECONDS + 30);
    const fields = { ...baseFields, timestamp: slightlyFutureTimestamp };
    const adminHash = signAdminHash(fields);
    const query = {
      shop: fields.shop,
      timestamp: fields.timestamp,
      place: fields.place,
      "admin-id": fields.adminId,
      "admin-name": fields.adminName,
      "admin-hash": adminHash,
    };
    expect(verifyIframeEntrySignature(query, secret, NOW_MS).valid).toBe(true);
  });

  it("also accepts a millisecond-unit timestamp (auto-detected via magnitude)", () => {
    const fields = { ...baseFields, timestamp: String(NOW_MS) };
    const adminHash = signAdminHash(fields);
    const query = {
      shop: fields.shop,
      timestamp: fields.timestamp,
      place: fields.place,
      "admin-id": fields.adminId,
      "admin-name": fields.adminName,
      "admin-hash": adminHash,
    };
    expect(verifyIframeEntrySignature(query, secret, NOW_MS).valid).toBe(true);
  });

  it("rejects a non-numeric timestamp, without throwing", () => {
    const query = {
      shop: baseFields.shop,
      timestamp: "not-a-number",
      place: baseFields.place,
      "admin-id": baseFields.adminId,
      "admin-name": baseFields.adminName,
      "admin-hash": "irrelevant",
    };
    expect(() => verifyIframeEntrySignature(query, secret, NOW_MS)).not.toThrow();
    expect(verifyIframeEntrySignature(query, secret, NOW_MS).valid).toBe(false);
  });

  it("rejects when a required field (shop) is missing entirely, without throwing", () => {
    const adminHash = computeAppStoreCallbackHash(secret, {
      "admin-id": baseFields.adminId,
      "admin-name": baseFields.adminName,
      place: baseFields.place,
      timestamp: baseFields.timestamp,
    });
    const query = {
      timestamp: baseFields.timestamp,
      place: baseFields.place,
      "admin-id": baseFields.adminId,
      "admin-name": baseFields.adminName,
      "admin-hash": adminHash,
    };
    expect(() => verifyIframeEntrySignature(query, secret, NOW_MS)).not.toThrow();
    expect(verifyIframeEntrySignature(query, secret, NOW_MS).valid).toBe(false);
  });
});
