import { describe, it, expect } from "vitest";

import { settingsRepository } from "../src/repositories/settingsRepository";

const SHOP_A = "shop-a";
const SHOP_B = "shop-b";

const baseMapping = {
  id: undefined as string | undefined,
  name: "Newsletter signup",
  event: "customer.created",
  priority: 0,
  enabled: true,
  targetGroupIds: ["group-1"],
  documentId: undefined as string | undefined,
  conditions: [],
};

describe("SettingsRepository multi-tenancy", () => {
  it("keeps fallback groups / credentials / path mappings scoped per shop", () => {
    settingsRepository.updateFallbackGroups(SHOP_A, {
      fallbackRegistrationGroupIds: ["a-reg"],
      fallbackOrderGroupIds: ["a-order"],
    });
    settingsRepository.updateFallbackGroups(SHOP_B, {
      fallbackRegistrationGroupIds: ["b-reg"],
      fallbackOrderGroupIds: ["b-order"],
    });
    settingsRepository.updateApiKeys(SHOP_A, {
      baseUrl: "https://a.idoxxy.example",
      apiKey: "secret-a",
      shoperApiKey: undefined,
      idoxxyApiKey: undefined,
    });
    settingsRepository.updateApiKeys(SHOP_B, {
      baseUrl: "https://b.idoxxy.example",
      apiKey: "secret-b",
      shoperApiKey: undefined,
      idoxxyApiKey: undefined,
    });

    const snapshotA = settingsRepository.getSnapshot(SHOP_A);
    const snapshotB = settingsRepository.getSnapshot(SHOP_B);

    expect(snapshotA.defaultGroupIds.registration).toEqual(["a-reg"]);
    expect(snapshotB.defaultGroupIds.registration).toEqual(["b-reg"]);
    expect(snapshotA.credentials.apiKey).toBe("secret-a");
    expect(snapshotB.credentials.apiKey).toBe("secret-b");
    expect(snapshotA.baseUrl).toBe("https://a.idoxxy.example");
    expect(snapshotB.baseUrl).toBe("https://b.idoxxy.example");

    const credsA = settingsRepository.getIdoxxyCredentials(SHOP_A);
    const credsB = settingsRepository.getIdoxxyCredentials(SHOP_B);
    expect(credsA.apiKey).toBe("secret-a");
    expect(credsB.apiKey).toBe("secret-b");
  });

  it("keeps event mappings invisible across shops", () => {
    const mappingA = settingsRepository.upsertMapping(SHOP_A, { ...baseMapping, name: "A mapping" });
    const mappingB = settingsRepository.upsertMapping(SHOP_B, { ...baseMapping, name: "B mapping" });

    const mappingsA = settingsRepository.getMappings(SHOP_A);
    const mappingsB = settingsRepository.getMappings(SHOP_B);

    expect(mappingsA.map((m) => m.id)).toContain(mappingA.id);
    expect(mappingsA.map((m) => m.id)).not.toContain(mappingB.id);
    expect(mappingsB.map((m) => m.id)).toContain(mappingB.id);
    expect(mappingsB.map((m) => m.id)).not.toContain(mappingA.id);

    const snapshotA = settingsRepository.getSnapshot(SHOP_A);
    expect(snapshotA.mappings.some((m) => m.name === "B mapping")).toBe(false);
  });

  it("refuses to let one shop overwrite another shop's mapping via upsertMapping", () => {
    const mappingB = settingsRepository.upsertMapping(SHOP_B, { ...baseMapping, name: "Owned by B" });

    expect(() =>
      settingsRepository.upsertMapping(SHOP_A, {
        ...baseMapping,
        id: mappingB.id,
        name: "Hijacked by A",
      }),
    ).toThrow();

    // The mapping must be unchanged.
    const stillB = settingsRepository.getMappings(SHOP_B).find((m) => m.id === mappingB.id);
    expect(stillB?.name).toBe("Owned by B");
  });

  it("refuses to let one shop delete another shop's mapping via removeMapping", () => {
    const mappingB = settingsRepository.upsertMapping(SHOP_B, { ...baseMapping, name: "Keep me" });

    const removedByWrongShop = settingsRepository.removeMapping(SHOP_A, mappingB.id!);
    expect(removedByWrongShop).toBe(false);
    expect(settingsRepository.getMappings(SHOP_B).some((m) => m.id === mappingB.id)).toBe(true);

    const removedByOwner = settingsRepository.removeMapping(SHOP_B, mappingB.id!);
    expect(removedByOwner).toBe(true);
    expect(settingsRepository.getMappings(SHOP_B).some((m) => m.id === mappingB.id)).toBe(false);
  });

  it("keeps sync logs and sync stats scoped per shop", () => {
    settingsRepository.addSyncLog(SHOP_A, {
      event: "customer.created",
      source: "webhook",
      customerId: "cust-a",
      customerEmail: "a@example.com",
      orderId: undefined,
      shoperCustomerId: undefined,
      action: "sync-customer",
      status: "success",
      details: {
        groupsAssigned: ["group-1"],
        groupsRemoved: undefined,
        mappingUsed: undefined,
        sourceUsed: "fallback",
        error: undefined,
      },
      durationMs: 10,
    });
    settingsRepository.addSyncLog(SHOP_B, {
      event: "customer.created",
      source: "webhook",
      customerId: "cust-b",
      customerEmail: "b@example.com",
      orderId: undefined,
      shoperCustomerId: undefined,
      action: "sync-customer",
      status: "error",
      details: {
        groupsAssigned: undefined,
        groupsRemoved: undefined,
        mappingUsed: undefined,
        sourceUsed: undefined,
        error: "boom",
      },
      durationMs: 5,
    });
    settingsRepository.addSyncLog(SHOP_B, {
      event: "customer.created",
      source: "webhook",
      customerId: "cust-b2",
      customerEmail: "b2@example.com",
      orderId: undefined,
      shoperCustomerId: undefined,
      action: "sync-customer",
      status: "error",
      details: {
        groupsAssigned: undefined,
        groupsRemoved: undefined,
        mappingUsed: undefined,
        sourceUsed: undefined,
        error: "boom again",
      },
      durationMs: 5,
    });

    const logsA = settingsRepository.getSyncLogs(SHOP_A);
    const logsB = settingsRepository.getSyncLogs(SHOP_B);

    expect(logsA.every((log) => log.customerEmail === "a@example.com")).toBe(true);
    expect(logsB.some((log) => log.customerEmail === "a@example.com")).toBe(false);

    const statsA = settingsRepository.getSyncStats(SHOP_A);
    const statsB = settingsRepository.getSyncStats(SHOP_B);

    expect(statsA.total).toBe(1);
    expect(statsA.success).toBe(1);
    expect(statsB.total).toBe(2);
    expect(statsB.error).toBe(2);
  });
});
