import { randomUUID } from "node:crypto";
import { db } from "../config/database";
import type {
  EventMapping,
  PathMapping,
  SettingsSnapshot,
  SyncLogEntry,
} from "../types/settings";
import { env } from "../config/env";

// Prepared statements - every statement is scoped to a single shop via shop_id.
const getSettingStmt = db.prepare("SELECT value FROM settings WHERE shop_id = ? AND key = ?");
const setSettingStmt = db.prepare(
  "INSERT OR REPLACE INTO settings (shop_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
);
const getAllMappingsStmt = db.prepare(
  "SELECT * FROM event_mappings WHERE shop_id = ? ORDER BY priority",
);
// Ownership lookup (no shop filter) used to detect cross-tenant upsert attempts.
const getMappingOwnerStmt = db.prepare("SELECT shop_id FROM event_mappings WHERE id = ?");
const insertMappingStmt = db.prepare(`
  INSERT INTO event_mappings
  (id, shop_id, name, event, priority, target_group_ids, document_id, enabled, conditions, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateMappingStmt = db.prepare(`
  UPDATE event_mappings SET
    name = ?, event = ?, priority = ?, target_group_ids = ?,
    document_id = ?, enabled = ?, conditions = ?, updated_at = ?
  WHERE id = ? AND shop_id = ?
`);
const deleteMappingStmt = db.prepare("DELETE FROM event_mappings WHERE id = ? AND shop_id = ?");
const getSyncLogsStmt = db.prepare(
  "SELECT * FROM sync_logs WHERE shop_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?",
);
const insertSyncLogStmt = db.prepare(`
  INSERT INTO sync_logs
  (id, shop_id, timestamp, event, source, customer_id, customer_email, order_id, shoper_customer_id, action, status, details, duration_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getSyncStatsStmt = db.prepare(
  "SELECT status, COUNT(*) as count FROM sync_logs WHERE shop_id = ? GROUP BY status",
);

class SettingsRepository {
  private getSetting(shopId: string, key: string): string | undefined {
    const row = getSettingStmt.get(shopId, key) as { value: string } | undefined;
    return row?.value;
  }

  private setSetting(shopId: string, key: string, value: string): void {
    setSettingStmt.run(shopId, key, value, Date.now());
  }

  getSnapshot(shopId: string): SettingsSnapshot {
    const credentials: { baseUrl: string; apiKey: string | undefined } = {
      baseUrl: this.getSetting(shopId, "idoxxy_base_url") || env.IDOXXY_BASE_URL,
      apiKey: this.getSetting(shopId, "idoxxy_api_key") || undefined,
    };

    const fallbackRegistrationGroupIds = JSON.parse(
      this.getSetting(shopId, "fallback_registration_groups") || "[]",
    );
    const fallbackOrderGroupIds = JSON.parse(
      this.getSetting(shopId, "fallback_order_groups") || "[]",
    );
    const pathMappings = JSON.parse(this.getSetting(shopId, "path_mappings") || "[]");

    const mappings = this.getMappings(shopId);

    const lastSyncedAt = this.getSetting(shopId, "last_synced_at");
    const lastSettingsModifiedAt = this.getSetting(shopId, "last_settings_modified_at");

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
      syncLogs: this.getSyncLogs(shopId, 100),
      shoperApiKey: undefined,
      idoxxyApiKey: credentials.apiKey || undefined,
      lastSyncedAt: lastSyncedAt ? parseInt(lastSyncedAt, 10) : undefined,
      lastSettingsModifiedAt: lastSettingsModifiedAt
        ? parseInt(lastSettingsModifiedAt, 10)
        : undefined,
    };

    return snapshot;
  }

  updateSettings(shopId: string, payload: SettingsSnapshot): void {
    this.setSetting(shopId, "idoxxy_base_url", payload.baseUrl || env.IDOXXY_BASE_URL);

    if (payload.idoxxyApiKey) {
      this.setSetting(shopId, "idoxxy_api_key", payload.idoxxyApiKey);
    }

    this.setSetting(
      shopId,
      "fallback_registration_groups",
      JSON.stringify(payload.fallbackRegistrationGroupIds),
    );
    this.setSetting(
      shopId,
      "fallback_order_groups",
      JSON.stringify(payload.fallbackOrderGroupIds),
    );
    this.setSetting(shopId, "path_mappings", JSON.stringify(payload.pathMappings));

    // Update mappings
    for (const mapping of payload.mappings) {
      this.upsertMapping(shopId, mapping);
    }

    this.updateLastSettingsModified(shopId);
  }

  updateApiKeys(
    shopId: string,
    payload: {
      baseUrl: string | undefined;
      apiKey: string | undefined;
      shoperApiKey: string | undefined;
      idoxxyApiKey: string | undefined;
    },
  ): void {
    if (payload.baseUrl) {
      this.setSetting(shopId, "idoxxy_base_url", payload.baseUrl);
    }
    if (payload.apiKey !== undefined && payload.apiKey !== "") {
      this.setSetting(shopId, "idoxxy_api_key", payload.apiKey);
    } else if (payload.idoxxyApiKey !== undefined && payload.idoxxyApiKey !== "") {
      this.setSetting(shopId, "idoxxy_api_key", payload.idoxxyApiKey);
    }
    if (payload.shoperApiKey) {
      this.setSetting(shopId, "shoper_api_key", payload.shoperApiKey);
    }
    this.updateLastSettingsModified(shopId);
  }

  getIdoxxyCredentials(shopId: string): { apiKey: string | undefined; baseUrl: string } {
    return {
      apiKey: this.getSetting(shopId, "idoxxy_api_key") || undefined,
      baseUrl: this.getSetting(shopId, "idoxxy_base_url") || env.IDOXXY_BASE_URL,
    };
  }

  updateFallbackGroups(
    shopId: string,
    payload: {
      fallbackRegistrationGroupIds: string[];
      fallbackOrderGroupIds: string[];
    },
  ): void {
    this.setSetting(
      shopId,
      "fallback_registration_groups",
      JSON.stringify(payload.fallbackRegistrationGroupIds),
    );
    this.setSetting(
      shopId,
      "fallback_order_groups",
      JSON.stringify(payload.fallbackOrderGroupIds),
    );
    this.updateLastSettingsModified(shopId);
  }

  updatePathMappings(shopId: string, pathMappings: PathMapping[]): void {
    this.setSetting(shopId, "path_mappings", JSON.stringify(pathMappings));
    this.updateLastSettingsModified(shopId);
  }

  getMappings(shopId: string): EventMapping[] {
    const rows = getAllMappingsStmt.all(shopId) as Array<{
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

  /**
   * Create or update a mapping for shopId. If an id is supplied and it already
   * belongs to a different shop, the update is refused (throws) rather than
   * silently overwriting another tenant's mapping.
   */
  upsertMapping(shopId: string, mapping: EventMapping): EventMapping {
    const mappingWithId: EventMapping = {
      ...mapping,
      id: mapping.id || randomUUID(),
      targetGroupIds: [...mapping.targetGroupIds],
      conditions: mapping.conditions.map((condition) => ({ ...condition })),
    };

    const owner = getMappingOwnerStmt.get(mappingWithId.id) as { shop_id: string } | undefined;

    if (owner && owner.shop_id !== shopId) {
      throw new Error(
        `Mapowanie ${mappingWithId.id} należy do innego sklepu i nie może zostać zmodyfikowane.`,
      );
    }

    const now = Date.now();

    if (owner) {
      updateMappingStmt.run(
        mappingWithId.name,
        mappingWithId.event,
        mappingWithId.priority,
        JSON.stringify(mappingWithId.targetGroupIds),
        mappingWithId.documentId || null,
        mappingWithId.enabled ? 1 : 0,
        JSON.stringify(mappingWithId.conditions),
        now,
        mappingWithId.id,
        shopId,
      );
    } else {
      insertMappingStmt.run(
        mappingWithId.id,
        shopId,
        mappingWithId.name,
        mappingWithId.event,
        mappingWithId.priority,
        JSON.stringify(mappingWithId.targetGroupIds),
        mappingWithId.documentId || null,
        mappingWithId.enabled ? 1 : 0,
        JSON.stringify(mappingWithId.conditions),
        now,
        now,
      );
    }

    return mappingWithId;
  }

  /**
   * Delete a mapping owned by shopId. Returns false (without throwing) when the
   * mapping doesn't exist or belongs to another shop, so callers can answer 404.
   */
  removeMapping(shopId: string, id: string): boolean {
    const result = deleteMappingStmt.run(id, shopId);
    if (result.changes > 0) {
      this.updateLastSettingsModified(shopId);
      return true;
    }
    return false;
  }

  addSyncLog(shopId: string, logEntry: Omit<SyncLogEntry, "id" | "timestamp">): void {
    const newLog: SyncLogEntry = {
      ...logEntry,
      id: randomUUID(),
      timestamp: Date.now(),
    };

    insertSyncLogStmt.run(
      newLog.id,
      shopId,
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
      newLog.durationMs || null,
    );

    this.setSetting(shopId, "last_synced_at", String(newLog.timestamp));
  }

  getSyncLogs(shopId: string, limit = 100, offset = 0): SyncLogEntry[] {
    const rows = getSyncLogsStmt.all(shopId, limit, offset) as Array<{
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

  updateLastSettingsModified(shopId: string): void {
    this.setSetting(shopId, "last_settings_modified_at", String(Date.now()));
  }

  // Legacy methods for compatibility
  saveCredentials(
    shopId: string,
    payload: {
      apiKey: string;
      clientId: string;
      clientSecret: string;
      baseUrl: string;
    },
  ): { ok: boolean } {
    if (payload.apiKey) {
      this.setSetting(shopId, "idoxxy_api_key", payload.apiKey);
    }
    if (payload.baseUrl) {
      this.setSetting(shopId, "idoxxy_base_url", payload.baseUrl);
    }
    if (payload.clientId) {
      this.setSetting(shopId, "shoper_api_key", payload.clientId);
    }
    this.updateLastSettingsModified(shopId);
    return { ok: true };
  }

  updateDefaultGroups(
    shopId: string,
    payload: { registration: string[]; order: string[] },
  ): void {
    this.setSetting(shopId, "fallback_registration_groups", JSON.stringify(payload.registration));
    this.setSetting(shopId, "fallback_order_groups", JSON.stringify(payload.order));
    this.updateLastSettingsModified(shopId);
  }

  getSyncStats(shopId: string): {
    total: number;
    success: number;
    error: number;
    partial: number;
    lastSyncedAt: number | undefined;
  } {
    const rows = getSyncStatsStmt.all(shopId) as Array<{ status: string; count: number }>;

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

    const lastSyncedAt = this.getSetting(shopId, "last_synced_at");
    if (lastSyncedAt) {
      stats.lastSyncedAt = parseInt(lastSyncedAt, 10);
    }

    return stats;
  }
}

export const settingsRepository = new SettingsRepository();
