import type { PathMapping, SettingsSnapshot, SyncLogEntry } from "../types/settings";
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

  private lastSyncedAt: number | undefined;

  private lastSettingsModifiedAt: number | undefined;

  private syncLogs: SyncLogEntry[] = [];

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
      syncLogs: [...this.syncLogs],
    };

    if (this.lastSyncedAt !== undefined) {
      snapshot.lastSyncedAt = this.lastSyncedAt;
    }

    if (this.lastSettingsModifiedAt !== undefined) {
      snapshot.lastSettingsModifiedAt = this.lastSettingsModifiedAt;
    }

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
    if (payload.apiKey !== undefined) {
      this.idoxxyApiKey = payload.apiKey || undefined;
    } else if (payload.idoxxyApiKey !== undefined) {
      this.idoxxyApiKey = payload.idoxxyApiKey;
    }
    // If neither apiKey nor idoxxyApiKey is provided, keep existing value
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

  addSyncLog(logEntry: Omit<SyncLogEntry, "id" | "timestamp">) {
    const newLog: SyncLogEntry = {
      ...logEntry,
      id: randomUUID(),
      timestamp: Date.now(),
    };

    this.syncLogs.unshift(newLog); // Add to beginning for most recent first

    // Keep only last 1000 logs to prevent memory issues
    if (this.syncLogs.length > 1000) {
      this.syncLogs = this.syncLogs.slice(0, 1000);
    }

    // Update last synced timestamp
    this.lastSyncedAt = newLog.timestamp;
  }

  getSyncLogs(limit = 100, offset = 0) {
    return this.syncLogs.slice(offset, offset + limit);
  }

  updateLastSettingsModified() {
    this.lastSettingsModifiedAt = Date.now();
  }

  getSyncStats() {
    const stats = {
      total: this.syncLogs.length,
      success: 0,
      error: 0,
      partial: 0,
      lastSyncedAt: this.lastSyncedAt,
    };

    for (const log of this.syncLogs) {
      stats[log.status]++;
    }

    return stats;
  }
}

export const settingsRepository = new SettingsRepository();
