import { shopConnectionRepository } from "../repositories/shopConnectionRepository";
import type { TokenColumn } from "../repositories/shopConnectionRepository";
import { decryptToken, encryptToken, isLegacyEncodedToken } from "./tokenCrypto";
import type { ShopConnection, ShopConnectionStatus, UpsertShopConnectionPayload } from "../types/shopConnection";

// AES-256-GCM via src/services/tokenCrypto.ts. All three of idoxxyTokenEncrypted
// (column: idoxxy_token_encrypted), shoperAccessToken (shoper_access_token) and
// shoperRefreshToken (shoper_refresh_token) hold real ciphertext, not base64 -
// the column names predate this change and are kept as-is to avoid a schema
// migration, but idoxxy_token_encrypted is now finally an accurate name.
const encodeToken = (token: string): string => encryptToken(token);

/**
 * Decrypt a stored token, transparently upgrading a legacy plain-base64 value
 * in place (lazy migration): on a successful read of a legacy value, it is
 * re-encrypted and written back via a narrow single-column UPDATE (see
 * shopConnectionRepository.updateTokenColumn), so a deployed database drains
 * itself of legacy values over time without a big-bang migration and without
 * ever touching sibling columns on the same row.
 *
 * decryptToken() throws on an AES-GCM auth-tag failure - in practice this
 * means TOKEN_ENCRYPTION_KEY has changed (rotated, or a fresh ephemeral dev
 * key after a restart) since the value was written, so the ciphertext can
 * never be recovered under the current key. That must NOT bubble up as an
 * unhandled 500 out of every webhook/settings endpoint for that shop: we log
 * just enough to diagnose (shopId, column - never the token/ciphertext/key),
 * mark the connection token_invalid via the repository directly (NOT via
 * decodeToken/getToken - markTokenInvalid never reads a token, so this
 * cannot recurse), and return undefined so callers take the existing
 * "shop not linked"/token-invalid path (428, or connection.status !==
 * "linked") instead of crashing.
 */
const decodeToken = (shopId: string, column: TokenColumn, tokenEncoded?: string): string | undefined => {
  if (!tokenEncoded) return undefined;

  let plaintext: string;
  try {
    plaintext = decryptToken(tokenEncoded);
  } catch (error) {
    console.error(
      "[ShopConnection] Nie udało się odszyfrować zapisanego tokenu - prawdopodobnie zmienił się (lub jest nieprawidłowy) TOKEN_ENCRYPTION_KEY.",
      { shopId, column },
    );
    shopConnectionRepository.markTokenInvalid(
      shopId,
      "Zapisany token nie mógł zostać odszyfrowany (prawdopodobnie zmienił się klucz szyfrowania TOKEN_ENCRYPTION_KEY). Połącz sklep z Idoxxy ponownie.",
    );
    return undefined;
  }

  if (isLegacyEncodedToken(tokenEncoded)) {
    shopConnectionRepository.updateTokenColumn(shopId, column, encryptToken(plaintext));
  }

  return plaintext;
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
      shoperAccessToken: undefined,
      shoperRefreshToken: undefined,
      shoperLicense: undefined,
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
      shoperAccessToken: undefined,
      shoperRefreshToken: undefined,
      shoperLicense: undefined,
      auditMetadata: undefined,
      revokedAt: undefined,
      revokedBy: undefined,
      lastError: undefined,
      lastSyncAt: undefined,
      lastSyncStatus: undefined,
    };

    return shopConnectionRepository.upsert(upsertPayload);
  }

  /**
   * Update only the stored shopUrl for a connection, preserving every other field
   * (in particular the iDoxxy token) untouched. Used to backfill shopUrl when it
   * is discovered opportunistically (e.g. from a webhook's X-Shop-Domain header).
   *
   * Deliberately narrower than saveLink(), which re-derives idoxxyTokenEncrypted
   * from a `token` argument and could blank an existing token if called with an
   * empty one.
   */
  updateShopUrl(shopId: string, shopUrl: string): ShopConnection {
    const current = this.getConnection(shopId);
    if (!current) {
      throw new Error(`Shop connection not found for shop ${shopId}`);
    }

    return shopConnectionRepository.upsert({
      shopId: current.shopId,
      shopUrl,
      idoxxyWorkspaceId: current.idoxxyWorkspaceId,
      idoxxyBaseUrl: current.idoxxyBaseUrl,
      idoxxyTokenEncrypted: current.idoxxyTokenEncrypted,
      shoperAccessToken: current.shoperAccessToken,
      shoperRefreshToken: current.shoperRefreshToken,
      shoperLicense: current.shoperLicense,
      tokenLastVerifiedAt: current.tokenLastVerifiedAt,
      status: current.status,
      auditMetadata: current.auditMetadata,
      revokedAt: current.revokedAt,
      revokedBy: current.revokedBy,
      lastError: current.lastError,
      lastSyncAt: current.lastSyncAt,
      lastSyncStatus: current.lastSyncStatus,
    });
  }

  markLinked(shopId: string, workspaceId: string, token: string, verifiedAt?: number) {
    return shopConnectionRepository.markLinked(shopId, workspaceId, encodeToken(token), verifiedAt);
  }

  saveShoperTokens(shopId: string, shoperAccessToken: string, shoperRefreshToken: string) {
    const existing = this.getConnection(shopId);
    if (!existing) {
      throw new Error(`Shop connection not found for shop ${shopId}`);
    }
    
    return shopConnectionRepository.upsert({
      ...existing,
      shoperAccessToken: encodeToken(shoperAccessToken),
      shoperRefreshToken: encodeToken(shoperRefreshToken),
    });
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

  /**
   * GDPR (Defect B, stage 1) - use this instead of revoke() for a verified
   * app uninstall: revokes the connection AND immediately wipes its iDoxxy/
   * Shoper OAuth tokens (they are useless post-uninstall anyway). shop_url,
   * settings and event_mappings are left in place for the grace period (see
   * src/services/dataRetentionService.ts's purgeExpiredUninstalledShops),
   * so a reinstall within that window - registerInstallation() - has
   * something to revive.
   */
  revokeAndWipeTokens(shopId: string, revokedBy?: string) {
    return shopConnectionRepository.revokeAndWipeTokens(shopId, revokedBy);
  }

  deleteConnection(shopId: string): boolean {
    return shopConnectionRepository.delete(shopId);
  }

  getToken(shopId: string) {
    const connection = this.getConnection(shopId);
    if (!connection?.idoxxyTokenEncrypted) return undefined;
    return decodeToken(shopId, "idoxxyTokenEncrypted", connection.idoxxyTokenEncrypted);
  }

  getShoperTokens(shopId: string) {
    const connection = this.getConnection(shopId);
    return {
      shoperAccessToken: decodeToken(shopId, "shoperAccessToken", connection?.shoperAccessToken),
      shoperRefreshToken: decodeToken(shopId, "shoperRefreshToken", connection?.shoperRefreshToken),
    };
  }

  /**
   * Resolve a shopId from Shoper's App Store "shop" (license) identifier -
   * used by the signature-verified iframe entry path (GET /settings) to turn
   * a verified `shop` param into a shopId without ever trusting `shop` itself
   * as a shopId. Returns undefined if no connection has this license recorded
   * yet (e.g. installed before this feature existed) - callers must fall
   * through to the existing reauthorize path on a miss, not treat it as an error.
   */
  getShopIdByLicense(license: string): string | undefined {
    return shopConnectionRepository.getByLicense(license)?.shopId;
  }

  /**
   * Opportunistically record the shop <-> license mapping once both are known
   * together from a trusted source (a proven OAuth install, or a
   * signature-verified App Store/iframe message). Narrow single-column write
   * (see shopConnectionRepository.updateShoperLicense) - never routed through
   * upsert()'s general merge, and a no-op if the connection doesn't exist yet
   * or already has this exact license recorded.
   */
  recordShoperLicense(shopId: string, license: string): void {
    const current = this.getConnection(shopId);
    if (!current || current.shoperLicense === license) {
      return;
    }
    shopConnectionRepository.updateShoperLicense(shopId, license);
  }

  /**
   * Opportunistically record the `technical_url` host from Shoper's
   * /webapi/rest/application-config response (see src/routes/install.ts and
   * the install branch of src/routes/settings.ts) - narrow single-column
   * write (see shopConnectionRepository.updateTechnicalUrl), never routed
   * through upsert()'s general merge. No-op if the connection doesn't exist
   * yet or already has this exact value recorded. Used by src/app.ts to
   * narrow the CSP frame-ancestors directive once both shopUrl and
   * technicalUrl are known for a shop's session.
   */
  recordTechnicalUrl(shopId: string, technicalUrl: string): void {
    const current = this.getConnection(shopId);
    if (!current || current.technicalUrl === technicalUrl) {
      return;
    }
    shopConnectionRepository.updateTechnicalUrl(shopId, technicalUrl);
  }
}

export const shopConnectionService = new ShopConnectionService();
