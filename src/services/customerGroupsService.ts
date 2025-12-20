import { IdoxxyClient } from "../clients/idoxxyClient";
import { customerGroupsCache } from "./customerGroupsCache";

export type CustomerGroup = {
  id: string;
  groupName: string;
};

export class CustomerGroupsService {
  constructor(private readonly client = new IdoxxyClient()) {}

  async getCustomerGroups(customerId: string) {
    const cached = customerGroupsCache.get<CustomerGroup[]>(customerId);

    if (cached) {
      return cached;
    }

    const customer = await this.client.getCustomerGroups(customerId);
    const groups = customer?.customerGroups ?? [];

    customerGroupsCache.set(customerId, groups);
    return groups;
  }

  async assignCustomersToGroup(groupId: string, customerIds: string[]) {
    if (customerIds.length === 0) {
      return { ok: true, skipped: true };
    }

    const response = await this.client.assignCustomersToGroup({
      groupId,
      customerIds,
    });

    customerGroupsCache.deleteMany(customerIds);

    return response;
  }
}
