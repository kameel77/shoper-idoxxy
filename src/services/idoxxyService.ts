import { IdoxxyClient } from "../clients/idoxxyClient";
import { settingsRepository } from "../repositories/settingsRepository";

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

  private getClient() {
    const creds = settingsRepository.getIdoxxyCredentials();
    const config: { baseUrl?: string; apiKey?: string } = {};
    if (creds.baseUrl) config.baseUrl = creds.baseUrl;
    if (creds.apiKey) config.apiKey = creds.apiKey;
    return new IdoxxyClient(undefined, config);
  }

  async healthCheck() {
    const data = await this.getClient().getAccountDetails();
    return {
      ok: true,
      payload: data,
    };
  }

  async ensureCustomerExists(customer: CustomerInput): Promise<EnsuredCustomer> {
    const client = this.getClient();
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

  async assignGroups(customerId: string, groupIds: string[]) {
    const client = this.getClient();
    await Promise.all(
      groupIds.map((groupId) =>
        client.addCustomersToGroup(groupId, [customerId]),
      ),
    );
  }

  async removeGroups(customerId: string, groupIds: string[]) {
    const client = this.getClient();
    await Promise.all(
      groupIds.map((groupId) =>
        client.removeCustomerFromGroup(groupId, customerId),
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

  async listGroups(search?: string) {
    return this.getClient().listGroups(
      search ? { search } : undefined,
    );
  }

  async listCustomers(search?: string) {
    return this.getClient().listCustomersWithGroups(
      search ? { search } : undefined,
    );
  }

  async getCustomerGroups(customerId: string) {
    const customer = await this.getClient().getCustomerGroups(customerId);

    if (!customer) {
      return null;
    }

    return customer.customerGroups ?? [];
  }

  async assignCustomerToGroups(customerId: string, groupIds: string[]) {
    const client = this.getClient();
    await Promise.all(
      groupIds.map((groupId) =>
        client.addCustomersToGroup(groupId, [customerId]),
      ),
    );
  }

  async addCustomersToGroup(groupId: string, customerIds: string[]) {
    await this.getClient().addCustomersToGroup(groupId, customerIds);
  }

  async addCustomerToGroups(customerId: string, groupIds: string[]) {
    if (groupIds.length === 0) {
      return { ok: true };
    }

    await this.assignCustomerToGroups(customerId, groupIds);
    return { ok: true };
  }
}
