import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import axios from "axios";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

import { createApp } from "../src/app";
import { shopConnectionService } from "../src/services/shopConnectionService";
import { IdoxxyClient } from "../src/clients/idoxxyClient";

class Agent {
  readonly cookies = new Map<string, string>();
  constructor(private readonly base: string) {}

  async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookieHeader = Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    if (cookieHeader) headers.set("Cookie", cookieHeader);

    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers,
      redirect: "manual",
    });

    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const cookie of setCookies) {
      const pair = cookie.split(";")[0];
      const eqIndex = pair?.indexOf("=") ?? -1;
      if (pair && eqIndex > 0) {
        this.cookies.set(pair.slice(0, eqIndex), pair.slice(eqIndex + 1));
      }
    }

    return res;
  }

  async json(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<{ status: number; body: any }> {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("Content-Type", "application/json");
    const res = await this.raw(path, {
      ...rest,
      headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  async csrfToken(): Promise<string> {
    const res = await this.json("/settings/csrf");
    expect(res.status).toBe(200);
    return res.body.csrfToken as string;
  }
}

describe("Customer profile, bulk actions, and settings config", () => {
  let server: Server;
  let baseUrl: string;
  let shopAgent: Agent;
  const SHOP_HOST = "customer-test.example-shoper.pl";
  const SHOP_TOKEN = "idoxxy-test-token-123";
  let shopId: string;

  beforeAll(async () => {
    vi.spyOn(axios, "post").mockImplementation(async (url: unknown) => {
      if (typeof url === "string" && url.includes("/webapi/rest/oauth/token")) {
        return {
          data: {
            access_token: `access-${randomUUID()}`,
            refresh_token: `refresh-${randomUUID()}`,
            token_type: "bearer",
          },
        };
      }
      throw new Error(`Unexpected axios.post: ${String(url)}`);
    });

    vi.spyOn(axios, "get").mockImplementation(async (url: unknown) => {
      if (typeof url === "string" && url.includes("/webapi/rest/application-info")) {
        return { data: { shop_id: "customer-test" } };
      }
      if (typeof url === "string" && url.includes("/webapi/rest/application-config")) {
        return { data: {} };
      }
      throw new Error(`Unexpected axios.get: ${String(url)}`);
    });

    vi.spyOn(axios, "create").mockImplementation((config?: any) => {
      const instance: any = {
        defaults: { ...(config ?? {}) },
        interceptors: {
          request: { use: () => 0 },
          response: { use: () => 0 },
        },
        request: vi.fn(async (reqConfig: any) => {
          const method = (reqConfig.method ?? "get").toLowerCase();
          const url: string = reqConfig.url ?? "";

          if (method === "get" && url === "/groups/list-customers-with-groups") {
            const customerId = reqConfig.params?.searchQuery;
            return {
              data: {
                content: [
                  {
                    id: customerId || "cust-1",
                    email: "kamil@example.com",
                    firstName: "Kamil",
                    lastName: "Tonkowicz",
                    customerGroups: [{ id: "group-1", groupName: "General" }],
                    createdAt: "2026-01-01T00:00:00Z",
                    updatedAt: "2026-01-02T00:00:00Z",
                  },
                ],
              },
              status: 200,
              config: reqConfig,
              headers: {},
            };
          }

          if (method === "get" && /^\/groups\/[^/]+$/.test(url)) {
            const groupId = url.split("/")[2];
            return {
              data: {
                id: groupId,
                groupName: "Test Group",
                customers: [{ id: "existing-cust", email: "existing@example.com" }],
              },
              status: 200,
              config: reqConfig,
              headers: {},
            };
          }

          if (method === "put" && /^\/groups\//.test(url)) {
            return { data: { ok: true }, status: 200, config: reqConfig, headers: {} };
          }

          return { data: { content: [] }, status: 200, config: reqConfig, headers: {} };
        }),
      };
      return instance;
    });

    const app = createApp();
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    shopAgent = new Agent(baseUrl);
    const res = await shopAgent.raw(
      `/oauth/callback?code=${encodeURIComponent(randomUUID())}&shop_url=${encodeURIComponent(SHOP_HOST)}`,
    );
    expect(res.status).toBe(302);
    shopId = "customer-test";

    shopConnectionService.saveLink({
      shopId,
      token: SHOP_TOKEN,
      status: "linked",
      tokenLastVerifiedAt: Date.now(),
      shopUrl: `https://${SHOP_HOST}`,
      idoxxyWorkspaceId: "ws-1",
      idoxxyBaseUrl: undefined,
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /settings/config returns shopUrl and connectionStatus", async () => {
    const res = await shopAgent.json("/settings/config");
    expect(res.status).toBe(200);
    expect(res.body.shopUrl).toBe(`https://${SHOP_HOST}`);
    expect(res.body.isLinked).toBe(true);
    expect(res.body.connectionStatus).toBe("linked");
  });

  it("GET /admin/idoxxy/customers/:id returns customer details", async () => {
    const res = await shopAgent.json("/admin/idoxxy/customers/cust-123");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.customer).toBeDefined();
    expect(res.body.customer.email).toBe("kamil@example.com");
    expect(res.body.customer.name).toBe("Kamil Tonkowicz");
    expect(res.body.customer.groupIds).toEqual(["group-1"]);
    expect(res.body.customer.groups).toEqual(["General"]);
  });

  it("IdoxxyClient.addCustomersToGroup preserves existing customers in the group", async () => {
    const client = new IdoxxyClient(undefined, { apiKey: SHOP_TOKEN });
    const updateGroupSpy = vi.spyOn(client, "updateGroup").mockResolvedValue({} as any);

    await client.addCustomersToGroup("group-test", ["new-cust-1", "new-cust-2"]);

    expect(updateGroupSpy).toHaveBeenCalledWith("group-test", {
      customerIds: ["existing-cust", "new-cust-1", "new-cust-2"],
    });
  });
});
