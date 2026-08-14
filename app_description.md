# Shoper ↔ iDoxxy Integration

## Overview

A Node.js/TypeScript Express application distributed as a Shoper App Store plugin. It links a Shoper shop to an iDoxxy document-delivery workspace and, on Shoper `customer.created`/`order.created` webhooks, creates/finds the customer in iDoxxy and assigns them to configurable groups (which can trigger document delivery on the iDoxxy side).

## Architecture

### Core components

- **Express server** (`src/app.ts`) with `helmet` security headers, a per-response `Content-Security-Policy` `frame-ancestors` directive (see "Iframe embedding" below), `express-session`, and a global error handler.
- **SQLite persistence** (`better-sqlite3`, WAL mode) — see "Data model" below. There is no in-memory store for any application data; `express-session` also uses a SQLite-backed store (`src/services/sessionStore.ts`), not the default in-process `MemoryStore`.
- **REST API** under `/settings`, `/admin/idoxxy`, `/customers`, `/auth` for configuration and administration.
- **Webhook handlers** under `/webhooks` for real-time Shoper event processing.
- **App Store lifecycle routes** (`/install`, `/oauth/callback`, `/uninstall`, `/billing/*`) implementing Shoper's OAuth install flow and billing/uninstall callbacks.
- **Client libraries** (`src/clients/`) for the Shoper and iDoxxy REST APIs.

### Runtime / key technologies

- Node.js ≥ 20, TypeScript, Express 5
- `better-sqlite3` for persistence, `express-session` (SQLite-backed store) for sessions
- `zod` for input validation
- `helmet` for security headers
- `bcrypt` for the operator/admin password hash
- `nodemailer` / `@sendgrid/mail` for outbound email (provider selectable via `EMAIL_PROVIDER`)

## Multi-tenant model

One Shoper shop is one tenant. Every table that holds shop-specific data (`shop_connections`, `settings`, `event_mappings`, `sync_logs`) carries a `shop_id` column, and the SQLite schema migration in `src/config/database.ts` backfills `shop_id` on rows that predate multi-tenancy. Every shop-scoped route resolves the acting shop from `req.shopId`, which `requireShopSession` (`src/middleware/shopSession.ts`) sets *only* from the verified session — never from a client-supplied header, query parameter or request body. Cross-tenant access is not possible through any documented endpoint: `resolveShopClient` (`src/middleware/resolveShopClient.ts`) resolves an iDoxxy client strictly from `req.shopId`, and mutation endpoints that also accept a `shopId` in the body/params (e.g. `DELETE /settings/link/:shopId`) reject it via `ensureShopIdMatchesSession` if it disagrees with the session.

An authenticated operator (admin) account is not itself a tenant: `requireShopSession` lets an operator act on a specific shop only by explicitly supplying `?shopId=`, and every such access is logged (`[ShopSession] operator access`).

## Authentication and trust boundary

`req.session.shopId` is the trust boundary for every per-shop endpoint. It is set in exactly three places, all in `establishShopSession()` (`src/middleware/shopSession.ts`), which first regenerates the session id (session-fixation defense) before writing `shopId`:

1. **OAuth install callback** — `GET /oauth/callback` (`src/routes/install.ts`), after a successful `authorization_code` exchange with Shoper for the shop.
2. **In-panel OAuth install** — the `action=install` branch of `GET /settings` (`src/routes/settings.ts`), the same exchange triggered from inside the Shoper admin panel.
3. **Signature-verified iframe entry** — the same `GET /settings` handler, further down: when Shoper opens the app's iframe from the shop panel it appends an HMAC-SHA512-signed `admin-hash` (or, on older shop versions, a legacy `hash`) over a fixed set of query parameters (see "Signature verification" below). If the signature verifies and Shoper's `shop` license has a previously-recorded mapping to a `shopId` (recorded during one of the two OAuth flows above), the session is established without a fresh OAuth round-trip. An unmapped or invalid signature leaves the request unauthenticated; it falls through to the existing reauthorize flow.

Separately, an **operator/admin account** (`src/repositories/userRepository.ts`, bcrypt-hashed password, SQLite `users` table) authenticates via `POST /auth/login` into `req.session.userId`/`isAuthenticated`. This is checked by `requireAuth`/`requireApiAuth` (`src/middleware/auth.ts`) and is a wholly separate mechanism from the shop session — it grants access to operator-only endpoints (e.g. `GET /settings/link/connections`, which lists every tenant) and, via `?shopId=`, the ability to inspect/act on any single shop.

## CSRF protection

State-changing shop-session endpoints (`PUT`/`POST`/`DELETE` under `/settings`, `/admin/idoxxy`, `/customers`) require a double-submit CSRF token: `requireCsrf` (`src/middleware/shopSession.ts`) compares an `X-CSRF-Token` request header against `req.session.csrfToken`, issued via `GET /settings/csrf`. This matters because the session cookie is `sameSite: "none"` in production (required for the app to work inside Shoper's third-party iframe), which would otherwise make every mutating endpoint reachable from a cross-site form or navigation; a cross-site request cannot read the session-scoped token to set the matching header.

## Cross-origin requests (no CORS middleware, by design)

There is no CORS middleware anywhere in this codebase (verified: no `cors` package dependency, no `Access-Control-*` header handling in `src/`). This is a deliberate choice, not an omission: the application's UI is only ever loaded same-origin, inside the Shoper admin iframe (`frame-ancestors`, see below) or directly at its own origin. With no CORS headers sent, browsers block a cross-origin page from reading any response from this API by default. State-changing endpoints add a second, independent layer: they require the `X-CSRF-Token` header described above, which a cross-site request has no way to set. Together these remove the need for an explicit CORS allow-list.

## Iframe embedding (clickjacking defense)

`helmet`'s own `Content-Security-Policy` is disabled (`contentSecurityPolicy: false`) in favor of a custom per-response middleware (`cspFrameAncestorsMiddleware`, `src/app.ts`) that sets `frame-ancestors` to the specific shop's known hosts (`shop_url` and `technical_url`, captured from Shoper's `/webapi/rest/application-config` during OAuth) once a verified shop session and both hosts are on record; otherwise it falls back to `frame-ancestors *`. It only ever narrows, never widens, and fails open to `*` rather than to a possibly-wrong host, so a merchant's iframe is never broken by an ambiguous case. `X-Frame-Options` is left disabled (`frameguard: false`) since it cannot express a per-shop allow-list and would otherwise fight with `frame-ancestors`.

## Signature verification

Two independent HMAC schemes protect the endpoints Shoper calls without a logged-in browser session, both implemented in `src/middleware/shoperSignature.ts` with constant-time comparison (`crypto.timingSafeEqual`):

- **Event webhooks** (`POST /webhooks/shoper/customer-created`, `/order-created`) — verified against `SHOPER_WEBHOOK_SECRET`. Two schemes are accepted, either of which is treated as valid: Shoper's documented `sha1(webhookId:secret:rawBody)` (headers `X-Webhook-Id`/`X-Webhook-SHA1`), and a legacy `HMAC-SHA256(rawBody)` fallback (headers `X-Shoper-Webhook-Signature`/`X-Shoper-Signature`) this app shipped with before the documented scheme was confirmed. A request with neither header, or a body that fails both, is rejected `401`.
- **App Store lifecycle/billing callbacks** (`POST /uninstall`, `POST /billing/subscription`, `POST /billing/automatic-messages`, and the `action=uninstall` query-based path on `GET /settings`) — verified against `SHOPER_APPSTORE_SECRET` using `HMAC-SHA512` over the alphabetically-sorted, `&`-joined `key=value` parameters (excluding `hash` itself), matched against the request's `hash` field. Shoper requires these endpoints to always answer `200`, so a failed signature check does not change any state but still returns `200` rather than an error status.
- **Signed iframe entry** (`GET /settings`) — the same sorted-params `HMAC-SHA512` construction, applied to Shoper's `admin-hash` (five fields, shop versions ≥ 5.8.14) or legacy `hash` (three fields, all versions) query parameters, plus a replay window that rejects a `timestamp` older than 5 minutes or more than 1 minute in the future.

Both `SHOPER_WEBHOOK_SECRET` and `SHOPER_APPSTORE_SECRET` are mandatory in production; the app refuses to start without them (see README's environment variable table) rather than silently accepting unsigned requests.

## Token encryption at rest

The iDoxxy workspace token and Shoper OAuth access/refresh tokens are stored encrypted with **AES-256-GCM** (`src/services/tokenCrypto.ts`), keyed by `TOKEN_ENCRYPTION_KEY` (base64, 32 bytes, mandatory in production). The stored format is self-describing (`iv:authTag:ciphertext`, each base64), and a tampered value fails GCM authentication rather than decrypting to garbage. Values written before this scheme existed (plain base64 of the token) are transparently detected and lazily re-encrypted on first read. If decryption fails (e.g. the key was rotated), the affected shop is marked `token_invalid` and the caller is routed through the existing reauthorize path instead of a `500`.

## Data retention and the uninstall purge policy

Two independent GDPR-driven purges run on a daily interval (`src/services/dataRetentionService.ts`, started once from `src/index.ts`, never from `createApp()` — the test suite calls `createApp()` many times and must not accumulate timers):

- **Sync log retention**: `sync_logs` rows (which include a merchant's customers' e-mail addresses) older than `SYNC_LOG_RETENTION_DAYS` (default **90** days) are deleted globally, regardless of shop or install status.
- **Post-uninstall purge**: on a verified `/uninstall` (or the signature-verified `action=uninstall` branch of `GET /settings`), the shop's iDoxxy/Shoper tokens are wiped **immediately** and the connection is marked `revoked`. `UNINSTALL_PURGE_GRACE_DAYS` (default **30** days) after that, the shop's remaining rows — the connection itself, plus `settings`, `event_mappings` and `sync_logs` — are permanently deleted, so a reinstall within the grace period can revive the existing configuration. Both day counts are validated as strictly positive integers (a `0` is rejected at startup, not treated as "delete immediately").

## Rate limiting

In-process, fixed-window rate limiting keyed by client IP (`src/middleware/rateLimit.ts`; a `Map`, no external dependency, swept hourly). `app.set("trust proxy", 1)` trusts exactly one upstream hop (Coolify/Traefik) for `req.ip`. This is process-local state — it resets on redeploy and is not shared across horizontally-scaled instances, an accepted trade-off at current scale.

| Limiter | Scope | Limit | On exceeded |
| --- | --- | --- | --- |
| `auth-login` | `POST /auth/login` | 10 requests / 15 min / IP | `429` |
| `webhooks` | `POST /webhooks/shoper/*` | 300 requests / min / IP | `429` |
| `appstore-callback` | `POST /uninstall`, `/billing/subscription`, `/billing/automatic-messages` | 600 requests / min / IP | `200 "OK"` (never `429` — Shoper requires `200` unconditionally on these and retries aggressively on non-200) |
| `settings-mutation` | Non-`GET` `/settings/*` | 120 requests / min / IP | `429` |

## Endpoints

Guard legend: **public** (no auth) · **shop session** (`requireShopSession`) · **shop session + CSRF** (also `requireCsrf`) · **operator login** (`requireAuth`/`requireApiAuth`, an admin account, not tenant-scoped).

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/health` | public |
| GET | `/` | public (redirects based on auth/query state) |
| GET | `/install` | public |
| GET | `/oauth/callback` | public (OAuth `code` exchange) |
| GET | `/settings` | public; may establish a shop session (OAuth install action or signed iframe entry) |
| GET | `/settings/csrf` | shop session |
| GET | `/settings/test-connection` | shop session |
| GET | `/settings/test-shoper` | operator login |
| GET | `/settings/config`, `/groups`, `/documents`, `/sync-logs`, `/sync-stats` | shop session |
| PUT | `/settings/credentials`, `/default-groups`, `/path-mappings` | shop session + CSRF |
| POST/DELETE | `/settings/mappings[/:id]` | shop session + CSRF |
| GET | `/settings/link/status/:shopId` | shop session (`:shopId` must match the session) |
| GET | `/settings/link/connections` | operator login |
| POST | `/settings/link/test`, `/settings/link` | shop session + CSRF |
| DELETE | `/settings/link/:shopId` | shop session + CSRF (`:shopId` must match the session) |
| GET/DELETE | `/settings/recent-installs[/:shopId]` | operator login |
| GET/PUT/POST | `/admin/idoxxy/settings*`, `/groups`, `/customers*`, `/documents/:id/resend-notification` | shop session (+ CSRF on mutations); calls the shop's live iDoxxy workspace |
| GET/PUT/POST | `/customers/:customerId/groups`, `/customers/groups/:groupId/customers/bulk` | shop session (+ CSRF on the bulk POST) |
| POST | `/uninstall`, `/billing/subscription`, `/billing/automatic-messages` | public + App Store `hash` signature, rate-limited, always `200` |
| POST | `/webhooks/shoper/customer-created`, `/order-created` | Shoper webhook signature, rate-limited |
| POST/GET | `/auth/login`, `/auth/logout`, `/auth/me` | public |
| POST | `/auth/change-password` | operator login |
| GET | `/admin/*` (static files) | operator login |

## Configuration

All configuration lives in SQLite, per shop: API credentials/base URLs, default (fallback) group ids, path mappings, and event mapping rules (Zod-validated on write). `sync_logs` holds the full audit trail of webhook-triggered synchronizations (timestamp, event, status, duration, groups assigned, mapping used, error details), queryable via `GET /settings/sync-logs` and `/settings/sync-stats`.

## Known open items

- The webhook signature scheme actually sent by Shoper is not yet confirmed against a live delivery (two schemes are accepted until this is settled — see `src/middleware/shoperSignature.ts` and `docs/shoper-test-readiness-audit.md`).
- The iframe-entry signature verification is built from a documented PHP reference but has not been independently re-verified against Shoper's live developer docs; the `timestamp` unit (seconds vs. milliseconds) is auto-detected rather than confirmed.

---

**Version**: 1.0.0
