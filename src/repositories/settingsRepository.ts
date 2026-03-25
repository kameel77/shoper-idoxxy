import { randomUUID } from "node:crypto";
import { db } from "../config/database";
import type {
  EventMapping,
  PathMapping,
  SettingsSnapshot,
  SyncLogEntry,
} from "../types/settings";
import { env } from "../config/env";

// Prepared statements
const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const setSettingStmt = db.prepare(
  "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)"
);
const getAllMappingsStmt = db.prepare("SELECT * FROM event_mappings ORDER BY priority");
const getMappingByIdStmt = db.prepare("SELECT * FROM event_mappings WHERE id = ?");
const insertMappingStmt = db.prepare(`
  INSERT INTO event_mappings 
  (id, name, event, priority, target_group_ids, document_id, enabled, conditions, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateMappingStmt = db.prepare(`
  UPDATE event_mappings SET
    name = ?, event = ?, priority = ?, target_group_ids = ?, 
    document_id = ?, enabled = ?, conditions = ?, updated_at = ?
  WHERE id = ?
`);
const deleteMappingStmt = db.prepare("DELETE FROM event_mappings WHERE id = ?");
const getSyncLogsStmt = db.prepare(
  "SELECT * FROM sync_logs ORDER BY timestamp DESC LIMIT ? OFFSET ?"
);
const insertSyncLogStmt = db.prepare(`
  INSERT INTO sync_logs 
  (id, timestamp, event, source, customer_id, customer_email, order_id, shoper_customer_id, action, status, details, duration_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

class SettingsRepository {
  private getSetting(key: string): string | undefined {
    const row = getSettingStmt.get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setSetting(key: string, value: string): void {
    setSettingStmt.run(key, value, Date.now());
  }

  getSnapshot(): SettingsSnapshot {
    const credentials: { baseUrl: string; apiKey: string | undefined } = {
      baseUrl: this.getSetting("idoxxy_base_url") || env.IDOXXY_BASE_URL,
      apiKey: this.getSetting("idoxxy_api_key") || undefined,
    };

    const fallbackRegistrationGroupIds = JSON.parse(
      this.getSetting("fallback_registration_groups") || "[]"
    );
    const fallbackOrderGroupIds = JSON.parse(
      this.getSetting("fallback_order_groups") || "[]"
    );
    const pathMappings = JSON.parse(this.getSetting("path_mappings") || "[]");

    const mappings = this.getMappings();

    const lastSyncedAt = this.getSetting("last_synced_at");
    const lastSettingsModifiedAt = this.getSetting("last_settings_modified_at");

    const snapshot: SettingsSnapshot = {
      fallbackRegistrationGroupIds,
      fallbackOrderGroupIds,
      pathMappings,
      baseUrl: credentials.baseUrl,
      credentials: credentials.apiKey 
        ? { baseUrl: credentials.baseUrl, apiKey: credentials.apiKey }
        : { baseUrl: credentials.baseUrl, apiKey: undefined },
      defaultGroupIds: {
        registration: fallbackRegistrationGroupIds,
        order: fallbackOrderGroupIds,
      },
      mappings,
      syncLogs: this.getSyncLogs(100),
      shoperApiKey: undefined,
      idoxxyApiKey: credentials.apiKey || undefined,
      lastSyncedAt: lastSyncedAt ? parseInt(lastSyncedAt, 10) : undefined,
      lastSettingsModifiedAt: lastSettingsModifiedAt ? parseInt(lastSettingsModifiedAt, 10) : undefined,
    };

    return snapshot;
  }

  updateSettings(payload: SettingsSnapshot): void {
    this.setSetting("idoxxy_base_url", payload.baseUrl || env.IDOXXY_BASE_URL);
    
    if (payload.idoxxyApiKey) {
      this.setSetting("idoxxy_api_key", payload.idoxxyApiKey);
    }

    this.setSetting(
      "fallback_registration_groups",
      JSON.stringify(payload.fallbackRegistrationGroupIds)
    );
    this.setSetting(
      "fallback_order_groups",
      JSON.stringify(payload.fallbackOrderGroupIds)
    );
    this.setSetting("path_mappings", JSON.stringify(payload.pathMappings));

    // Update mappings
    for (const mapping of payload.mappings) {
      this.upsertMapping(mapping);
    }

    this.updateLastSettingsModified();
  }

  updateApiKeys(payload: {
    baseUrl: string | undefined;
    apiKey: string | undefined;
    shoperApiKey: string | undefined;
    idoxxyApiKey: string | undefined;
  }): void {
    if (payload.baseUrl) {
      this.setSetting("idoxxy_base_url", payload.baseUrl);
    }
    if (payload.apiKey !== undefined) {
      this.setSetting("idoxxy_api_key", payload.apiKey);
    } else if (payload.idoxxyApiKey !== undefined) {
      this.setSetting("idoxxy_api_key", payload.idoxxyApiKey);
    }
    if (payload.shoperApiKey) {
      this.setSetting("shoper_api_key", payload.shoperApiKey);
    }
    this.updateLastSettingsModified();
  }

  getIdoxxyCredentials(): { apiKey: string | undefined; baseUrl: string } {
    return {
      apiKey: this.getSetting("idoxxy_api_key") || undefined,
      baseUrl: this.getSetting("idoxxy_base_url") || env.IDOXXY_BASE_URL,
    };
  }

  updateFallbackGroups(payload: {
    fallbackRegistrationGroupIds: string[];
    fallbackOrderGroupIds: string[];
  }): void {
    this.setSetting(
      "fallback_registration_groups",
      JSON.stringify(payload.fallbackRegistrationGroupIds)
    );
    this.setSetting(
      "fallback_order_groups",
      JSON.stringify(payload.fallbackOrderGroupIds)
    );
    this.updateLastSettingsModified();
  }

  updatePathMappings(pathMappings: PathMapping[]): void {
    this.setSetting("path_mappings", JSON.stringify(pathMappings));
    this.updateLastSettingsModified();
  }

  getMappings(): EventMapping[] {
    const rows = getAllMappingsStmt.all() as Array<{
      id: string;
      name: string;
      event: string;
      priority: number;
      target_group_ids: string;
      document_id: string | null;
      enabled: number;
      conditions: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      event: row.event,
      priority: row.priority,
      targetGroupIds: JSON.parse(row.target_group_ids),
      documentId: row.document_id || undefined,
      enabled: row.enabled === 1,
      conditions: JSON.parse(row.conditions),
    }));
  }

  upsertMapping(mapping: EventMapping): EventMapping {
    const mappingWithId: EventMapping = {
      ...mapping,
      id: mapping.id || randomUUID(),
      targetGroupIds: [...mapping.targetGroupIds],
      conditions: mapping.conditions.map((condition) => ({ ...condition })),
    };

    const existing = getMappingByIdStmt.get(mappingWithId.id) as
      | { id: string }
      | undefined;

    const now = Date.now();

    if (existing) {
      updateMappingStmt.run(
        mappingWithId.name,
        mappingWithId.event,
        mappingWithId.priority,
        JSON.stringify(mappingWithId.targetGroupIds),
        mappingWithId.documentId || null,
        mappingWithId.enabled ? 1 : 0,
        JSON.stringify(mappingWithId.conditions),
        now,
        mappingWithId.id
      );
    } else {
      insertMappingStmt.run(
        mappingWithId.id,
        mappingWithId.name,
        mappingWithId.event,
        mappingWithId.priority,
        JSON.stringify(mappingWithId.targetGroupIds),
        mappingWithId.documentId || null,
        mappingWithId.enabled ? 1 : 0,
        JSON.stringify(mappingWithId.conditions),
        now,
        now
      );
    }

    return mappingWithId;
  }

  removeMapping(id: string): void {
    deleteMappingStmt.run(id);
    this.updateLastSettingsModified();
  }

  addSyncLog(logEntry: Omit<SyncLogEntry, "id" | "timestamp">): void {
    const newLog: SyncLogEntry = {
      ...logEntry,
      id: randomUUID(),
      timestamp: Date.now(),
    };

    insertSyncLogStmt.run(
      newLog.id,
      newLog.timestamp,
      newLog.event,
      newLog.source,
      newLog.customerId || null,
      newLog.customerEmail || null,
      newLog.orderId || null,
      newLog.shoperCustomerId || null,
      newLog.action,
      newLog.status,
      JSON.stringify(newLog.details),
      newLog.durationMs || null
    );

    this.setSetting("last_synced_at", String(newLog.timestamp));
  }

  getSyncLogs(limit = 100, offset = 0): SyncLogEntry[] {
    const rows = getSyncLogsStmt.all(limit, offset) as Array<{
      id: string;
      timestamp: number;
      event: string;
      source: string;
      customer_id: string | null;
      customer_email: string | null;
      order_id: string | null;
      shoper_customer_id: string | null;
      action: string;
      status: string;
      details: string;
      duration_ms: number | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      event: row.event,
      source: row.source as "webhook" | "manual",
      customerId: row.customer_id || undefined,
      customerEmail: row.customer_email || undefined,
      orderId: row.order_id || undefined,
      shoperCustomerId: row.shoper_customer_id || undefined,
      action: row.action,
      status: row.status as "success" | "error" | "partial",
      details: JSON.parse(row.details),
      durationMs: row.duration_ms || undefined,
    }));
  }

  updateLastSettingsModified(): void {
    this.setSetting("last_settings_modified_at", String(Date.now()));
  }

  // Legacy methods for compatibility
  saveCredentials(payload: {
    apiKey: string;
    clientId: string;
    clientSecret: string;
    baseUrl: string;
  }): { ok: boolean } {
    if (payload.apiKey) {
      this.setSetting("idoxxy_api_key", payload.apiKey);
    }
    if (payload.baseUrl) {
      this.setSetting("idoxxy_base_url", payload.baseUrl);
    }
    if (payload.clientId) {
      this.setSetting("shoper_api_key", payload.clientId);
    }
    this.updateLastSettingsModified();
    return { ok: true };
  }

  updateDefaultGroups(payload: { registration: string[]; order: string[] }): void {
    this.setSetting("fallback_registration_groups", JSON.stringify(payload.registration));
    this.setSetting("fallback_order_groups", JSON.stringify(payload.order));
    this.updateLastSettingsModified();
  }

  getSyncStats(): {
    total: number;
    success: number;
    error: number;
    partial: number;
    lastSyncedAt: number | undefined;
  } {
    const countStmt = db.prepare(
      "SELECT status, COUNT(*) as count FROM sync_logs GROUP BY status"
    );
    const rows = countStmt.all() as Array<{ status: string; count: number }>;

    const stats = {
      total: 0,
      success: 0,
      error: 0,
      partial: 0,
      lastSyncedAt: undefined as number | undefined,
    };

    for (const row of rows) {
      stats.total += row.count;
      stats[row.status as keyof typeof stats] = row.count;
    }

    const lastSyncedAt = this.getSetting("last_synced_at");
    if (lastSyncedAt) {
      stats.lastSyncedAt = parseInt(lastSyncedAt, 10);
    }

    return stats;
  }
}

export const settingsRepository = new SettingsRepository();
