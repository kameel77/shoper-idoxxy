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
   shoper_access_token, shoper_refresh_token, status, token_last_verified_at, revoked_at,
   revoked_by, last_error, last_sync_at, last_sync_status, audit_metadata, shoper_license, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateConnectionStmt = db.prepare(`
  UPDATE shop_connections SET
    shop_url = ?, idoxxy_base_url = ?, idoxxy_workspace_id = ?, idoxxy_token_encrypted = ?,
    shoper_access_token = ?, shoper_refresh_token = ?, status = ?, token_last_verified_at = ?,
    revoked_at = ?, revoked_by = ?, last_error = ?, last_sync_at = ?, last_sync_status = ?,
    audit_metadata = ?, shoper_license = ?, updated_at = ?
  WHERE shop_id = ?
`);
const deleteConnectionStmt = db.prepare("DELETE FROM shop_connections WHERE shop_id = ?");
// GDPR (Defect B, stage 1): on a verified uninstall the stored tokens are
// useless immediately (iDoxxy workspace token and Shoper OAuth access/refresh
// tokens all stop working once the app is uninstalled), so they are wiped
// right away rather than waiting for the grace-period purge in
// src/services/dataRetentionService.ts. Deliberately a single narrow UPDATE
// (same rationale as updateTokenColumn below) rather than routed through
// revoke() + upsert()'s general merge: everything except status/revoked_at/
// revoked_by/the three token columns must survive untouched (shop_url,
// mappings elsewhere, settings elsewhere, shoper_license, ...) so a reinstall
// inside the grace period has something to revive.
const revokeAndWipeTokensStmt = db.prepare(`
  UPDATE shop_connections SET
    status = 'revoked',
    revoked_at = ?,
    revoked_by = ?,
    idoxxy_token_encrypted = NULL,
    shoper_access_token = NULL,
    shoper_refresh_token = NULL,
    updated_at = ?
  WHERE shop_id = ?
`);
const getConnectionByLicenseStmt = db.prepare(
  "SELECT * FROM shop_connections WHERE shoper_license = ?",
);
// Narrow single-column update - same rationale as updateTokenColumn below:
// don't route an opportunistic license backfill through the general upsert()
// merge, which re-derives every column from an existing/payload merge.
const updateShoperLicenseColumnStmt = db.prepare(
  "UPDATE shop_connections SET shoper_license = ?, updated_at = ? WHERE shop_id = ?",
);

// Narrow single-column update - same rationale as updateShoperLicenseColumnStmt
// above. See src/types/shopConnection.ts's technicalUrl doc comment for why
// this deliberately never goes through upsert()'s general merge.
const updateTechnicalUrlColumnStmt = db.prepare(
  "UPDATE shop_connections SET technical_url = ?, updated_at = ? WHERE shop_id = ?",
);

// Narrow single-column updates used for lazy legacy-token re-encryption (see
// shopConnectionService.ts). Deliberately NOT routed through upsert(), which
// re-derives every column from an `existing ?? payload` merge - a dedicated
// UPDATE of exactly one column plus updated_at makes "cannot clobber other
// columns" a property of the SQL itself rather than of merge logic.
const updateIdoxxyTokenColumnStmt = db.prepare(
  "UPDATE shop_connections SET idoxxy_token_encrypted = ?, updated_at = ? WHERE shop_id = ?",
);
const updateShoperAccessTokenColumnStmt = db.prepare(
  "UPDATE shop_connections SET shoper_access_token = ?, updated_at = ? WHERE shop_id = ?",
);
const updateShoperRefreshTokenColumnStmt = db.prepare(
  "UPDATE shop_connections SET shoper_refresh_token = ?, updated_at = ? WHERE shop_id = ?",
);

export type TokenColumn = "idoxxyTokenEncrypted" | "shoperAccessToken" | "shoperRefreshToken";

export class ShopConnectionRepository {
  private rowToConnection(row: any): ShopConnection {
    return {
      shopId: row.shop_id,
      shopUrl: row.shop_url || undefined,
      status: row.status as ShopConnectionStatus,
      idoxxyWorkspaceId: row.idoxxy_workspace_id || undefined,
      idoxxyBaseUrl: row.idoxxy_base_url || undefined,
      idoxxyTokenEncrypted: row.idoxxy_token_encrypted || undefined,
      shoperAccessToken: row.shoper_access_token || undefined,
      shoperRefreshToken: row.shoper_refresh_token || undefined,
      shoperLicense: row.shoper_license || undefined,
      technicalUrl: row.technical_url || undefined,
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
        payload.shoperAccessToken ?? existing.shoperAccessToken ?? null,
        payload.shoperRefreshToken ?? existing.shoperRefreshToken ?? null,
        status,
        payload.tokenLastVerifiedAt ?? existing.tokenLastVerifiedAt ?? null,
        payload.revokedAt ?? existing.revokedAt ?? null,
        payload.revokedBy ?? existing.revokedBy ?? null,
        payload.lastError ?? existing.lastError ?? null,
        payload.lastSyncAt ?? existing.lastSyncAt ?? null,
        payload.lastSyncStatus ?? existing.lastSyncStatus ?? null,
        payload.auditMetadata ? JSON.stringify(payload.auditMetadata) : existing.auditMetadata ? JSON.stringify(existing.auditMetadata) : null,
        payload.shoperLicense ?? existing.shoperLicense ?? null,
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
        payload.shoperAccessToken ?? null,
        payload.shoperRefreshToken ?? null,
        status,
        payload.tokenLastVerifiedAt ?? null,
        payload.revokedAt ?? null,
        payload.revokedBy ?? null,
        payload.lastError ?? null,
        payload.lastSyncAt ?? null,
        payload.lastSyncStatus ?? null,
        payload.auditMetadata ? JSON.stringify(payload.auditMetadata) : null,
        payload.shoperLicense ?? null,
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
      shoperAccessToken: current.shoperAccessToken,
      shoperRefreshToken: current.shoperRefreshToken,
      shoperLicense: current.shoperLicense,
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
      shoperAccessToken: current.shoperAccessToken,
      shoperRefreshToken: current.shoperRefreshToken,
      shoperLicense: current.shoperLicense,
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
      shoperAccessToken: current.shoperAccessToken,
      shoperRefreshToken: current.shoperRefreshToken,
      shoperLicense: current.shoperLicense,
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
      shoperAccessToken: current.shoperAccessToken,
      shoperRefreshToken: current.shoperRefreshToken,
      shoperLicense: current.shoperLicense,
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

  /**
   * GDPR (Defect B, stage 1): revoke shopId and immediately wipe its
   * idoxxy_token_encrypted/shoper_access_token/shoper_refresh_token columns,
   * leaving every other column (shop_url, idoxxy_workspace_id,
   * shoper_license, audit_metadata, ...) untouched. See
   * revokeAndWipeTokensStmt above for why this bypasses upsert().
   */
  revokeAndWipeTokens(shopId: string, revokedBy?: string): ShopConnection {
    const timestamp = now();
    revokeAndWipeTokensStmt.run(timestamp, revokedBy || null, timestamp, shopId);
    return this.getOrThrow(shopId);
  }

  delete(shopId: string): boolean {
    const result = deleteConnectionStmt.run(shopId);
    return result.changes > 0;
  }

  /** Resolve a connection by Shoper's App Store "shop" (license) identifier. */
  getByLicense(license: string): ShopConnection | undefined {
    const row = getConnectionByLicenseStmt.get(license);
    if (!row) return undefined;
    return this.rowToConnection(row);
  }

  /**
   * Overwrite exactly the shoper_license column (plus updated_at), touching
   * nothing else on the row. Mirrors updateTokenColumn below - used to
   * opportunistically backfill the license mapping without routing through
   * the general upsert() merge.
   */
  updateShoperLicense(shopId: string, license: string): void {
    updateShoperLicenseColumnStmt.run(license, now(), shopId);
  }

  /**
   * Overwrite exactly the technical_url column (plus updated_at), touching
   * nothing else on the row. See src/types/shopConnection.ts's technicalUrl
   * doc comment for what this is and why it's a narrow update.
   */
  updateTechnicalUrl(shopId: string, technicalUrl: string): void {
    updateTechnicalUrlColumnStmt.run(technicalUrl, now(), shopId);
  }

  /**
   * Overwrite exactly one token column (plus updated_at) for shopId, touching
   * nothing else on the row. Used to lazily re-encrypt a legacy base64 token
   * value the moment it is read (see shopConnectionService.ts) without
   * risking any interaction with concurrent writes to other columns.
   */
  updateTokenColumn(shopId: string, column: TokenColumn, encryptedValue: string): void {
    const timestamp = now();
    switch (column) {
      case "idoxxyTokenEncrypted":
        updateIdoxxyTokenColumnStmt.run(encryptedValue, timestamp, shopId);
        return;
      case "shoperAccessToken":
        updateShoperAccessTokenColumnStmt.run(encryptedValue, timestamp, shopId);
        return;
      case "shoperRefreshToken":
        updateShoperRefreshTokenColumnStmt.run(encryptedValue, timestamp, shopId);
        return;
    }
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
