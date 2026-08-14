import "dotenv/config";

import crypto from "node:crypto";

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z
    .string()
    .optional()
    .transform((value) => (value ? Number(value) : 3000))
    .pipe(z.number().int().positive()),
  IDOXXY_API_KEY: z.string().optional(),
  IDOXXY_CLIENT_ID: z.string().optional(),
  IDOXXY_CLIENT_SECRET: z.string().optional(),
  IDOXXY_BASE_URL: z.string().url().default("https://api.idoxxy.com"),
  SHOPER_BASE_URL: z
    .string()
    .url()
    .default("https://example.shoper.pl/webapi/rest"),
  SHOPER_CLIENT_ID: z.string().optional(),
  SHOPER_CLIENT_SECRET: z.string().optional(),
  SHOPER_WEBHOOK_SECRET: z.string().optional(),
  SHOPER_APP_STORE_CLIENT_ID: z.string().optional(),
  // Secret generated during App Store application registration in the Shoper
  // developer panel. Verifies the `hash` field Shoper attaches to App Store
  // lifecycle/billing callbacks (install/uninstall/billing_*) - see
  // src/middleware/shoperSignature.ts for the confirmed algorithm and source.
  // Distinct from SHOPER_WEBHOOK_SECRET, which protects unrelated event webhooks.
  SHOPER_APPSTORE_SECRET: z.string().optional(),
  SESSION_SECRET: z.string().min(32).default("change-this-secret-in-production-to-at-least-32-characters"),
  // Operator (admin) account bootstrap - see src/repositories/userRepository.ts's
  // bootstrapAdminAccount(). ADMIN_PASSWORD is intentionally optional here (not
  // `.min(16)` on the schema itself) so a missing/short value can be reported with
  // the same fail-fast-in-production-only posture as SESSION_SECRET/
  // SHOPER_WEBHOOK_SECRET below, rather than a generic Zod validation error.
  ADMIN_USERNAME: z.string().min(1).default("admin"),
  ADMIN_PASSWORD: z.string().optional(),
  // Base64-encoded 32-byte key used to encrypt tenant tokens at rest (iDoxxy
  // workspace token, Shoper OAuth access/refresh tokens). Generate with:
  //   openssl rand -base64 32
  // See src/services/tokenCrypto.ts.
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  // Email configuration
  EMAIL_PROVIDER: z.enum(["sendgrid", "smtp", "console"]).default("console"),
  SENDGRID_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional().transform((v) => v ? Number(v) : 587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().email().default("noreply@shoper-idoxxy.local"),
  EMAIL_FROM_NAME: z.string().default("Shoper Idoxxy Integration"),
  // GDPR data-lifecycle knobs (see src/services/dataRetentionService.ts).
  // sync_logs stores merchants' customers' e-mail addresses - a legal
  // retention obligation, not housekeeping - so both windows are validated
  // as strictly positive integers: a "0" would otherwise be misread as
  // "delete everything immediately", which is not what an operator setting
  // 0 almost certainly means.
  SYNC_LOG_RETENTION_DAYS: z
    .string()
    .optional()
    .transform((value) => (value ? Number(value) : 90))
    .pipe(z.number().int().positive()),
  UNINSTALL_PURGE_GRACE_DAYS: z
    .string()
    .optional()
    .transform((value) => (value ? Number(value) : 30))
    .pipe(z.number().int().positive()),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);

export const isProduction = env.NODE_ENV === "production";

if (isProduction && env.SESSION_SECRET === "change-this-secret-in-production-to-at-least-32-characters") {
  throw new Error("W środowisku produkcyjnym wymagane jest podanie silnego SESSION_SECRET w zmiennych środowiskowych.");
}

// The operator/admin account (see src/repositories/userRepository.ts) can read
// every merchant's connection (GET /settings/link/connections) and, via the
// ?shopId= operator override, act on any shop. A missing or short
// ADMIN_PASSWORD in production would mean that account is bootstrapped with a
// predictable/weak password (or, previously, a hardcoded default) - refuse to
// boot rather than ship that. Deliberately never echoes the configured value
// back in this message.
if (isProduction && (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 16)) {
  throw new Error(
    "W środowisku produkcyjnym wymagane jest podanie ADMIN_PASSWORD o długości co najmniej 16 znaków - w przeciwnym razie konto administratora zostałoby utworzone z domyślnym lub zbyt słabym hasłem.",
  );
}

if (!isProduction && !env.ADMIN_PASSWORD) {
  // Intentionally never logs the developer-only fallback password itself
  // (see src/repositories/userRepository.ts) - only that one is in use.
  console.warn(
    "[Config] ADMIN_PASSWORD nie jest ustawiony - konto administratora zostanie utworzone z domyślnym hasłem deweloperskim. " +
      "Dopuszczalne tylko poza produkcją; ustaw silne ADMIN_USERNAME/ADMIN_PASSWORD przed wdrożeniem produkcyjnym.",
  );
}

// Webhook signature verification is optional outside production purely for
// local development convenience. In production a missing/weak secret would
// silently mean webhooks are accepted from anyone - that's a critical hole
// (arbitrary customer injection into a merchant's iDoxxy workspace), so we
// refuse to boot instead.
if (isProduction && (!env.SHOPER_WEBHOOK_SECRET || env.SHOPER_WEBHOOK_SECRET.length < 32)) {
  throw new Error(
    "W środowisku produkcyjnym wymagane jest podanie SHOPER_WEBHOOK_SECRET o długości co najmniej 32 znaków - w przeciwnym razie webhooki Shopera byłyby akceptowane bez weryfikacji podpisu.",
  );
}

if (!isProduction && !env.SHOPER_WEBHOOK_SECRET) {
  // Intentionally logged once here at startup, not per-request (see
  // src/routes/webhooks.ts verifyShoperSignature).
  console.warn(
    "[Config] SHOPER_WEBHOOK_SECRET nie jest ustawiony - podpisy webhooków Shopera NIE są weryfikowane. " +
      "Dopuszczalne tylko poza produkcją; ustaw tę zmienną przed wdrożeniem.",
  );
}

// App Store lifecycle/billing callbacks (POST /uninstall, /billing/subscription,
// /billing/automatic-messages - see src/routes/install.ts) are equally
// dangerous if left unverified: an unauthenticated POST can revoke any
// merchant's connection. Same fail-fast posture as SHOPER_WEBHOOK_SECRET
// above. Shoper does not document a minimum length for appstore_secret (it is
// an opaque value generated by their panel), so unlike SESSION_SECRET/
// SHOPER_WEBHOOK_SECRET we only require it to be present, not a minimum length.
if (isProduction && !env.SHOPER_APPSTORE_SECRET) {
  throw new Error(
    "W środowisku produkcyjnym wymagane jest podanie SHOPER_APPSTORE_SECRET - w przeciwnym razie wywołania App Store (uninstall/billing) byłyby akceptowane bez weryfikacji podpisu.",
  );
}

if (!isProduction && !env.SHOPER_APPSTORE_SECRET) {
  console.warn(
    "[Config] SHOPER_APPSTORE_SECRET nie jest ustawiony - podpisy wywołań App Store (uninstall/billing) NIE są weryfikowane. " +
      "Dopuszczalne tylko poza produkcją; ustaw tę zmienną przed wdrożeniem.",
  );
}

const TOKEN_ENCRYPTION_KEY_BYTES = 32;

const resolveTokenEncryptionKey = (): Buffer => {
  if (env.TOKEN_ENCRYPTION_KEY) {
    const decoded = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64");
    if (decoded.length !== TOKEN_ENCRYPTION_KEY_BYTES) {
      throw new Error(
        `TOKEN_ENCRYPTION_KEY musi być kluczem base64 dekodującym się do dokładnie ${TOKEN_ENCRYPTION_KEY_BYTES} bajtów (wygeneruj przez: openssl rand -base64 32).`,
      );
    }
    return decoded;
  }

  if (isProduction) {
    throw new Error(
      "W środowisku produkcyjnym wymagane jest podanie TOKEN_ENCRYPTION_KEY (base64, 32 bajty) - w przeciwnym razie tokeny sklepów byłyby przechowywane bez realnego szyfrowania.",
    );
  }

  // Ephemeral development-only key: fine for a single running process, but
  // stored tokens become undecryptable the moment the process restarts (a
  // new random key is generated every time). That's an acceptable trade-off
  // for local dev/test, never for anything long-lived.
  console.warn(
    "[Config] TOKEN_ENCRYPTION_KEY nie jest ustawiony - wygenerowano tymczasowy klucz developerski w pamięci procesu. " +
      "Zaszyfrowane tokeny NIE przetrwają restartu procesu. Ustaw TOKEN_ENCRYPTION_KEY przed wdrożeniem produkcyjnym.",
  );
  return crypto.randomBytes(TOKEN_ENCRYPTION_KEY_BYTES);
};

/**
 * AES-256-GCM key for src/services/tokenCrypto.ts. Resolved once at module
 * load (same lifecycle as `env` itself) so every call site shares one key for
 * the lifetime of the process.
 */
export const tokenEncryptionKey: Buffer = resolveTokenEncryptionKey();
