import { IdoxxyClient } from "../clients/idoxxyClient";

export class IdoxxyService {
  constructor(private readonly client = new IdoxxyClient()) {}

  async healthCheck() {
    const data = await this.client.getAccountDetails();
    return {
      ok: true,
      payload: data,
    };
  }

  async ensureCustomerExists(payload: {
    email: string;
    firstName?: string;
    lastName?: string;
  }) {
    const existing = await this.client.listCustomers({
      searchQuery: payload.email,
      page: 0,
      size: 20,
    });

    const matched = existing.content.find(
      (customer) => customer.email.toLowerCase() === payload.email.toLowerCase(),
    );

    if (matched) {
      return matched;
    }

    return this.client.createCustomer(payload);
  }

  async assignGroups(customerId: string, groupIds: string[]) {
    await Promise.all(
      groupIds.map((groupId) =>
        this.client.addCustomersToGroup(groupId, [customerId]),
      ),
    );
  }

  async removeGroups(customerId: string, groupIds: string[]) {
    await Promise.all(
      groupIds.map((groupId) =>
        this.client.removeCustomerFromGroup(groupId, customerId),
      ),
    );
  }

  async getGroups(params?: {
    groupName?: string;
    showDeferred?: boolean;
    page?: number;
    size?: number;
  }) {
    return this.client.getGroups(params);
  }

  async listGroups(search?: string) {
    return this.client.listGroups({ search });
  }

  async listCustomers(search?: string) {
    return this.client.listCustomersWithGroups({ search });
  }

  async getCustomerGroups(customerId: string) {
    const customer = await this.client.getCustomerGroups(customerId);

    if (!customer) {
      return null;
    }

    return customer.customerGroups ?? [];
  }

  async assignCustomerToGroups(customerId: string, groupIds: string[]) {
    await Promise.all(
      groupIds.map((groupId) =>
        this.client.addCustomersToGroup(groupId, [customerId]),
      ),
    );
  }

  async addCustomersToGroup(groupId: string, customerIds: string[]) {
    await this.client.addCustomersToGroup(groupId, customerIds);
  }
}
