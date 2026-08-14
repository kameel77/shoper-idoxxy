import { IdoxxyClient } from "../clients/idoxxyClient";
import { customerGroupsCache } from "./customerGroupsCache";

export type CustomerGroup = {
  id: string;
  groupName: string;
};

// Constructed per-request from a shop-scoped client (see
// src/routes/customerGroups.ts, which builds one via resolveShopClient(req)
// for every request). shopId and client are both required constructor
// arguments - deliberately no defaults - so it is impossible to construct an
// instance that talks to iDoxxy through the platform-wide env credentials
// instead of the calling shop's own token, and impossible to read/invalidate
// another shop's cache entries by omitting shopId.
export class CustomerGroupsService {
  constructor(
    private readonly shopId: string,
    private readonly client: IdoxxyClient,
  ) {}

  async getCustomerGroups(customerId: string) {
    const cached = customerGroupsCache.get<CustomerGroup[]>(this.shopId, customerId);

    if (cached) {
      return cached;
    }

    const customer = await this.client.getCustomerGroups(customerId);
    const groups = customer?.customerGroups ?? [];

    customerGroupsCache.set(this.shopId, customerId, groups);
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

    customerGroupsCache.deleteMany(this.shopId, customerIds);

    return response;
  }
}
