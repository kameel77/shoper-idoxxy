import axios, { type AxiosInstance } from "axios";

import { env } from "../config/env";

type OAuthTokenResponse = {
  access_token: string;
  token_type: "bearer" | string;
  expires_in: number;
  scope?: string;
};

type CachedToken = {
  value: string;
  expiresAt: number;
};

export class IdoxxyClient {
  private readonly http: AxiosInstance;

  private tokenCache?: CachedToken;

  constructor(httpInstance?: AxiosInstance) {
    const baseURL = env.IDOXXY_BASE_URL ?? "https://api.idoxxy.com";

    this.http =
      httpInstance ??
      axios.create({
        baseURL,
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 15000,
      });
  }

  private ensureCredentials() {
    if (!env.IDOXXY_CLIENT_ID || !env.IDOXXY_CLIENT_SECRET) {
      throw new Error(
        "Brak poświadczeń OAuth2 dla Idoxxy. Uzupełnij IDOXXY_CLIENT_ID i IDOXXY_CLIENT_SECRET.",
      );
    }

    if (!env.IDOXXY_API_KEY) {
      throw new Error("Brak klucza API Idoxxy. Uzupełnij IDOXXY_API_KEY.");
    }
  }

  private async fetchToken(): Promise<CachedToken> {
    this.ensureCredentials();

    const payload = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.IDOXXY_CLIENT_ID!,
      client_secret: env.IDOXXY_CLIENT_SECRET!,
    });

    const { data } = await this.http.post<OAuthTokenResponse>(
      "/oauth/token",
      payload,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    const expiresAt = Date.now() + (data.expires_in - 60) * 1000;

    return {
      value: data.access_token,
      expiresAt,
    };
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.value;
    }

    this.tokenCache = await this.fetchToken();
    return this.tokenCache.value;
  }

  private async authorizedRequest<T>(
    method: "get" | "post" | "put" | "delete",
    url: string,
    options?: { data?: unknown; params?: Record<string, unknown> },
  ) {
    const token = await this.getAccessToken();

    return this.http.request<T>({
      method,
      url,
      data: options?.data,
      params: options?.params,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-API-KEY": env.IDOXXY_API_KEY,
      },
    });
  }

  async getAccountDetails() {
    const response = await this.authorizedRequest<Record<string, unknown>>(
      "get",
      "/details/me",
    );

    return response.data;
  }

  async listGroups(params?: { search?: string; page?: number; size?: number }) {
    const response = await this.authorizedRequest<Record<string, unknown>>(
      "get",
      "/groups/search",
      {
        params: {
          groupName: params?.search || undefined,
          page: params?.page ?? 0,
          size: params?.size ?? 100,
        },
      },
    );

    return response.data;
  }

  async listCustomersWithGroups(params?: {
    search?: string;
    page?: number;
    size?: number;
  }) {
    const response = await this.authorizedRequest<Record<string, unknown>>(
      "get",
      "/groups/list-customers-with-groups",
      {
        params: {
          searchQuery: params?.search || undefined,
          page: params?.page ?? 0,
          size: params?.size ?? 100,
        },
      },
    );

    return response.data;
  }

  async addCustomersToGroup(groupId: string, customerIds: string[]) {
    const response = await this.authorizedRequest<Record<string, unknown>>(
      "put",
      `/groups/${groupId}`,
      {
        data: {
          customerIds,
        },
      },
    );

    return response.data;
  }
}
