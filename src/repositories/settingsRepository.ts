import { randomUUID } from "node:crypto";

import type {
  ApiCredentials,
  EventMapping,
  SettingsSnapshot,
} from "../types/settings";

class SettingsRepository {
  private credentials?: ApiCredentials;

  private defaultGroupIds = {
    registration: [] as string[],
    order: [] as string[],
  };

  private mappings = new Map<string, EventMapping>();

  private lastSyncedAt?: string;

  getSnapshot(): SettingsSnapshot {
    const snapshot: SettingsSnapshot = {
      defaultGroupIds: {
        registration: [...this.defaultGroupIds.registration],
        order: [...this.defaultGroupIds.order],
      },
      mappings: Array.from(this.mappings.values())
        .map((mapping) => ({
          ...mapping,
          targetGroupIds: [...mapping.targetGroupIds],
          conditions: mapping.conditions.map((condition) => ({ ...condition })),
        }))
        .sort((a, b) => a.priority - b.priority),
    };

    if (this.credentials) {
      snapshot.credentials = { ...this.credentials };
    }

    if (this.lastSyncedAt) {
      snapshot.lastSyncedAt = this.lastSyncedAt;
    }

    return snapshot;
  }

  saveCredentials(credentials: ApiCredentials) {
    this.credentials = credentials;
  }

  updateDefaultGroups(payload: { registration: string[]; order: string[] }) {
    this.defaultGroupIds = {
      registration: [...payload.registration],
      order: [...payload.order],
    };
  }

  upsertMapping(mapping: Omit<EventMapping, "id"> & { id?: string }) {
    const identifier = mapping.id ?? randomUUID();
    const normalized: EventMapping = {
      ...mapping,
      id: identifier,
      targetGroupIds: [...mapping.targetGroupIds],
      conditions: mapping.conditions.map((condition) => ({ ...condition })),
    };

    if (!normalized.documentId) {
      delete normalized.documentId;
    }

    this.mappings.set(identifier, normalized);
    return normalized;
  }

  removeMapping(id: string) {
    this.mappings.delete(id);
  }

  markSynced(timestamp: string = new Date().toISOString()) {
    this.lastSyncedAt = timestamp;
  }
}

export const settingsRepository = new SettingsRepository();
