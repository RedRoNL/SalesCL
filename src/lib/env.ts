import { z } from "zod";

/**
 * Server-side environment. Secrets are read only on the server and never
 * serialised to the client. Missing optional integrations degrade gracefully.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1).default("postgres://salesarmy:salesarmy@localhost:5432/salesarmy"),
  APP_URL: z.string().default("http://localhost:3000"),
  SESSION_SECRET: z.string().min(32).optional(),
  // Microsoft Entra ID (OIDC)
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  ENTRA_ADMIN_GROUP_ID: z.string().optional(),
  ENTRA_ANALYST_GROUP_ID: z.string().optional(),
  AUTH_DEV_LOGIN: z.enum(["true", "false"]).default("false"),
  /** Comma-separated e-mails that are always admin (bootstrap). */
  INITIAL_ADMIN_EMAILS: z.string().default(""),
  /** One-time token for the first administrator (setup wizard) before Entra ID is configured. */
  SETUP_TOKEN: z.string().optional(),
  SECRETS_ENCRYPTION_KEY: z.string().optional(),
  // AI
  ANTHROPIC_API_KEY: z.string().optional(),
  // Research providers
  FIRECRAWL_API_KEY: z.string().optional(),
  KVK_API_KEY: z.string().optional(),
  DOH_RESOLVER_URL: z.string().default("https://cloudflare-dns.com/dns-query"),
  RESEARCH_USER_AGENT: z.string().default("CloudLifeSalesArmyResearchBot/1.0 (+https://www.cloudlife.nl)"),
  // Worker
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
});

export type Env = z.infer<typeof EnvSchema>;
let cached: Env | undefined;

export function env(): Env {
  if (!cached) cached = EnvSchema.parse(process.env);
  return cached;
}

export function resetEnvCache() {
  cached = undefined;
}

/** @deprecated use integrationStatus() from @/lib/secrets (resolves env + encrypted DB secrets). */
export {};
