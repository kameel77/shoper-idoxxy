export type ShopConnectionStatus =
  | "installed_not_linked"
  | "linked"
  | "token_invalid"
  | "revoked";

export type ShopConnection = {
  shopId: string;
  shopUrl: string | undefined;
  status: ShopConnectionStatus;
  idoxxyWorkspaceId: string | undefined;
  idoxxyBaseUrl: string | undefined;
  idoxxyTokenEncrypted: string | undefined;
  tokenLastVerifiedAt: number | undefined;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | undefined;
  revokedBy: string | undefined;
  lastError: string | undefined;
  lastSyncAt: number | undefined;
  lastSyncStatus: "success" | "error" | undefined;
  auditMetadata: Record<string, unknown> | undefined;
};

export type UpsertShopConnectionPayload = {
  shopId: string;
  shopUrl: string | undefined;
  idoxxyWorkspaceId: string | undefined;
  idoxxyBaseUrl: string | undefined;
  idoxxyTokenEncrypted: string | undefined;
  tokenLastVerifiedAt: number | undefined;
  status: ShopConnectionStatus | undefined;
  auditMetadata: Record<string, unknown> | undefined;
  revokedAt: number | undefined;
  revokedBy: string | undefined;
  lastError: string | undefined;
  lastSyncAt: number | undefined;
  lastSyncStatus: "success" | "error" | undefined;
};
