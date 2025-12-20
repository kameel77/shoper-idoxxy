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

  async listGroups(search?: string) {
    return this.client.listGroups({ search });
  }

  async listCustomers(search?: string) {
    return this.client.listCustomersWithGroups({ search });
  }

  async getCustomerGroups(customerId: string) {
    const response = await this.client.listCustomersWithGroups({
      search: customerId,
      size: 200,
    });

    if (!response || typeof response !== "object") {
      return null;
    }

    const content = Array.isArray((response as { content?: unknown }).content)
      ? ((response as { content?: unknown[] }).content ?? [])
      : [];

    const match = content.find(
      (customer) =>
        typeof customer === "object" &&
        customer !== null &&
        (customer as { id?: string }).id === customerId,
    ) as { customerGroups?: unknown } | undefined;

    return match?.customerGroups ?? null;
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
