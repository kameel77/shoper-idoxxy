import type {
  ShopConnection,
  ShopConnectionStatus,
  UpsertShopConnectionPayload,
} from "../types/shopConnection";

const now = () => Date.now();

export class ShopConnectionRepository {
  private connections: Map<string, ShopConnection> = new Map();

  upsert(payload: UpsertShopConnectionPayload): ShopConnection {
    const existing = this.connections.get(payload.shopId);
    const timestamp = now();
    const cleanedPayload = Object.fromEntries(
      Object.entries(payload).filter(([, value]) => value !== undefined),
    ) as UpsertShopConnectionPayload;

    const base: ShopConnection = existing ?? {
      shopId: payload.shopId,
      ...(payload.shopUrl ? { shopUrl: payload.shopUrl } : {}),
      status: "installed_not_linked",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const status: ShopConnectionStatus = payload.status ?? base.status;

    const updated: ShopConnection = {
      ...base,
      ...(cleanedPayload as Partial<ShopConnection>),
      status,
      updatedAt: timestamp,
    };

    this.connections.set(payload.shopId, updated);
    return updated;
  }

  get(shopId: string): ShopConnection | undefined {
    return this.connections.get(shopId);
  }

  list(): ShopConnection[] {
    return Array.from(this.connections.values());
  }

  markLinked(shopId: string, workspaceId: string, tokenEncrypted: string, verifiedAt?: number) {
    const current = this.getOrThrow(shopId);
    const updated = this.upsert({
      ...current,
      idoxxyWorkspaceId: workspaceId,
      idoxxyTokenEncrypted: tokenEncrypted,
      tokenLastVerifiedAt: verifiedAt ?? now(),
      status: "linked",
    });
    return updated;
  }

  markTokenInvalid(shopId: string, lastError?: string) {
    const current = this.getOrThrow(shopId);
    const payload: UpsertShopConnectionPayload = {
      shopId: current.shopId,
      status: "token_invalid",
    };
    if (current.shopUrl) payload.shopUrl = current.shopUrl;
    if (current.idoxxyWorkspaceId) payload.idoxxyWorkspaceId = current.idoxxyWorkspaceId;
    if (current.idoxxyBaseUrl) payload.idoxxyBaseUrl = current.idoxxyBaseUrl;
    if (current.idoxxyTokenEncrypted) payload.idoxxyTokenEncrypted = current.idoxxyTokenEncrypted;
    if (current.tokenLastVerifiedAt) payload.tokenLastVerifiedAt = current.tokenLastVerifiedAt;
    if (current.auditMetadata) payload.auditMetadata = current.auditMetadata;
    if (current.lastSyncAt) payload.lastSyncAt = current.lastSyncAt;
    if (current.lastSyncStatus) payload.lastSyncStatus = current.lastSyncStatus;
    if (lastError) payload.lastError = lastError;
    const updated = this.upsert(payload);
    return updated;
  }

  revoke(shopId: string, revokedBy?: string) {
    const current = this.getOrThrow(shopId);
    const timestamp = now();
    const payload: UpsertShopConnectionPayload = {
      shopId: current.shopId,
      status: "revoked",
      revokedAt: timestamp,
    };

    if (current.shopUrl) payload.shopUrl = current.shopUrl;
    if (current.idoxxyWorkspaceId) payload.idoxxyWorkspaceId = current.idoxxyWorkspaceId;
    if (current.idoxxyBaseUrl) payload.idoxxyBaseUrl = current.idoxxyBaseUrl;
    if (current.idoxxyTokenEncrypted) payload.idoxxyTokenEncrypted = current.idoxxyTokenEncrypted;
    if (current.tokenLastVerifiedAt) payload.tokenLastVerifiedAt = current.tokenLastVerifiedAt;
    if (current.auditMetadata) payload.auditMetadata = current.auditMetadata;
    if (current.lastError) payload.lastError = current.lastError;
    if (current.lastSyncAt) payload.lastSyncAt = current.lastSyncAt;
    if (current.lastSyncStatus) payload.lastSyncStatus = current.lastSyncStatus;
    if (revokedBy) payload.revokedBy = revokedBy;

    const updated = this.upsert(payload);
    return updated;
  }

  updateTokenVerification(shopId: string, verifiedAt?: number) {
    const current = this.getOrThrow(shopId);
    const updated = this.upsert({
      ...current,
      tokenLastVerifiedAt: verifiedAt ?? now(),
      status: current.status === "token_invalid" ? "linked" : current.status,
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
