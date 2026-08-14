import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * End-to-end coverage for verifyShoperSignature's "either scheme validates"
 * semantics (src/routes/webhooks.ts): Shoper's documented sha1(webhookId:
 * secret:body) scheme and this app's original HMAC-SHA256-over-raw-body
 * scheme are both accepted, independently, on the same endpoint - see
 * src/middleware/shoperSignature.ts for why both are still in play (no real
 * delivery from the owner's dev shop has settled which one Shoper sends yet).
 *
 * The request body is always `{}` (mirrors the existing "public endpoints
 * stay reachable" case in tests/shop-session-auth.test.ts): once the
 * signature passes, resolveShopId() fails for its own reasons (no shop id in
 * an empty body) and the handler responds 400 - that's fine, this suite only
 * asserts on whether the response is 401 (rejected by signature) or not.
 */

let server: Server;
let baseUrl: string;

const SECRET = "e2e-test-webhook-secret-at-least-32-characters-long";
const WEBHOOK_ID = "35";
const RAW_BODY = "{}";

beforeEach(async () => {
  vi.resetModules();
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `idoxxy-test-webhook-sig-${randomUUID()}.db`);
  process.env.SHOPER_WEBHOOK_SECRET = SECRET;

  const { createApp } = await import("../src/app");
  const app = createApp();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  delete process.env.SHOPER_WEBHOOK_SECRET;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type ExtraHeaders = Record<string, string>;

const postWebhook = (headers: ExtraHeaders) =>
  fetch(`${baseUrl}/webhooks/shoper/customer-created`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: RAW_BODY,
  });

const validDocumentedHeaders = async (): Promise<ExtraHeaders> => {
  const { computeDocumentedWebhookSignature } = await import("../src/middleware/shoperSignature");
  const signature = computeDocumentedWebhookSignature(WEBHOOK_ID, SECRET, Buffer.from(RAW_BODY));
  return { "X-Webhook-Id": WEBHOOK_ID, "X-Webhook-SHA1": signature };
};

const validHmacHeaders = async (): Promise<ExtraHeaders> => {
  const { computeEventWebhookSignature } = await import("../src/middleware/shoperSignature");
  const signature = computeEventWebhookSignature(SECRET, Buffer.from(RAW_BODY));
  return { "X-Shoper-Webhook-Signature": signature };
};

describe("POST /webhooks/shoper/customer-created signature verification", () => {
  it("rejects a request with neither signature scheme's headers (401)", async () => {
    const res = await postWebhook({});
    expect(res.status).toBe(401);
  });

  it("accepts a request signed only with Shoper's documented sha1 scheme", async () => {
    const res = await postWebhook(await validDocumentedHeaders());
    expect(res.status).not.toBe(401);
  });

  it("accepts a request signed only with the HMAC-SHA256 fallback scheme", async () => {
    const res = await postWebhook(await validHmacHeaders());
    expect(res.status).not.toBe(401);
  });

  it("accepts when the documented scheme is valid even if the HMAC header is garbage", async () => {
    const res = await postWebhook({
      ...(await validDocumentedHeaders()),
      "X-Shoper-Webhook-Signature": "not-a-valid-signature",
    });
    expect(res.status).not.toBe(401);
  });

  it("accepts when the HMAC scheme is valid even if the documented headers are garbage", async () => {
    const res = await postWebhook({
      ...(await validHmacHeaders()),
      "X-Webhook-Id": WEBHOOK_ID,
      "X-Webhook-SHA1": "not-a-valid-signature",
    });
    expect(res.status).not.toBe(401);
  });

  it("rejects when both schemes' signatures are wrong", async () => {
    const res = await postWebhook({
      "X-Webhook-Id": WEBHOOK_ID,
      "X-Webhook-SHA1": "0".repeat(40),
      "X-Shoper-Webhook-Signature": "0".repeat(64),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a documented-scheme signature computed with the wrong webhook id", async () => {
    const { computeDocumentedWebhookSignature } = await import("../src/middleware/shoperSignature");
    const wrongIdSignature = computeDocumentedWebhookSignature("999", SECRET, Buffer.from(RAW_BODY));
    const res = await postWebhook({ "X-Webhook-Id": WEBHOOK_ID, "X-Webhook-SHA1": wrongIdSignature });
    expect(res.status).toBe(401);
  });
});
