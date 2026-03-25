import { shopConnectionRepository } from "../repositories/shopConnectionRepository";
import type { ShopConnection, ShopConnectionStatus, UpsertShopConnectionPayload } from "../types/shopConnection";

const encodeToken = (token: string) => {
  // Placeholder for future encryption/KMS; for now simple base64 to avoid plain-text storage.
  return Buffer.from(token, "utf8").toString("base64");
};

const decodeToken = (tokenEncoded?: string) => {
  if (!tokenEncoded) return undefined;
  return Buffer.from(tokenEncoded, "base64").toString("utf8");
};

export class ShopConnectionService {
  registerInstallation(shopId: string, shopUrl?: string): ShopConnection {
    const payload: UpsertShopConnectionPayload = {
      shopId,
      status: "installed_not_linked",
      shopUrl: shopUrl || undefined,
      idoxxyWorkspaceId: undefined,
      idoxxyBaseUrl: undefined,
      idoxxyTokenEncrypted: undefined,
      tokenLastVerifiedAt: undefined,
      auditMetadata: undefined,
      revokedAt: undefined,
      revokedBy: undefined,
      lastError: undefined,
      lastSyncAt: undefined,
      lastSyncStatus: undefined,
    };

    return shopConnectionRepository.upsert(payload);
  }

  getConnection(shopId: string) {
    return shopConnectionRepository.get(shopId);
  }

  listConnections() {
    return shopConnectionRepository.list();
  }

  saveLink(payload: { shopId: string; token: string; status: ShopConnectionStatus | undefined; tokenLastVerifiedAt: number | undefined; shopUrl: string | undefined; idoxxyWorkspaceId: string | undefined; idoxxyBaseUrl: string | undefined; }) {
    const tokenEncoded = encodeToken(payload.token);

    const upsertPayload: UpsertShopConnectionPayload = {
      shopId: payload.shopId,
      status: payload.status ?? "linked",
      tokenLastVerifiedAt: payload.tokenLastVerifiedAt ?? Date.now(),
      shopUrl: payload.shopUrl || undefined,
      idoxxyWorkspaceId: payload.idoxxyWorkspaceId || undefined,
      idoxxyBaseUrl: payload.idoxxyBaseUrl || undefined,
      idoxxyTokenEncrypted: tokenEncoded || undefined,
      auditMetadata: undefined,
      revokedAt: undefined,
      revokedBy: undefined,
      lastError: undefined,
      lastSyncAt: undefined,
      lastSyncStatus: undefined,
    };

    return shopConnectionRepository.upsert(upsertPayload);
  }

  markLinked(shopId: string, workspaceId: string, token: string, verifiedAt?: number) {
    return shopConnectionRepository.markLinked(shopId, workspaceId, encodeToken(token), verifiedAt);
  }

  markTokenInvalid(shopId: string, lastError?: string) {
    return shopConnectionRepository.markTokenInvalid(shopId, lastError);
  }

  markVerified(shopId: string, verifiedAt?: number) {
    return shopConnectionRepository.updateTokenVerification(shopId, verifiedAt);
  }

  revoke(shopId: string, revokedBy?: string) {
    return shopConnectionRepository.revoke(shopId, revokedBy);
  }

  getToken(shopId: string) {
    const connection = this.getConnection(shopId);
    if (!connection?.idoxxyTokenEncrypted) return undefined;
    return decodeToken(connection.idoxxyTokenEncrypted);
  }
}

export const shopConnectionService = new ShopConnectionService();
