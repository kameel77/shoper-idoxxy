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
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);

export const isProduction = env.NODE_ENV === "production";
