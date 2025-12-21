export type ShopConnectionStatus =
  | "installed_not_linked"
  | "linked"
  | "token_invalid"
  | "revoked";

export type ShopConnection = {
  shopId: string;
  shopUrl?: string;
  status: ShopConnectionStatus;
  idoxxyWorkspaceId?: string;
  idoxxyBaseUrl?: string;
  idoxxyTokenEncrypted?: string;
  tokenLastVerifiedAt?: number;
  createdAt: number;
  updatedAt: number;
  revokedAt?: number;
  revokedBy?: string;
  lastError?: string;
  lastSyncAt?: number;
  lastSyncStatus?: "success" | "error";
  auditMetadata?: Record<string, unknown>;
};

export type UpsertShopConnectionPayload = {
  shopId: string;
  shopUrl?: string;
  idoxxyWorkspaceId?: string;
  idoxxyBaseUrl?: string;
  idoxxyTokenEncrypted?: string;
  tokenLastVerifiedAt?: number;
  status?: ShopConnectionStatus;
  auditMetadata?: Record<string, unknown>;
  revokedAt?: number;
  revokedBy?: string;
  lastError?: string;
  lastSyncAt?: number;
  lastSyncStatus?: "success" | "error";
};
