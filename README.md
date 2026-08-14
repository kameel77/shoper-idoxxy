# Shoper ↔ iDoxxy Integration (Node.js)

A Node.js/TypeScript Express server that integrates the Shoper e-commerce platform with the iDoxxy document-delivery platform. It runs as a Shoper App Store application: a merchant installs it, links their shop to an iDoxxy workspace, and the app synchronizes customers into iDoxxy groups (and can trigger document delivery) in response to Shoper webhooks.

## Requirements

- Node.js ≥ 20 (the Docker image builds on `node:20-alpine`; `better-sqlite3` is a native module compiled at install time)
- npm

## Install / build / run

```bash
npm install
npm run build   # tsc -> dist/
npm run dev     # ts-node src/index.ts, for local development
npm start       # node dist/index.js, requires a prior build
npm run lint     # eslint src/
npm test         # vitest run
npx tsc --noEmit # type-check only
```

The server listens on `PORT` (default `3000`).

## Persistence

All state is stored in a single SQLite database file via `better-sqlite3` (WAL mode), opened and migrated on module load in `src/config/database.ts`. There is no in-memory or external-database storage layer. Tables: `shop_connections`, `settings`, `event_mappings`, `sync_logs`, `users`, `sessions` (the last one backs the `express-session` store — see `src/services/sessionStore.ts`). The database path defaults to `./data/app.db` and is overridable with `DATABASE_PATH` (not Zod-validated; read directly from `process.env` in `src/config/database.ts`).

## Multi-tenancy

One Shoper shop = one tenant. Every per-shop table is keyed (or scoped) by `shop_id`, and every shop-scoped route resolves `req.shopId` exclusively from the verified session (`src/middleware/shopSession.ts`) — never from a client-supplied header, query or body field. See `app_description.md` for the trust model.

## Environment variables

Validated with Zod in `src/config/env.ts`. See `.env.example` for a fully commented copy.

### Mandatory in production (`NODE_ENV=production`)

The app throws at startup and refuses to listen if any of these are missing/invalid:

| Variable | Requirement |
| --- | --- |
| `SESSION_SECRET` | must not be the built-in placeholder; min 32 chars implied by the default replacement check |
| `ADMIN_PASSWORD` | ≥ 16 characters (bootstraps the operator/admin account) |
| `SHOPER_WEBHOOK_SECRET` | ≥ 32 characters (verifies `customer.created`/`order.created` webhook signatures) |
| `SHOPER_APPSTORE_SECRET` | must be present (verifies App Store `/uninstall` and `/billing/*` callback signatures, and the signed iframe-entry query params) |
| `TOKEN_ENCRYPTION_KEY` | base64, must decode to exactly 32 bytes (AES-256-GCM key for tokens at rest — generate with `openssl rand -base64 32`) |

Outside production, each of these falls back to a permissive dev default and logs a warning at startup instead of throwing.

### Optional (all environments)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `DATABASE_PATH` | `./data/app.db` | SQLite file location (not Zod-validated) |
| `ADMIN_USERNAME` | `admin` | Operator account username |
| `IDOXXY_API_KEY`, `IDOXXY_CLIENT_ID`, `IDOXXY_CLIENT_SECRET` | unset | iDoxxy platform credentials used by `src/clients/idoxxyClient.ts` |
| `IDOXXY_BASE_URL` | `https://api.idoxxy.com` | iDoxxy API base URL |
| `SHOPER_BASE_URL` | `https://example.shoper.pl/webapi/rest` | Default Shoper API base (per-shop calls use the shop's own resolved URL) |
| `SHOPER_CLIENT_ID`, `SHOPER_CLIENT_SECRET` | unset | Shoper OAuth app credentials used for the `authorization_code` exchange |
| `SHOPER_APP_STORE_CLIENT_ID` | unset | App Store client id, preferred over `SHOPER_CLIENT_ID` when both are set |
| `SYNC_LOG_RETENTION_DAYS` | `90` | Days `sync_logs` rows are kept before deletion (positive integer; `0` is rejected) |
| `UNINSTALL_PURGE_GRACE_DAYS` | `30` | Days after a verified uninstall before a shop's remaining data rows are purged (positive integer; `0` is rejected) |
| `EMAIL_PROVIDER` | `console` | `sendgrid` \| `smtp` \| `console` |
| `SENDGRID_API_KEY` | unset | Required if `EMAIL_PROVIDER=sendgrid` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | `SMTP_PORT` defaults to `587` | Required if `EMAIL_PROVIDER=smtp` |
| `EMAIL_FROM` | `noreply@shoper-idoxxy.local` | Sender address |
| `EMAIL_FROM_NAME` | `Shoper Idoxxy Integration` | Sender display name |

## Directory structure

```
src/
  app.ts                    # Express app assembly: middleware order, route mounts, CSP
  index.ts                  # Process entry point: starts the HTTP listener and the background schedulers
  config/
    env.ts                  # Zod-validated environment variables, production fail-fast checks
    database.ts             # SQLite connection, schema creation, in-place migrations
  clients/                  # HTTP clients for the Shoper and iDoxxy REST APIs
  services/                 # Business logic: token crypto, session store, data retention, shop connections, ...
  repositories/             # SQLite-backed data access (settings, shop connections, users, recent installs)
  routes/                   # Express routers (auth, install, settings, webhooks, customerGroups, idoxxyAdmin, adminIdoxxy)
  middleware/                # auth, shopSession (CSRF + shop-session trust boundary), shoperSignature, rateLimit, errorHandler, resolveShopClient
  types/                     # Shared TypeScript types
public/                     # Static HTML/JS for the settings UI and admin dashboard
tests/                      # vitest test suite (219 tests)
dist/                       # Compiled JS output (gitignored)
```

## Endpoints

Guard legend:
- **public** — no auth
- **shop session** — requires `req.session.shopId`, set only after a verified Shoper OAuth exchange or a signature-verified iframe entry (`requireShopSession`)
- **shop session + CSRF** — as above, plus a matching `X-CSRF-Token` header (`requireCsrf`, double-submit against `req.session.csrfToken`)
- **operator login** — requires an authenticated operator/admin account (`requireApiAuth`/`requireAuth`), not tied to any single shop

| Method | Path | Guard | Notes |
| --- | --- | --- | --- |
| GET | `/health` | public | Runs `SELECT 1` against SQLite |
| POST | `/auth/login` | public, rate-limited (10/15min/IP) | Operator login |
| POST | `/auth/logout` | public | |
| GET | `/auth/me` | public (reads session) | |
| POST | `/auth/change-password` | operator login | |
| GET | `/install` | public | Redirects to Shoper's OAuth authorize URL |
| GET | `/oauth/callback` | public, signature not applicable | Exchanges `code` for tokens; establishes the shop session on success |
| POST | `/uninstall` | public + App Store `hash` signature | Rate-limited, always answers `200` |
| POST | `/billing/subscription` | public + App Store `hash` signature | Rate-limited, always answers `200` |
| POST | `/billing/automatic-messages` | public + App Store `hash` signature | Rate-limited, always answers `200` |
| GET | `/settings` | public; may establish a shop session as a side effect | Handles the App Store `install`/`uninstall` query actions and the signed iframe-entry params, then serves the settings shell |
| GET | `/settings/csrf` | shop session | Issues/returns the CSRF token for the session |
| GET | `/settings/test-connection` | shop session | iDoxxy health check for the shop |
| GET | `/settings/test-shoper` | operator login | Checks the platform's own Shoper credentials, not a tenant's |
| GET | `/settings/config` | shop session | |
| GET | `/settings/groups` | shop session | |
| GET | `/settings/documents` | shop session | |
| PUT | `/settings/credentials` | shop session + CSRF, mutation rate-limited | |
| PUT | `/settings/default-groups` | shop session + CSRF, mutation rate-limited | |
| PUT | `/settings/path-mappings` | shop session + CSRF, mutation rate-limited | |
| POST | `/settings/mappings` | shop session + CSRF, mutation rate-limited | |
| DELETE | `/settings/mappings/:id` | shop session + CSRF, mutation rate-limited | |
| GET | `/settings/link/status/:shopId` | shop session | `:shopId` must match the session's shop |
| GET | `/settings/link/connections` | operator login | Lists every tenant's connection |
| POST | `/settings/link/test` | shop session + CSRF, mutation rate-limited | |
| POST | `/settings/link` | shop session + CSRF, mutation rate-limited | |
| DELETE | `/settings/link/:shopId` | shop session + CSRF, mutation rate-limited | `:shopId` must match the session's shop |
| GET | `/settings/sync-logs` | shop session | |
| GET | `/settings/sync-stats` | shop session | |
| GET | `/settings/recent-installs` | operator login | Platform-wide install feed, not per-shop |
| DELETE | `/settings/recent-installs/:shopId` | operator login | |
| GET/PUT | `/admin/idoxxy/settings*`, `/admin/idoxxy/groups`, `/admin/idoxxy/customers*`, `/admin/idoxxy/documents/:id/resend-notification` | shop session (+ CSRF on mutations) | Live calls into the shop's linked iDoxxy workspace via `resolveShopClient` |
| GET | `/admin` (static) | operator login | Serves `public/admin/*` |
| GET/POST | `/customers/:customerId/groups`, `/customers/groups/:groupId/customers/bulk` | shop session (+ CSRF on the bulk POST) | |
| POST | `/webhooks/shoper/customer-created` | Shoper webhook signature, rate-limited (300/min) | |
| POST | `/webhooks/shoper/order-created` | Shoper webhook signature, rate-limited (300/min) | |

Note: `src/routes/idoxxyAdmin.ts` and `src/routes/adminIdoxxy.ts` are both mounted at `/admin/idoxxy`, in that order. The former (real iDoxxy API calls) is mounted first and matches most of the overlapping paths; the latter (an in-memory demo dataset, unrelated to any real shop's data) only receives requests the former's router doesn't match, e.g. `GET /admin/idoxxy/customers/:id`.

## Currently open

- The event-webhook signature scheme is unconfirmed against a live delivery: `src/middleware/shoperSignature.ts` accepts either of two schemes (Shoper's documented `sha1(webhookId:secret:body)` or a legacy HMAC-SHA256-over-body) until a real webhook from a dev shop settles which one Shoper actually sends — see the doc comment there and `docs/shoper-test-readiness-audit.md`.
- The signed iframe-entry verification (`verifyIframeEntrySignature`) is built from a documented PHP reference but has not been independently re-verified against Shoper's live docs page (see the doc comment in `src/middleware/shoperSignature.ts`), and the `timestamp` unit (seconds vs. milliseconds) is auto-detected rather than confirmed.
- Rate limiting and the session-expiry sweep are in-process (a `Map`/SQLite sweep per Node process) and reset on redeploy; they are not shared across horizontally-scaled instances — an accepted trade-off at current scale, not a bug to fix silently.

## License

MIT (adjust per project needs).
