import type { PathMapping, SettingsSnapshot } from "../types/settings";

class SettingsRepository {
  private shoperApiKey?: string;

  private idoxxyApiKey?: string;

  private fallbackRegistrationGroupIds: string[] = [];

  private fallbackOrderGroupIds: string[] = [];

  private pathMappings: PathMapping[] = [];

  getSnapshot(): SettingsSnapshot {
    const snapshot: SettingsSnapshot = {
      fallbackRegistrationGroupIds: [...this.fallbackRegistrationGroupIds],
      fallbackOrderGroupIds: [...this.fallbackOrderGroupIds],
      pathMappings: this.pathMappings.map((mapping) => ({
        pathKey: mapping.pathKey,
        groupIds: [...mapping.groupIds],
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
    this.pathMappings = payload.pathMappings.map((mapping) => ({
      pathKey: mapping.pathKey,
      groupIds: [...mapping.groupIds],
    }));
  }

  updateApiKeys(payload: { shoperApiKey?: string; idoxxyApiKey?: string }) {
    this.shoperApiKey = payload.shoperApiKey;
    this.idoxxyApiKey = payload.idoxxyApiKey;
  }

  updateFallbackGroups(payload: {
    fallbackRegistrationGroupIds: string[];
    fallbackOrderGroupIds: string[];
  }) {
    this.fallbackRegistrationGroupIds = [
      ...payload.fallbackRegistrationGroupIds,
    ];
    this.fallbackOrderGroupIds = [...payload.fallbackOrderGroupIds];
  }

  updatePathMappings(pathMappings: PathMapping[]) {
    this.pathMappings = pathMappings.map((mapping) => ({
      pathKey: mapping.pathKey,
      groupIds: [...mapping.groupIds],
    }));
  }
}

export const settingsRepository = new SettingsRepository();
