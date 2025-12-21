import { shopConnectionRepository } from "../repositories/shopConnectionRepository";
import type { ShopConnection, UpsertShopConnectionPayload } from "../types/shopConnection";

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
    };

    if (shopUrl) {
      payload.shopUrl = shopUrl;
    }

    return shopConnectionRepository.upsert(payload);
  }

  getConnection(shopId: string) {
    return shopConnectionRepository.get(shopId);
  }

  listConnections() {
    return shopConnectionRepository.list();
  }

  saveLink(payload: UpsertShopConnectionPayload & { token?: string }) {
    const tokenEncoded =
      payload.token !== undefined ? encodeToken(payload.token) : payload.idoxxyTokenEncrypted;

    const upsertPayload: UpsertShopConnectionPayload = {
      shopId: payload.shopId,
      status: payload.status ?? "linked",
      tokenLastVerifiedAt: payload.tokenLastVerifiedAt ?? Date.now(),
    };

    if (payload.shopUrl) upsertPayload.shopUrl = payload.shopUrl;
    if (payload.idoxxyWorkspaceId) upsertPayload.idoxxyWorkspaceId = payload.idoxxyWorkspaceId;
    if (payload.idoxxyBaseUrl) upsertPayload.idoxxyBaseUrl = payload.idoxxyBaseUrl;
    if (payload.auditMetadata) upsertPayload.auditMetadata = payload.auditMetadata;
    if (tokenEncoded) upsertPayload.idoxxyTokenEncrypted = tokenEncoded;

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
