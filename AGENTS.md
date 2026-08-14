# AGENTS.md - Shoper ↔ iDoxxy Integration Plugin

## Project Overview

Wtyczka serwerowa Node.js/TypeScript integrująca sklep Shoper z platformą iDoxxy (trwały nośnik). 
Automatyzuje synchronizację klientów, przypisywanie do grup i dostarczanie dokumentów przez webhooki.

**Target deployment:** Shoper.pl marketplace plugin

---

## Build Commands

```bash
# Install dependencies
npm install

# Development (hot reload with ts-node)
npm run dev

# Production build (TypeScript compilation)
npm run build

# Start production server (requires build first)
npm start

# Type checking only (no emit)
npx tsc --noEmit

# Check for outdated packages
npm outdated
```

**Note:** Test and lint commands are currently stubs in package.json:
- `npm run lint` - TODO: Add ESLint/Prettier
- `npm run test` - TODO: Add Jest/Vitest test framework

---

## Code Style Guidelines

### TypeScript Configuration

- **Target:** ES2020, CommonJS modules
- **Strict mode enabled** with additional strictness:
  - `noUncheckedIndexedAccess: true`
  - `exactOptionalPropertyTypes: true`
  - `strict: true`
- **Source maps** and declarations enabled for debugging

### Import Order

1. Node.js built-ins (`node:` prefix preferred)
2. Third-party dependencies (axios, express, zod, etc.)
3. Internal modules (absolute paths from src/)

Example:
```typescript
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { settingsRepository } from "../repositories/settingsRepository";
```

### Naming Conventions

- **Files:** kebab-case.ts (e.g., `idoxxy-client.ts`)
- **Classes:** PascalCase (e.g., `IdoxxyClient`)
- **Interfaces/Types:** PascalCase (e.g., `CustomerPayload`)
- **Variables:** camelCase
- **Constants:** UPPER_SNAKE_CASE for true constants
- **Environment variables:** UPPER_SNAKE_CASE

### Types & Validation

- Use **Zod** for all runtime validation
- Export inferred types: `export type MyType = z.infer<typeof mySchema>`
- Prefer explicit return types on public methods
- Use `type` over `interface` for object shapes

### Error Handling

- Wrap async operations in try-catch blocks
- Use discriminated error format: `{ ok: false, error: string }`
- Check `error instanceof Error` before accessing message
- Log errors with context (shopId, customerId when available)

Example:
```typescript
try {
  const result = await service.operation();
  return { ok: true, result };
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error("[Service] Operation failed", { shopId, error: message });
  return { ok: false, error: message };
}
```

### HTTP Responses

- Success: `res.json({ ok: true, ...data })`
- Validation error: `res.status(400).json({ ok: false, errors: parsed.error.issues })`
- Missing link: `res.status(428).json({ ok: false, error: "..." })`
- Server error: `res.status(500).json({ ok: false, error: message })`

### Repository Pattern

- Services hold business logic
- Repositories handle data access (currently in-memory)
- Clients manage external API communication

### Security

- Always validate webhook signatures when secret configured
- Use `crypto.timingSafeEqual` for signature comparison
- Sanitize sensitive data before returning (e.g., remove tokens from responses)
- Use Helmet for security headers

### Logging

- Prefix logs with module name: `[Idoxxy]`, `[Webhooks]`, etc.
- Include duration metrics for external API calls
- Avoid logging sensitive data (tokens, passwords)

### Language

- Code comments: English
- User-facing messages: Polish (this is for Polish marketplace)
- Error messages in Polish for consistency with Shoper ecosystem

---

## Project Structure

```
src/
├── clients/          # External API clients (Idoxxy, Shoper)
├── config/           # Environment validation (env.ts)
├── repositories/     # Data access layer (in-memory)
├── routes/           # Express route handlers
├── services/         # Business logic layer
├── types/            # TypeScript type definitions
├── app.ts            # Express app configuration
└── index.ts          # Entry point

public/               # Static HTML files (settings UI)
dist/                 # Compiled JavaScript (gitignored)
```

---

## Environment Variables

See `.env.example` for required variables. All validated via Zod in `src/config/env.ts`.

Key variables:
- `PORT` - Server port (default: 3000)
- `IDOXXY_API_KEY`, `IDOXXY_CLIENT_ID`, `IDOXXY_CLIENT_SECRET`
- `SHOPER_CLIENT_ID`, `SHOPER_CLIENT_SECRET`, `SHOPER_WEBHOOK_SECRET`

---

## Deployment Workflow

- **Auto-deployment:** Pushing changes to GitHub (`staging` branch) automatically triggers a deployment webhook on Coolify.
- **Rule:** Do NOT manually trigger deployments via Coolify API/MCP; pushing commits to GitHub is sufficient.

---

## Code Review Checklist

- [ ] All inputs validated with Zod schemas
- [ ] Proper error handling with meaningful messages
- [ ] No secrets logged or returned in responses
- [ ] Type safety maintained (no `any` types without justification)
- [ ] Async operations have proper error boundaries
- [ ] Webhook signature verification included
- [ ] Shop context properly resolved from headers/payload

