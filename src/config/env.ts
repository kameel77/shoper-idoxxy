import "dotenv/config";

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
  SESSION_SECRET: z.string().min(32).default("change-this-secret-in-production-to-at-least-32-characters"),
  // Email configuration
  EMAIL_PROVIDER: z.enum(["sendgrid", "smtp", "console"]).default("console"),
  SENDGRID_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional().transform((v) => v ? Number(v) : 587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().email().default("noreply@shoper-idoxxy.local"),
  EMAIL_FROM_NAME: z.string().default("Shoper Idoxxy Integration"),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);

export const isProduction = env.NODE_ENV === "production";

if (isProduction && env.SESSION_SECRET === "change-this-secret-in-production-to-at-least-32-characters") {
  throw new Error("W środowisku produkcyjnym wymagane jest podanie silnego SESSION_SECRET w zmiennych środowiskowych.");
}
