import type { PathMapping, SettingsSnapshot } from "../types/settings";
import type { EventMapping } from "../types/settings";
import { randomUUID } from "node:crypto";
import { env } from "../config/env";

class SettingsRepository {
  private shoperApiKey: string | undefined;

  private idoxxyApiKey: string | undefined;

  private baseUrl: string = env.IDOXXY_BASE_URL ?? "https://api.idoxxy.com";

  private fallbackRegistrationGroupIds: string[] = [];

  private fallbackOrderGroupIds: string[] = [];

  private pathMappings: PathMapping[] = [];

  private mappings: EventMapping[] = [];

  private defaultGroupIds: { registration: string[]; order: string[] } = {
    registration: [],
    order: [],
  };

  getSnapshot(): SettingsSnapshot {
    const credentials: { baseUrl?: string; apiKey?: string } = {};
    credentials.baseUrl = this.baseUrl;
    if (this.idoxxyApiKey) {
      credentials.apiKey = this.idoxxyApiKey;
    }

    const snapshot: SettingsSnapshot = {
      fallbackRegistrationGroupIds: [...this.fallbackRegistrationGroupIds],
      fallbackOrderGroupIds: [...this.fallbackOrderGroupIds],
      pathMappings: this.pathMappings.map((mapping) => ({
        pathKey: mapping.pathKey,
        groupIds: [...mapping.groupIds],
      })),
      baseUrl: this.baseUrl,
      credentials,
      defaultGroupIds: {
        registration: [...this.defaultGroupIds.registration],
        order: [...this.defaultGroupIds.order],
      },
      mappings: this.mappings.map((mapping) => ({
        ...mapping,
        targetGroupIds: [...mapping.targetGroupIds],
        conditions: mapping.conditions.map((condition) => ({ ...condition })),
      })),
    };

    if (this.shoperApiKey) {
      snapshot.shoperApiKey = this.shoperApiKey;
    }

    if (this.idoxxyApiKey) {
      snapshot.idoxxyApiKey = this.idoxxyApiKey;
    }

    return snapshot;
  }

  updateSettings(payload: SettingsSnapshot) {
    this.shoperApiKey = payload.shoperApiKey;
    this.idoxxyApiKey = payload.idoxxyApiKey;
    this.fallbackRegistrationGroupIds = [
      ...payload.fallbackRegistrationGroupIds,
    ];
    this.fallbackOrderGroupIds = [...payload.fallbackOrderGroupIds];
    this.defaultGroupIds = {
      registration: [...payload.fallbackRegistrationGroupIds],
      order: [...payload.fallbackOrderGroupIds],
    };
    this.pathMappings = payload.pathMappings.map((mapping) => ({
      pathKey: mapping.pathKey,
      groupIds: [...mapping.groupIds],
    }));

    this.mappings = payload.mappings.map((mapping) => ({
      ...mapping,
      targetGroupIds: [...mapping.targetGroupIds],
      conditions: mapping.conditions.map((condition) => ({ ...condition })),
    }));
  }

  updateApiKeys(payload: {
    baseUrl?: string | undefined;
    apiKey?: string | undefined;
    shoperApiKey?: string | undefined;
    idoxxyApiKey?: string | undefined;
  }) {
    this.baseUrl = payload.baseUrl || this.baseUrl;
    this.idoxxyApiKey = payload.apiKey ?? payload.idoxxyApiKey ?? this.idoxxyApiKey;
    this.shoperApiKey = payload.shoperApiKey ?? this.shoperApiKey;
  }

  getIdoxxyCredentials() {
    return {
      apiKey: this.idoxxyApiKey,
      baseUrl: this.baseUrl,
    };
  }

  updateFallbackGroups(payload: {
    fallbackRegistrationGroupIds: string[];
    fallbackOrderGroupIds: string[];
  }) {
    this.fallbackRegistrationGroupIds = [
      ...payload.fallbackRegistrationGroupIds,
    ];
    this.fallbackOrderGroupIds = [...payload.fallbackOrderGroupIds];
    this.defaultGroupIds = {
      registration: [...payload.fallbackRegistrationGroupIds],
      order: [...payload.fallbackOrderGroupIds],
    };
  }

  updatePathMappings(pathMappings: PathMapping[]) {
    this.pathMappings = pathMappings.map((mapping) => ({
      pathKey: mapping.pathKey,
      groupIds: [...mapping.groupIds],
    }));
  }

  saveCredentials(payload: {
    apiKey: string;
    clientId: string;
    clientSecret: string;
    baseUrl: string;
  }) {
    this.idoxxyApiKey = payload.apiKey;
    this.shoperApiKey = payload.clientId;
    // baseUrl/clientSecret could be stored if needed
    return { ok: true };
  }

  updateDefaultGroups(payload: { registration: string[]; order: string[] }) {
    this.defaultGroupIds = {
      registration: [...payload.registration],
      order: [...payload.order],
    };
  }

  upsertMapping(mapping: EventMapping) {
    const mappingWithId: EventMapping = {
      ...mapping,
      id: mapping.id ?? randomUUID(),
      targetGroupIds: [...mapping.targetGroupIds],
      conditions: mapping.conditions.map((condition) => ({ ...condition })),
    };

    const existingIndex = this.mappings.findIndex((item) => item.id === mappingWithId.id);
    if (existingIndex >= 0) {
      this.mappings[existingIndex] = mappingWithId;
    } else {
      this.mappings.push(mappingWithId);
    }

    return mappingWithId;
  }

  removeMapping(id: string) {
    this.mappings = this.mappings.filter((mapping) => mapping.id !== id);
  }
}

export const settingsRepository = new SettingsRepository();
