import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
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
  firstName?: string | undefined;
  lastName?: string | undefined;
};

type Customer = {
  id: string;
  email: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
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

type ClientConfig = {
  apiKey?: string;
  baseUrl?: string;
};

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 300;

export class IdoxxyClient {
  private readonly apiKey: string | undefined;
  private readonly http: AxiosInstance;

  private tokenCache?: CachedToken;

  constructor(httpInstance?: AxiosInstance, config: ClientConfig = {}) {
    const baseURL = config.baseUrl ?? env.IDOXXY_BASE_URL ?? "https://api.idoxxy.com";
    this.apiKey = config.apiKey ?? env.IDOXXY_API_KEY;

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
      console.info("[Idoxxy] Request", { 
        method, 
        url,
        params: config.params,
        data: config.data
      });
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
        const config = (error.config ?? {}) as AxiosRequestConfig;
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
  ): Promise<AxiosResponse<T>> {
    let lastError: AxiosError | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.http.request<T>(config);
      } catch (error) {
        if (!(error instanceof Error) || !axios.isAxiosError(error)) {
          throw error;
        }

        lastError = error;

        if (!this.shouldRetry(error) || attempt === MAX_RETRIES - 1) {
          throw error;
        }

        const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await this.sleep(delayMs);
      }
    }

    throw lastError;
  }

  private ensureCredentials() {
    if (!this.apiKey) {
      throw new Error("Brak klucza API Idoxxy. Uzupełnij IDOXXY_API_KEY.");
    }
  }

  private async fetchToken(): Promise<CachedToken> {
    this.ensureCredentials();

    const useOAuth = process.env.IDOXXY_USE_OAUTH === "true";
    if (!useOAuth || !env.IDOXXY_CLIENT_ID || !env.IDOXXY_CLIENT_SECRET) {
      const expiresAt = Date.now() + 60 * 60 * 1000;
      return {
        value: "",
        expiresAt,
      };
    }

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
    config: AxiosRequestConfig & {
      url: string;
      method: "get" | "post" | "put" | "delete";
      data?: unknown;
      params?: Record<string, unknown>;
    },
  ): Promise<AxiosResponse<T>> {
    const token = await this.getAccessToken();

    return this.requestWithRetry<T>({
      ...config,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "X-API-KEY": this.apiKey,
        ...(config.headers ?? {}),
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
    const query: Record<string, unknown> = {};
    if (params?.search !== undefined) query.groupName = params.search;
    if (params?.page !== undefined) query.page = params.page;
    if (params?.size !== undefined) query.size = params.size;

    const response = await this.authorizedRequest<PageResponse<GroupToList>>({
      method: "get",
      url: "/groups/search",
      ...(Object.keys(query).length ? { params: query } : {}),
    });

    return response.data;
  }

  async getGroups(params?: {
    groupName?: string;
    showDeferred?: boolean;
    page?: number;
    size?: number;
  }) {
    const listParams: { search?: string; page?: number; size?: number } = {};
    if (params?.groupName !== undefined) listParams.search = params.groupName;
    if (params?.page !== undefined) listParams.page = params.page;
    if (params?.size !== undefined) listParams.size = params.size;

    return this.listGroups(Object.keys(listParams).length ? listParams : undefined);
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
      ...(params ? { params } : {}),
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
    const query: Record<string, unknown> = {};
    if (params?.search !== undefined) query.searchQuery = params.search;
    if (params?.page !== undefined) query.page = params.page;
    if (params?.size !== undefined) query.size = params.size;

    const response = await this.authorizedRequest<PageResponse<CustomerWithGroups>>({
      method: "get",
      url: "/groups/list-customers-with-groups",
      ...(Object.keys(query).length ? { params: query } : {}),
    });

    return response.data;
  }

  async getCustomerGroups(customerId: string) {
    const response = await this.listCustomersWithGroups({
      search: customerId,
      size: 1,
    });

    return response.content.find((customer) => customer.id === customerId);
  }

  async addCustomersToGroup(groupId: string, customerIds: string[]) {
    const response = await this.authorizedRequest<Record<string, unknown>>({
      method: "put",
      url: `/groups/${groupId}`,
      data: { customerIds },
    });

    return response.data;
  }

  async assignCustomersToGroup(payload: { groupId: string; customerIds: string[] }) {
    return this.addCustomersToGroup(payload.groupId, payload.customerIds);
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

  async listDocuments(params?: { page?: number; size?: number }) {
    const response = await this.authorizedRequest<{
      content: Array<{
        id: string;
        documentName: string;
        documentType: string;
        currentVersion?: {
          id: string;
          validFrom: string;
          validTo: string | null;
          versionStatus: string;
          fileId: string;
          documentId: string;
        };
        recipients: Array<{
          id: string;
          name: string;
        }>;
        createdAt: string;
        updatedAt: string | null;
      }>;
      totalElements?: number;
      totalPages?: number;
    }>({
      method: "get",
      url: "/documents/listAll",
      ...(params ? { params } : {}),
    });

    return response.data;
  }

  async getCustomerDocuments(customerEmail: string) {
    const response = await this.authorizedRequest<Array<{
      companyName: string;
      documents: Array<{
        id: string;
        documentName: string;
        documentType: string;
        currentVersion?: {
          id: string;
          validFrom: string;
          validTo?: string;
          versionStatus: string;
          uniqueLink: string;
        };
        versions: Array<{
          id: string;
          validFrom: string;
          validTo?: string;
          versionStatus: string;
          uniqueLink: string;
        }>;
      }>;
    }>>({
      method: "get",
      url: "/customer/documents/listAll",
      params: { searchQuery: customerEmail },
    });

    return response.data;
  }

  async assignDocumentToGroup(documentId: string, groupIds: string[], customerIds: string[]) {
    const response = await this.authorizedRequest<Record<string, unknown>>({
      method: "put",
      url: `/documents/${documentId}/assign-group`,
      data: { groupIds, customerIds },
    });

    return response.data;
  }

  async resendDocumentNotification(documentId: string, recipients: string[]) {
    const response = await this.authorizedRequest<Record<string, unknown>>({
      method: "post",
      url: `/documents/${documentId}/resend-notification`,
      data: recipients,
    });

    return response.data;
  }
}
