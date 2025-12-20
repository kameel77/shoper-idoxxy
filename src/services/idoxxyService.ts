import { IdoxxyClient } from "../clients/idoxxyClient";

type CustomerInput = {
  email: string;
  firstName?: string;
  lastName?: string;
};

type EnsuredCustomer = {
  id: string;
  email: string;
};

export class IdoxxyService {
  constructor(private readonly client = new IdoxxyClient()) {}

  async healthCheck() {
    const data = await this.client.getAccountDetails();
    return {
      ok: true,
      payload: data,
    };
  }

  async ensureCustomerExists(customer: CustomerInput): Promise<EnsuredCustomer> {
    const existing = await this.client.listCustomers({
      searchQuery: customer.email,
      page: 0,
      size: 20,
    });

    const matched = existing.content.find(
      (item) => item.email.toLowerCase() === customer.email.toLowerCase(),
    );

    if (matched) {
      return { id: matched.id, email: matched.email };
    }

    const created = await this.client.createCustomer(customer);
    return { id: created.id, email: created.email };
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

  async addCustomerToGroups(customerId: string, groupIds: string[]) {
    if (groupIds.length === 0) {
      return { ok: true };
    }

    await this.assignCustomerToGroups(customerId, groupIds);
    return { ok: true };
  }
}
}
