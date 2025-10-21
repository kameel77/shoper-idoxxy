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
}
