import axios, { type AxiosInstance } from "axios";

import { env } from "../config/env";

type OAuthResponse = {
  access_token: string;
  token_type: "Bearer" | string;
  expires_in: number;
  scope?: string;
};

type CachedToken = {
  value: string;
  expiresAt: number;
};

export class ShoperClient {
  private readonly http: AxiosInstance;

  private tokenCache?: CachedToken;

  constructor(httpInstance?: AxiosInstance) {
    const baseURL = env.SHOPER_BASE_URL;

    this.http =
      httpInstance ??
      axios.create({
        baseURL,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 15000,
      });
  }

  private ensureCredentials() {
    if (!env.SHOPER_CLIENT_ID || !env.SHOPER_CLIENT_SECRET) {
      throw new Error(
        "Brak poświadczeń Shoper API. Uzupełnij SHOPER_CLIENT_ID oraz SHOPER_CLIENT_SECRET.",
      );
    }
  }

  private async fetchAccessToken(): Promise<CachedToken> {
    this.ensureCredentials();

    const payload = new URLSearchParams({
      grant_type: "client_credentials",
    });

    const basicToken = Buffer.from(
      `${env.SHOPER_CLIENT_ID!}:${env.SHOPER_CLIENT_SECRET!}`,
    ).toString("base64");

    const { data } = await this.http.post<OAuthResponse>("/oauth/token", payload, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicToken}`,
      },
    });

    const expiresAt = Date.now() + (data.expires_in - 60) * 1000;

    return {
      value: data.access_token,
      expiresAt,
    };
  }

  private async getToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.value;
    }

    this.tokenCache = await this.fetchAccessToken();
    return this.tokenCache.value;
  }

  private async authorizedRequest<T>(
    method: "get" | "post" | "put" | "delete",
    url: string,
    data?: unknown,
  ) {
    const token = await this.getToken();

    return this.http.request<T>({
      method,
      url,
      data,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  }

  async getShops() {
    const response = await this.authorizedRequest<{ list: unknown[] }>("get", "/shops");
    return response.data;
  }
}
