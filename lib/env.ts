import "server-only";
import { z } from "zod";

/**
 * Server-side environment. Validated lazily on first use so that `next build`
 * works without secrets, while any request that needs a missing variable fails
 * loudly with a clear message (never silently).
 */
const serverSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url("NEXT_PUBLIC_SUPABASE_URL must be a URL"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, "NEXT_PUBLIC_SUPABASE_ANON_KEY is required"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  INTEGRATION_API_KEY: z.string().optional(),
  N8N_CAS_PARSE_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  N8N_ADVISORY_PARSE_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  N8N_NOTIFICATION_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  N8N_WEBHOOK_TOKEN: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server environment: ${issues}. See .env.example.`);
  }
  cached = parsed.data;
  return cached;
}

export function requireServiceRoleKey(): string {
  const key = serverEnv().SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured (server-only). See README > Environment variables.");
  }
  return key;
}
