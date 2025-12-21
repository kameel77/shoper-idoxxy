import { IdoxxyClient } from "../clients/idoxxyClient";
import { settingsRepository } from "../repositories/settingsRepository";
import { shopConnectionService } from "./shopConnectionService";

type CustomerInput = {
  email: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
};

type EnsuredCustomer = {
  id: string;
  email: string;
};

export class IdoxxyService {
  constructor(private readonly client = new IdoxxyClient()) {}

  private getClient(apiKeyOverride?: string, baseUrlOverride?: string) {
    const creds = settingsRepository.getIdoxxyCredentials();
    const config: { baseUrl?: string; apiKey?: string } = {};
    if (baseUrlOverride) {
      config.baseUrl = baseUrlOverride;
    } else if (creds.baseUrl) {
      config.baseUrl = creds.baseUrl;
    }

    if (apiKeyOverride) {
      config.apiKey = apiKeyOverride;
    } else if (creds.apiKey) {
      config.apiKey = creds.apiKey;
    }
    return new IdoxxyClient(undefined, config);
  }

  getClientForShop(shopId: string) {
    const connection = shopConnectionService.getConnection(shopId);
    const token = shopConnectionService.getToken(shopId);

    if (!connection || !token) {
      throw new Error(`Brak powiązanego tokena Idoxxy dla sklepu ${shopId}`);
    }

    if (connection.status !== "linked") {
      throw new Error(
        `Połączenie sklepu ${shopId} nie jest aktywne (status=${connection.status})`,
      );
    }

    return this.getClient(token, connection.idoxxyBaseUrl);
  }

  async healthCheck() {
    const data = await this.getClient().getAccountDetails();
    return {
      ok: true,
      payload: data,
    };
  }

  async testToken(apiKey: string, baseUrl?: string) {
    const data = await this.getClient(apiKey, baseUrl).getAccountDetails();
    return {
      ok: true,
      payload: data,
    };
  }

  async ensureCustomerExists(
    customer: CustomerInput,
    client: IdoxxyClient = this.getClient(),
  ): Promise<EnsuredCustomer> {
    const existing = await client.listCustomers({
      searchQuery: customer.email,
      page: 0,
      size: 20,
    });

    const matched = existing.content.find(
      (item: { email: string }) =>
        item.email.toLowerCase() === customer.email.toLowerCase(),
    );

    if (matched) {
      return { id: matched.id, email: matched.email };
    }

    const created = await client.createCustomer(customer);
    return { id: created.id, email: created.email };
  }

  async assignGroups(customerId: string, groupIds: string[], client?: IdoxxyClient) {
    const clientToUse = client ?? this.getClient();
    await Promise.all(
      groupIds.map((groupId) =>
        clientToUse.addCustomersToGroup(groupId, [customerId]),
      ),
    );
  }

  async removeGroups(customerId: string, groupIds: string[], client?: IdoxxyClient) {
    const clientToUse = client ?? this.getClient();
    await Promise.all(
      groupIds.map((groupId) =>
        clientToUse.removeCustomerFromGroup(groupId, customerId),
      ),
    );
  }

  async getGroups(params?: {
    groupName?: string;
    showDeferred?: boolean;
    page?: number;
    size?: number;
  }) {
    return this.getClient().getGroups(params);
  }

  async listGroups(search?: string, client?: IdoxxyClient) {
    const clientToUse = client ?? this.getClient();
    return clientToUse.listGroups(
      search ? { search } : undefined,
    );
  }

  async listCustomers(search?: string, client?: IdoxxyClient) {
    const clientToUse = client ?? this.getClient();
    return clientToUse.listCustomersWithGroups(
      search ? { search } : undefined,
    );
  }

  async getCustomerGroups(customerId: string, client?: IdoxxyClient) {
    const clientToUse = client ?? this.getClient();
    const customer = await clientToUse.getCustomerGroups(customerId);

    if (!customer) {
      return null;
    }

    return customer.customerGroups ?? [];
  }

  async assignCustomerToGroups(customerId: string, groupIds: string[], client?: IdoxxyClient) {
    const clientToUse = client ?? this.getClient();
    await Promise.all(
      groupIds.map((groupId) =>
        clientToUse.addCustomersToGroup(groupId, [customerId]),
      ),
    );
  }

  async addCustomersToGroup(groupId: string, customerIds: string[], client?: IdoxxyClient) {
    const clientToUse = client ?? this.getClient();
    await clientToUse.addCustomersToGroup(groupId, customerIds);
  }

  async addCustomerToGroups(customerId: string, groupIds: string[], client?: IdoxxyClient) {
    if (groupIds.length === 0) {
      return { ok: true };
    }

    await this.assignCustomerToGroups(customerId, groupIds, client);
    return { ok: true };
  }
}
