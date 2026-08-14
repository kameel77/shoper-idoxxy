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
  shoperAccessToken: string | undefined;
  shoperRefreshToken: string | undefined;
  // Shoper App Store's "shop" identifier - a 40-char license-style string,
  // distinct from shopId (numeric, from application-info's shop_id). See
  // src/middleware/shoperSignature.ts's iframe-entry section for why this
  // exists as a separate column rather than being conflated with shopId.
  shoperLicense: string | undefined;
  // The `technical_url` host from Shoper's /webapi/rest/application-config
  // response (see src/routes/install.ts and the install branch of
  // src/routes/settings.ts), distinct from shopUrl (which may be a custom
  // domain). Written only via ShopConnectionRepository.updateTechnicalUrl -
  // a narrow single-column update, same pattern as shoperLicense's - so it is
  // deliberately NOT part of UpsertShopConnectionPayload below. Used to
  // narrow the CSP frame-ancestors directive per-response once both hosts are
  // known for a shop session (see src/app.ts).
  technicalUrl: string | undefined;
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
  shoperAccessToken: string | undefined;
  shoperRefreshToken: string | undefined;
  shoperLicense: string | undefined;
  tokenLastVerifiedAt: number | undefined;
  status: ShopConnectionStatus | undefined;
  auditMetadata: Record<string, unknown> | undefined;
  revokedAt: number | undefined;
  revokedBy: string | undefined;
  lastError: string | undefined;
  lastSyncAt: number | undefined;
  lastSyncStatus: "success" | "error" | undefined;
};
