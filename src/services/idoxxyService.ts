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
    return {
      id: customer.email,
      email: customer.email,
    };
  }

  async addCustomerToGroups(customerId: string, groupIds: string[]) {
    if (groupIds.length === 0) {
      return { ok: true };
    }

    // eslint-disable-next-line no-console
    console.log("Dodaję klienta do grup Idoxxy", {
      customerId,
      groupIds,
    });

    return { ok: true };
  }
}
