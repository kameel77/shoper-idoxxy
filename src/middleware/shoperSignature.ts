import crypto from "node:crypto";

/**
 * Shared signature-verification primitives for everything Shoper sends us:
 * event webhooks (src/routes/webhooks.ts) and App Store lifecycle/billing
 * callbacks (src/routes/install.ts). Kept in one module so both call sites
 * share the same constant-time comparison instead of duplicating it.
 *
 * These are two genuinely different schemes (different header/param, secret
 * and hash algorithm) - see the doc comments on each pair of functions below
 * for what is confirmed against Shoper's own docs vs. this app's own design.
 */

/**
 * Constant-time equality check that never throws, regardless of input shape.
 * crypto.timingSafeEqual() throws on a buffer-length mismatch, and header
 * values are fully attacker-controlled (including non-hex garbage or a
 * different length than expected), so a naive "just call timingSafeEqual"
 * would let a malformed request crash the handler instead of being rejected
 * with 401/200-no-op like every other invalid signature.
 *
 * A length mismatch short-circuits before the timingSafeEqual call - that is
 * safe here because the "expected" side length is a constant property of the
 * hash algorithm (always the same digest length), not attacker-derived or
 * secret-derived, so its return timing leaks nothing an attacker doesn't
 * already know.
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");

  if (bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
};

// ---------------------------------------------------------------------------
// Event webhooks (customer.created / order.created) - src/routes/webhooks.ts
//
// Two schemes are accepted here (src/routes/webhooks.ts's verifyShoperSignature
// tries both and takes either match), because we don't yet have a real
// delivery from the owner's dev shop (devshop-144794.shoparena.pl, webhook
// ids 35/36) to settle which one Shoper actually sends:
//
// 1. computeDocumentedWebhookSignature / verifyDocumentedWebhookSignature -
//    CONFIRMED against Shoper's own published documentation
//    (https://www.shoper.pl/learn/artykul/jak-utworzyc-webhook, "Jak
//    utworzyć webhook?"). Its PHP reference example is:
//
//      sha1($_SERVER['HTTP_X_WEBHOOK_ID'] . ':' . $secret_key . ':' . $data)
//
//    compared against the HTTP_X_WEBHOOK_SHA1 header (i.e. X-Webhook-SHA1 /
//    X-Webhook-Id over HTTP). Note this is a bare SHA-1 digest of a
//    colon-joined string, NOT an HMAC - do not "upgrade" it to createHmac.
//    `secret_key` is the optional "Klucz" field the shop admin types in when
//    creating the webhook in the Shoper admin panel, i.e. the same shared
//    secret as SHOPER_WEBHOOK_SECRET.
//
// 2. computeEventWebhookSignature / verifyEventWebhookSignature - the
//    HMAC-SHA256-over-raw-body scheme this app shipped with originally
//    (X-Shoper-Webhook-Signature / X-Shoper-Signature headers). Its origin is
//    UNCONFIRMED against any Shoper documentation found so far (see
//    docs/shoper-test-readiness-audit.md item D) - kept only as a
//    compatibility fallback in case Shoper's real behaviour diverges from its
//    own docs. src/routes/webhooks.ts logs (once per process, not per
//    request) which scheme actually matched on the first successful
//    verification, specifically so the owner's dev shop can settle this
//    empirically. Once that's confirmed, drop whichever scheme turns out to
//    be wrong.
// ---------------------------------------------------------------------------

export const computeDocumentedWebhookSignature = (
  webhookId: string,
  secret: string,
  rawBody: Buffer,
): string =>
  crypto
    .createHash("sha1")
    .update(`${webhookId}:${secret}:${rawBody.toString("utf8")}`)
    .digest("hex");

export const verifyDocumentedWebhookSignature = (
  webhookId: string | undefined,
  signatureHeader: string | undefined,
  rawBody: Buffer | undefined,
  secret: string,
): boolean => {
  if (!webhookId || !signatureHeader || !rawBody) {
    return false;
  }

  const expected = computeDocumentedWebhookSignature(webhookId, secret, rawBody);
  // Same case-insensitive comparison rationale as verifyEventWebhookSignature
  // below: normalize at the call site, not inside constantTimeEqual.
  return constantTimeEqual(signatureHeader.trim().toLowerCase(), expected.toLowerCase());
};

export const computeEventWebhookSignature = (secret: string, rawBody: Buffer): string =>
  crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

export const verifyEventWebhookSignature = (
  signatureHeader: string | undefined,
  rawBody: Buffer | undefined,
  secret: string,
): boolean => {
  if (!signatureHeader || !rawBody) {
    return false;
  }

  const expected = computeEventWebhookSignature(secret, rawBody);
  // digest("hex") is always lowercase; the header is attacker/sender-supplied
  // and Shoper's own casing convention for it is not something we can pin
  // down for certain, so normalize both sides here (not inside
  // constantTimeEqual, which stays a general-purpose, case-sensitive
  // primitive) rather than silently rejecting a validly-signed request that
  // merely arrives as uppercase hex.
  return constantTimeEqual(signatureHeader.trim().toLowerCase(), expected.toLowerCase());
};

// ---------------------------------------------------------------------------
// App Store lifecycle / billing callbacks (install/upgrade/uninstall/billing_*)
// - src/routes/install.ts
//
// CONFIRMED against Shoper's own published OpenAPI document
// (https://developers.shoper.pl/openapi/appstore.yaml, "Billing System"
// section, fetched 2026-08-14): every message the platform POSTs to the
// registered "automatic messages" URL carries a `hash` field computed as:
//
//   1. Remove `hash` from the parameter set.
//   2. Sort the remaining parameters alphabetically by key.
//   3. Join each pair as "key=value".
//   4. Join all pairs with "&".
//   5. hash = HMAC-SHA512(that string, key = appstore_secret)
//
// where appstore_secret is generated during application registration in the
// Shoper AppStore developer panel - a distinct secret from SHOPER_WEBHOOK_SECRET
// (which protects the unrelated customer/order event webhooks above). See
// SHOPER_APPSTORE_SECRET in src/config/env.ts.
// ---------------------------------------------------------------------------

const stringifyParamValue = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Arrays/objects are not part of Shoper's flat billing-message schema.
  // Skipping them (rather than JSON-stringifying) keeps the hash computation
  // unambiguous and not attacker-shaped.
  return undefined;
};

export const computeAppStoreCallbackHash = (
  secret: string,
  params: Record<string, string>,
): string => {
  const paramString = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");

  return crypto.createHmac("sha512", secret).update(paramString).digest("hex");
};

export const verifyAppStoreCallbackSignature = (
  body: Record<string, unknown> | undefined,
  secret: string,
): boolean => {
  if (!body) {
    return false;
  }

  const receivedHash = body.hash;
  if (typeof receivedHash !== "string" || !receivedHash) {
    return false;
  }

  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "hash") continue;
    const stringValue = stringifyParamValue(value);
    if (stringValue !== undefined) {
      params[key] = stringValue;
    }
  }

  const expected = computeAppStoreCallbackHash(secret, params);
  // Same rationale as verifyEventWebhookSignature above: normalize case here,
  // at the call site, so an uppercase-hex `hash` from Shoper isn't silently
  // (and, per PHP's hash_hmac() default output, unexpectedly) rejected.
  return constantTimeEqual(receivedHash.toLowerCase(), expected.toLowerCase());
};

// ---------------------------------------------------------------------------
// Shop Panel iframe entry - src/routes/settings.ts (GET /settings)
//
// Per Shoper's docs (developers.shoper.pl/docs, "Shop Panel Integration ->
// Iframe Security - Hash Verification"), when a shop admin opens this app's
// iframe from the Shoper panel, Shoper appends `application`, `shop`,
// `timestamp`, `place`, `admin-id`, `admin-name`, `hash` and `admin-hash` to
// the URL. The reference PHP computation for `admin-hash` is:
//
//   $params = ["admin-id" => ..., "admin-name" => ..., "place" => ...,
//              "shop" => ..., "timestamp" => ...];
//   ksort($params);
//   $param_string = join("&", array_map(fn($k,$v) => "$k=$v", array_keys($params), $params));
//   $admin_hash = hash_hmac('sha512', $param_string, $appstore_secret);
//
// i.e. the exact same "sort keys, join as key=value with &, HMAC-SHA512 with
// appstore_secret" construction as computeAppStoreCallbackHash above - so
// this reuses that function rather than reimplementing it. `hash` (legacy,
// kept for backward compatibility with shops on version < 5.8.14, which don't
// send admin-id/admin-name) is the same computation over only `place`,
// `shop`, `timestamp`.
//
// NOTE ON VERIFICATION: live access to developers.shoper.pl was not available
// while writing this (the docs site is a client-rendered SPA that every
// available fetch tool in this environment failed against - see the task's
// final report for the full list of attempts). This implementation is built
// directly from the task's PHP reference and reuses the already-confirmed
// HMAC-SHA512 sorted-params scheme from the billing callbacks above (same
// secret, same construction) - it has NOT been independently re-verified
// against Shoper's live docs page.
// ---------------------------------------------------------------------------

/** Fields Shoper signs into `admin-hash` (only present since shop v5.8.14). */
const ADMIN_HASH_FIELDS = ["admin-id", "admin-name", "place", "shop", "timestamp"] as const;
/** Fields Shoper signs into the legacy `hash` (sent by every shop version). */
const LEGACY_HASH_FIELDS = ["place", "shop", "timestamp"] as const;

const firstQueryValue = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
};

/**
 * Replay window for iframe entry: reject a `timestamp` older than 5 minutes
 * or more than 1 minute in the future (allowing for clock skew between our
 * server and Shoper's). Shoper's docs don't state an expiry for this value -
 * this window is a defensive choice by this app, not a documented Shoper
 * requirement.
 */
const REPLAY_WINDOW_PAST_MS = 5 * 60 * 1000;
const REPLAY_WINDOW_FUTURE_MS = 60 * 1000;

// Threshold to distinguish a Unix seconds timestamp from a Unix milliseconds
// one: 1e12 ms corresponds to 2001-09-09, and no plausible "current" seconds
// timestamp reaches 1e12 (that's the year 33658 in seconds). Any bare numeric
// timestamp below this threshold is therefore treated as seconds, at/above it
// as milliseconds.
//
// UNIT NOT INDEPENDENTLY CONFIRMED: Shoper's docs (as far as reachable while
// writing this) don't state whether `timestamp` is seconds or milliseconds.
// This app's primary hypothesis is **seconds** - the platform's own PHP
// reference code overwhelmingly suggests a PHP backend, and PHP's idiomatic
// `time()` for a bare "timestamp" GET parameter returns Unix seconds - but
// this auto-detecting normalizer accepts either so a wrong guess fails safe
// (rejects as expired/malformed) rather than silently accepting a stale or
// far-future request.
const SECONDS_MS_THRESHOLD = 1e12;

const normalizeTimestampToMs = (raw: string | undefined): number | undefined => {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return num < SECONDS_MS_THRESHOLD ? num * 1000 : num;
};

const isWithinReplayWindow = (timestampMs: number, nowMs: number): boolean => {
  const delta = nowMs - timestampMs;
  return delta <= REPLAY_WINDOW_PAST_MS && delta >= -REPLAY_WINDOW_FUTURE_MS;
};

export type IframeEntrySignatureResult =
  | { valid: false }
  | {
      valid: true;
      /** Which field the platform actually sent: "admin-hash" (v5.8.14+) or the legacy "hash". */
      scheme: "admin-hash" | "hash";
      shop: string;
      adminId: string | undefined;
      adminName: string | undefined;
    };

/**
 * Verify Shoper's signed iframe-entry query parameters. Tries `admin-hash`
 * over the five documented fields first; if `admin-id`/`admin-name` are
 * absent (older shop versions), falls back to the legacy `hash` over just
 * `place`/`shop`/`timestamp`. Also enforces the replay window on `timestamp`.
 *
 * Returns `{ valid: false }` on ANY problem (missing/tampered signature,
 * wrong secret, expired/future timestamp, missing required fields) - callers
 * must treat that identically to "no signature at all" and must not widen
 * the trust boundary on a partial/ambiguous result.
 */
export const verifyIframeEntrySignature = (
  query: Record<string, unknown>,
  secret: string,
  now: number = Date.now(),
): IframeEntrySignatureResult => {
  const shop = firstQueryValue(query.shop);
  const place = firstQueryValue(query.place);
  const timestampRaw = firstQueryValue(query.timestamp);
  const adminId = firstQueryValue(query["admin-id"]);
  const adminName = firstQueryValue(query["admin-name"]);
  const adminHash = firstQueryValue(query["admin-hash"]);
  const legacyHash = firstQueryValue(query.hash);

  if (!shop || !place || !timestampRaw) {
    return { valid: false };
  }

  const timestampMs = normalizeTimestampToMs(timestampRaw);
  if (timestampMs === undefined || !isWithinReplayWindow(timestampMs, now)) {
    return { valid: false };
  }

  const allFieldValues: Record<(typeof ADMIN_HASH_FIELDS)[number], string> = {
    "admin-id": adminId ?? "",
    "admin-name": adminName ?? "",
    place,
    shop,
    timestamp: timestampRaw,
  };

  if (adminId && adminName && adminHash) {
    const params: Record<string, string> = {};
    for (const field of ADMIN_HASH_FIELDS) {
      params[field] = allFieldValues[field];
    }
    const expected = computeAppStoreCallbackHash(secret, params);
    if (constantTimeEqual(adminHash.toLowerCase(), expected.toLowerCase())) {
      return { valid: true, scheme: "admin-hash", shop, adminId, adminName };
    }
    return { valid: false };
  }

  if (legacyHash) {
    const params: Record<string, string> = {};
    for (const field of LEGACY_HASH_FIELDS) {
      params[field] = allFieldValues[field];
    }
    const expected = computeAppStoreCallbackHash(secret, params);
    if (constantTimeEqual(legacyHash.toLowerCase(), expected.toLowerCase())) {
      return { valid: true, scheme: "hash", shop, adminId: undefined, adminName: undefined };
    }
    return { valid: false };
  }

  return { valid: false };
};
