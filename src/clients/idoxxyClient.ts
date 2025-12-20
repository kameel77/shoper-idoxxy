import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
} from "axios";

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

type CustomerRegistrationRequest = {
  email: string;
  firstName?: string;
  lastName?: string;
};

type Customer = {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
};

type CustomerToList = {
  id: string;
  email: string;
};

type CustomerGroup = {
  id: string;
  groupName: string;
};

type CustomerWithGroups = {
  id: string;
  email: string;
  customerGroups: CustomerGroup[];
};

type GroupToList = {
  id: string;
  groupName: string;
  deferred: boolean;
  createdAt: string;
  updatedAt?: string;
};

type GroupToListWithCustomers = {
  id: string;
  groupName: string;
  customers: CustomerToList[];
  deferred: boolean;
};

type PageResponse<T> = {
  content: T[];
  totalElements?: number;
  totalPages?: number;
  size?: number;
  number?: number;
};

type UpdateGroupRequest = {
  newName?: string;
  customerIds?: string[];
};

type RequestMetadata = {
  startTime: number;
};

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 300;

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
        timeout: 10000,
      });

    if (!this.http.defaults.baseURL) {
      this.http.defaults.baseURL = baseURL;
    }

    this.http.defaults.timeout = 10000;
    this.setupLogging();
  }

  private setupLogging() {
    this.http.interceptors.request.use((config) => {
      const method = (config.method ?? "get").toUpperCase();
      const url = `${config.baseURL ?? ""}${config.url ?? ""}`;
      (config as AxiosRequestConfig & { metadata?: RequestMetadata }).metadata = {
        startTime: Date.now(),
      };

      // eslint-disable-next-line no-console
      console.info("[Idoxxy] Request", { method, url });
      return config;
    });

    this.http.interceptors.response.use(
      (response) => {
        const metadata = (
          response.config as AxiosRequestConfig & { metadata?: RequestMetadata }
        ).metadata;
        const durationMs = metadata ? Date.now() - metadata.startTime : undefined;

        // eslint-disable-next-line no-console
        console.info("[Idoxxy] Response", {
          method: response.config.method?.toUpperCase(),
          url: `${response.config.baseURL ?? ""}${response.config.url ?? ""}`,
          status: response.status,
          durationMs,
        });
        return response;
      },
      (error: AxiosError) => {
        const config = error.config ?? {};
        const metadata = (config as AxiosRequestConfig & { metadata?: RequestMetadata })
          .metadata;
        const durationMs = metadata ? Date.now() - metadata.startTime : undefined;

        // eslint-disable-next-line no-console
        console.info("[Idoxxy] Response error", {
          method: config.method?.toUpperCase(),
          url: `${config.baseURL ?? ""}${config.url ?? ""}`,
          status: error.response?.status,
          durationMs,
          message: error.message,
        });
        return Promise.reject(error);
      },
    );
  }

  private async sleep(delayMs: number) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private shouldRetry(error: AxiosError) {
    if (!error.response) {
      return true;
    }

    const status = error.response.status;
    return status >= 500 || status === 429;
  }

  private async requestWithRetry<T>(
    config: AxiosRequestConfig,
    attempt = 1,
  ) {
    try {
      return await this.http.request<T>(config);
    } catch (error) {
      if (
        axios.isAxiosError(error) &&
        this.shouldRetry(error) &&
        attempt < MAX_RETRIES
      ) {
        const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await this.sleep(delayMs);
        return this.requestWithRetry<T>(config, attempt + 1);
      }

      throw error;
    }
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

    const { data } = await this.requestWithRetry<OAuthTokenResponse>({
      method: "post",
      url: "/oauth/token",
      data: payload,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

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
  );
  private async authorizedRequest<T>(options: {
    method: "get" | "post" | "put" | "delete";
    url: string;
    data?: unknown;
    params?: Record<string, unknown>;
  });
  private async authorizedRequest<T>(
    methodOrOptions:
      | {
          method: "get" | "post" | "put" | "delete";
          url: string;
          data?: unknown;
          params?: Record<string, unknown>;
        }
      | "get"
      | "post"
      | "put"
      | "delete",
    url?: string,
    options?: { data?: unknown; params?: Record<string, unknown> },
  ) {
    const token = await this.getAccessToken();

    const config =
      typeof methodOrOptions === "string"
        ? {
            method: methodOrOptions,
            url: url ?? "",
            data: options?.data,
            params: options?.params,
          }
        : methodOrOptions;

    return this.requestWithRetry<T>({
      method: config.method,
      url: config.url,
      data: config.data,
      params: config.params,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-API-KEY": env.IDOXXY_API_KEY,
      },
    });
  }

  async getAccountDetails() {
    const response = await this.authorizedRequest<Record<string, unknown>>({
      method: "get",
      url: "/details/me",
    });

    return response.data;
  }

  async listGroups(params?: { search?: string; page?: number; size?: number }) {
    const response = await this.authorizedRequest<PageResponse<GroupToList>>(
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

  async getGroups(params?: {
    groupName?: string;
    showDeferred?: boolean;
    page?: number;
    size?: number;
  }) {
    return this.listGroups({
      search: params?.groupName,
      page: params?.page,
      size: params?.size,
    });
  }

  async createCustomer(payload: CustomerRegistrationRequest) {
    const response = await this.authorizedRequest<Customer>({
      method: "post",
      url: "/customer",
      data: payload,
    });

    return response.data;
  }

  async listCustomers(params?: { searchQuery?: string; page?: number; size?: number }) {
    const response = await this.authorizedRequest<PageResponse<CustomerToList>>({
      method: "get",
      url: "/customer/listAll",
      params,
    });

    return response.data;
  }

  async getGroup(groupId: string) {
    const response = await this.authorizedRequest<GroupToListWithCustomers>({
      method: "get",
      url: `/groups/${groupId}`,
    });

    return response.data;
  }

  async updateGroup(groupId: string, payload: UpdateGroupRequest) {
    const response = await this.authorizedRequest<GroupToListWithCustomers>({
      method: "put",
      url: `/groups/${groupId}`,
      data: payload,
    });

    return response.data;
  }

  async listCustomersWithGroups(params?: {
    search?: string;
    page?: number;
    size?: number;
  }) {
    const response = await this.authorizedRequest<PageResponse<CustomerWithGroups>>(
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

  async getCustomerGroups(customerId: string) {
    const response = await this.listCustomersWithGroups({
      search: customerId,
      size: 200,
    });

    const match = response.content.find((customer) => customer.id === customerId);
    return match?.customerGroups ?? [];
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

  async addCustomerToGroup(groupId: string, customerId: string) {
    const group = await this.getGroup(groupId);
    const customerIds = new Set(group.customers.map((customer) => customer.id));
    customerIds.add(customerId);

    return this.updateGroup(groupId, {
      customerIds: Array.from(customerIds),
    });
  }

  async removeCustomerFromGroup(groupId: string, customerId: string) {
    const group = await this.getGroup(groupId);
    const customerIds = group.customers
      .map((customer) => customer.id)
      .filter((id) => id !== customerId);

    return this.updateGroup(groupId, {
      customerIds,
    });
  }

  async listCustomersWithGroups(params?: {
    search?: string;
    page?: number;
    size?: number;
  }) {
    const response = await this.authorizedRequest<PageResponse<CustomerWithGroups>>(
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

  async getCustomerGroups(customerId: string) {
    const response = await this.authorizedRequest<PageResponse<CustomerWithGroups>>(
      "get",
      "/groups/list-customers-with-groups",
      {
        params: {
          searchQuery: customerId,
          page: 0,
          size: 1,
        },
      },
    );

    return (
      response.data.content.find((customer) => customer.id === customerId) ??
      response.data.content[0]
    );
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

  async assignCustomersToGroup(payload: {
    groupId: string;
    customerIds: string[];
  }) {
    const response = await this.authorizedRequest<Record<string, unknown>>(
      "put",
      `/groups/${payload.groupId}`,
      {
        data: {
          customerIds: payload.customerIds,
        },
      },
    );

    return response.data;
  }
}
