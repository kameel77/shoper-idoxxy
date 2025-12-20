import { ShoperClient } from "../clients/shoperClient";

export class ShoperService {
  constructor(private readonly client = new ShoperClient()) {}

  async healthCheck() {
    const data = await this.client.getShops();
    return {
      ok: true,
      payload: data,
    };
  }
}
