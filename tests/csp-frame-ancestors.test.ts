import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import axios from "axios";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

import { createApp } from "../src/app";

/**
 * Item 5 of the hardening task - CSP frame-ancestors narrowing. Confirms the
 * "only narrow when confident" contract: "*" stays in place for every
 * ambiguous case (no session, technical_url unknown), and only narrows to
 * the shop's own two known hosts once both shopUrl and technicalUrl are on
 * record for a verified shop session.
 *
 * Single shared app/module graph for the whole file (mirrors
 * tests/shop-session-auth.test.ts), with a tiny cookie-jar Agent so the OAuth
 * session cookie survives across requests.
 */

let server: Server;
let baseUrl: string;

class Agent {
  private cookies = new Map<string, string>();
  constructor(private readonly base: string) {}

  async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set("Cookie", [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const res = await fetch(`${this.base}${path}`, { ...init, headers, redirect: "manual" });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const cookie of setCookies) {
      const pair = cookie.split(";")[0];
      const eqIndex = pair?.indexOf("=") ?? -1;
      if (pair && eqIndex > 0) this.cookies.set(pair.slice(0, eqIndex), pair.slice(eqIndex + 1));
    }
    return res;
  }
}

const HOST_WITH_TECHNICAL_URL = "csp-both-hosts.example-shoper.pl";
const HOST_WITHOUT_TECHNICAL_URL = "csp-one-host.example-shoper.pl";
const TECHNICAL_URL_FOR = "csp-both-hosts.technical.shoper.pl";

beforeAll(async () => {
  vi.spyOn(axios, "post").mockImplementation(async (url: unknown) => {
    if (typeof url === "string" && url.includes("/webapi/rest/oauth/token")) {
      return {
        data: { access_token: `access-${randomUUID()}`, refresh_token: `refresh-${randomUUID()}` },
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
      const host = new URL(url).host;
      if (host === HOST_WITH_TECHNICAL_URL) {
        return { data: { shop_url: `https://${host}`, technical_url: `https://${TECHNICAL_URL_FOR}` } };
      }
      // Only shop_url known - technical_url deliberately absent, exercising
      // the "hosts unknown" fallback-to-* path.
      return { data: { shop_url: `https://${host}` } };
    }
    throw new Error(`Unexpected axios.get to ${String(url)} in test`);
  });

  const app = createApp();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const frameAncestorsOf = (cspHeader: string | null): string | undefined => {
  if (!cspHeader) return undefined;
  const directive = cspHeader.split(";").map((d) => d.trim()).find((d) => d.startsWith("frame-ancestors"));
  return directive;
};

describe("Content-Security-Policy frame-ancestors", () => {
  it("stays '*' for a request with no shop session", async () => {
    const res = await fetch(`${baseUrl}/settings`);
    const csp = res.headers.get("Content-Security-Policy");
    expect(frameAncestorsOf(csp)).toBe("frame-ancestors *");
  });

  it("stays '*' for a shop session whose technical_url is unknown", async () => {
    const agent = new Agent(baseUrl);
    const oauthRes = await agent.raw(
      `/oauth/callback?code=${encodeURIComponent(randomUUID())}&shop_url=${encodeURIComponent(HOST_WITHOUT_TECHNICAL_URL)}`,
    );
    expect(oauthRes.status).toBe(302);

    const res = await agent.raw("/settings");
    const csp = res.headers.get("Content-Security-Policy");
    expect(frameAncestorsOf(csp)).toBe("frame-ancestors *");
  });

  it("narrows to the shop's own two hosts once both shopUrl and technicalUrl are known", async () => {
    const agent = new Agent(baseUrl);
    const oauthRes = await agent.raw(
      `/oauth/callback?code=${encodeURIComponent(randomUUID())}&shop_url=${encodeURIComponent(HOST_WITH_TECHNICAL_URL)}`,
    );
    expect(oauthRes.status).toBe(302);

    const res = await agent.raw("/settings");
    const csp = res.headers.get("Content-Security-Policy");
    const directive = frameAncestorsOf(csp);

    expect(directive).toContain(`https://${HOST_WITH_TECHNICAL_URL}`);
    expect(directive).toContain(`https://${TECHNICAL_URL_FOR}`);
    expect(directive).not.toContain("*");
  });

  it("still applies the rest of the base CSP directives unchanged", async () => {
    const res = await fetch(`${baseUrl}/settings`);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });
});
