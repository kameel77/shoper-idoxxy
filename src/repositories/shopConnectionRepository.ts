import { db } from "../config/database";
import type {
  ShopConnection,
  ShopConnectionStatus,
  UpsertShopConnectionPayload,
} from "../types/shopConnection";

const now = () => Date.now();

// Prepared statements
const getConnectionStmt = db.prepare("SELECT * FROM shop_connections WHERE shop_id = ?");
const getAllConnectionsStmt = db.prepare("SELECT * FROM shop_connections ORDER BY created_at DESC");
const insertConnectionStmt = db.prepare(`
  INSERT INTO shop_connections 
  (shop_id, shop_url, idoxxy_base_url, idoxxy_workspace_id, idoxxy_token_encrypted, 
   status, token_last_verified_at, revoked_at, revoked_by, last_error, last_sync_at, 
   last_sync_status, audit_metadata, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateConnectionStmt = db.prepare(`
  UPDATE shop_connections SET
    shop_url = ?, idoxxy_base_url = ?, idoxxy_workspace_id = ?, idoxxy_token_encrypted = ?,
    status = ?, token_last_verified_at = ?, revoked_at = ?, revoked_by = ?, last_error = ?,
    last_sync_at = ?, last_sync_status = ?, audit_metadata = ?, updated_at = ?
  WHERE shop_id = ?
`);
const deleteConnectionStmt = db.prepare("DELETE FROM shop_connections WHERE shop_id = ?");

export class ShopConnectionRepository {
  private rowToConnection(row: any): ShopConnection {
    return {
      shopId: row.shop_id,
      shopUrl: row.shop_url || undefined,
      status: row.status as ShopConnectionStatus,
      idoxxyWorkspaceId: row.idoxxy_workspace_id || undefined,
      idoxxyBaseUrl: row.idoxxy_base_url || undefined,
      idoxxyTokenEncrypted: row.idoxxy_token_encrypted || undefined,
      tokenLastVerifiedAt: row.token_last_verified_at || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revokedAt: row.revoked_at || undefined,
      revokedBy: row.revoked_by || undefined,
      lastError: row.last_error || undefined,
      lastSyncAt: row.last_sync_at || undefined,
      lastSyncStatus: row.last_sync_status || undefined,
      auditMetadata: row.audit_metadata ? JSON.parse(row.audit_metadata) : undefined,
    };
  }

  upsert(payload: UpsertShopConnectionPayload): ShopConnection {
    const existing = this.get(payload.shopId);
    const timestamp = now();

    if (existing) {
      // Update
      const status = payload.status ?? existing.status;
      updateConnectionStmt.run(
        payload.shopUrl ?? existing.shopUrl ?? null,
        payload.idoxxyBaseUrl ?? existing.idoxxyBaseUrl ?? null,
        payload.idoxxyWorkspaceId ?? existing.idoxxyWorkspaceId ?? null,
        payload.idoxxyTokenEncrypted ?? existing.idoxxyTokenEncrypted ?? null,
        status,
        payload.tokenLastVerifiedAt ?? existing.tokenLastVerifiedAt ?? null,
        payload.revokedAt ?? existing.revokedAt ?? null,
        payload.revokedBy ?? existing.revokedBy ?? null,
        payload.lastError ?? existing.lastError ?? null,
        payload.lastSyncAt ?? existing.lastSyncAt ?? null,
        payload.lastSyncStatus ?? existing.lastSyncStatus ?? null,
        payload.auditMetadata ? JSON.stringify(payload.auditMetadata) : existing.auditMetadata ? JSON.stringify(existing.auditMetadata) : null,
        timestamp,
        payload.shopId
      );
    } else {
      // Insert
      const status = payload.status ?? "installed_not_linked";
      insertConnectionStmt.run(
        payload.shopId,
        payload.shopUrl ?? null,
        payload.idoxxyBaseUrl ?? null,
        payload.idoxxyWorkspaceId ?? null,
        payload.idoxxyTokenEncrypted ?? null,
        status,
        payload.tokenLastVerifiedAt ?? null,
        payload.revokedAt ?? null,
        payload.revokedBy ?? null,
        payload.lastError ?? null,
        payload.lastSyncAt ?? null,
        payload.lastSyncStatus ?? null,
        payload.auditMetadata ? JSON.stringify(payload.auditMetadata) : null,
        timestamp,
        timestamp
      );
    }

    const updated = this.get(payload.shopId);
    if (!updated) {
      throw new Error(`Failed to upsert shop connection for shopId=${payload.shopId}`);
    }
    return updated;
  }

  get(shopId: string): ShopConnection | undefined {
    const row = getConnectionStmt.get(shopId);
    if (!row) return undefined;
    return this.rowToConnection(row);
  }

  list(): ShopConnection[] {
    const rows = getAllConnectionsStmt.all() as any[];
    return rows.map(row => this.rowToConnection(row));
  }

  markLinked(shopId: string, workspaceId: string, tokenEncrypted: string, verifiedAt?: number) {
    const current = this.getOrThrow(shopId);
    const updated = this.upsert({
      shopId: current.shopId,
      shopUrl: current.shopUrl,
      idoxxyWorkspaceId: workspaceId,
      idoxxyBaseUrl: current.idoxxyBaseUrl,
      idoxxyTokenEncrypted: tokenEncrypted,
      tokenLastVerifiedAt: verifiedAt ?? now(),
      status: "linked",
      auditMetadata: current.auditMetadata,
      revokedAt: undefined,
      revokedBy: undefined,
      lastError: undefined,
      lastSyncAt: undefined,
      lastSyncStatus: undefined,
    });
    return updated;
  }

  markTokenInvalid(shopId: string, lastError?: string) {
    const current = this.getOrThrow(shopId);
    const payload: UpsertShopConnectionPayload = {
      shopId: current.shopId,
      shopUrl: current.shopUrl,
      status: "token_invalid",
      idoxxyWorkspaceId: current.idoxxyWorkspaceId,
      idoxxyBaseUrl: current.idoxxyBaseUrl,
      idoxxyTokenEncrypted: current.idoxxyTokenEncrypted,
      tokenLastVerifiedAt: current.tokenLastVerifiedAt,
      auditMetadata: current.auditMetadata,
      revokedAt: undefined,
      revokedBy: undefined,
      lastError: lastError || current.lastError,
      lastSyncAt: current.lastSyncAt,
      lastSyncStatus: current.lastSyncStatus,
    };
    const updated = this.upsert(payload);
    return updated;
  }

  revoke(shopId: string, revokedBy?: string) {
    const current = this.getOrThrow(shopId);
    const timestamp = now();
    const payload: UpsertShopConnectionPayload = {
      shopId: current.shopId,
      shopUrl: current.shopUrl,
      idoxxyWorkspaceId: current.idoxxyWorkspaceId,
      idoxxyBaseUrl: current.idoxxyBaseUrl,
      idoxxyTokenEncrypted: current.idoxxyTokenEncrypted,
      tokenLastVerifiedAt: current.tokenLastVerifiedAt,
      status: "revoked",
      auditMetadata: current.auditMetadata,
      revokedAt: timestamp,
      revokedBy: revokedBy || undefined,
      lastError: current.lastError,
      lastSyncAt: current.lastSyncAt,
      lastSyncStatus: current.lastSyncStatus,
    };

    const updated = this.upsert(payload);
    return updated;
  }

  updateTokenVerification(shopId: string, verifiedAt?: number) {
    const current = this.getOrThrow(shopId);
    const updated = this.upsert({
      shopId: current.shopId,
      shopUrl: current.shopUrl,
      idoxxyWorkspaceId: current.idoxxyWorkspaceId,
      idoxxyBaseUrl: current.idoxxyBaseUrl,
      idoxxyTokenEncrypted: current.idoxxyTokenEncrypted,
      tokenLastVerifiedAt: verifiedAt ?? now(),
      status: current.status === "token_invalid" ? "linked" : current.status,
      auditMetadata: current.auditMetadata,
      revokedAt: current.revokedAt,
      revokedBy: current.revokedBy,
      lastError: current.lastError,
      lastSyncAt: current.lastSyncAt,
      lastSyncStatus: current.lastSyncStatus,
    });
    return updated;
  }

  private getOrThrow(shopId: string) {
    const found = this.get(shopId);
    if (!found) {
      throw new Error(`No shop connection found for shopId=${shopId}`);
    }
    return found;
  }
}

export const shopConnectionRepository = new ShopConnectionRepository();
