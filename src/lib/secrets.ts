import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { getSettings } from "@/lib/settings";

/**
 * Integration secrets managed in the setup wizard. Stored AES-256-GCM encrypted
 * in the database; values are write-only from the UI (only the last 4 chars are
 * ever shown). Environment variables take precedence, so platforms that inject
 * secrets (Key Vault, etc.) keep working unchanged.
 *
 * Encryption key: SECRETS_ENCRYPTION_KEY (32-byte hex/base64) — the one value
 * that must be configured outside the app — or, if absent, an HKDF-derived key
 * from SESSION_SECRET (separate "info" label → independent key material).
 */
export const SECRET_NAMES = ["ANTHROPIC_API_KEY", "FIRECRAWL_API_KEY", "KVK_API_KEY", "BRAVE_SEARCH_API_KEY", "ENTRA_CLIENT_SECRET", "ROUTINE_FIRE_TOKEN"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

function key(): Buffer {
  const raw = process.env.SECRETS_ENCRYPTION_KEY;
  if (raw) {
    const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (k.length !== 32) throw new Error("SECRETS_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)");
    return k;
  }
  const base = process.env.SESSION_SECRET;
  if (!base) {
    if (process.env.NODE_ENV === "production") throw new Error("SECRETS_ENCRYPTION_KEY or SESSION_SECRET is required in production");
    return Buffer.from(hkdfSync("sha256", "dev-only-insecure", "cloud-life-sales-army", "secrets-v1", 32));
  }
  return Buffer.from(hkdfSync("sha256", base, "cloud-life-sales-army", "secrets-v1", 32));
}

export function encrypt(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return { ciphertext: ct.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") };
}
export function decrypt(row: { ciphertext: string; iv: string; tag: string }): string {
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(row.iv, "base64"));
  d.setAuthTag(Buffer.from(row.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(row.ciphertext, "base64")), d.final()]).toString("utf8");
}

const cache = new Map<string, { v: string | null; at: number }>();
export function clearSecretCache() {
  cache.clear();
}

/** Resolve a secret: environment first, then encrypted DB value. Cached 60 s. */
export async function getSecret(name: SecretName): Promise<string | null> {
  if (process.env[name]) return process.env[name]!;
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  let v: string | null = null;
  try {
    const [row] = await getDb().select().from(schema.secrets).where(eq(schema.secrets.key, name));
    v = row ? decrypt(row) : null;
  } catch (e) {
    console.error(`[secrets] cannot read ${name}`, e instanceof Error ? e.message : e);
    v = null;
  }
  cache.set(name, { v, at: Date.now() });
  return v;
}

export async function setSecret(name: SecretName, value: string, actor: string) {
  const v = value.trim();
  if (!v) throw new Error("Lege waarde");
  const enc = encrypt(v);
  await getDb()
    .insert(schema.secrets)
    .values({ key: name, ...enc, last4: v.slice(-4), updatedBy: actor, validationStatus: null, validationMessage: null })
    .onConflictDoUpdate({ target: schema.secrets.key, set: { ...enc, last4: v.slice(-4), updatedBy: actor, updatedAt: new Date(), validationStatus: null, validationMessage: null, validatedAt: null } });
  cache.delete(name);
}

export async function deleteSecret(name: SecretName) {
  await getDb().delete(schema.secrets).where(eq(schema.secrets.key, name));
  cache.delete(name);
}

export async function recordValidation(name: string, ok: boolean, message: string) {
  await getDb().update(schema.secrets).set({ validationStatus: ok ? "ok" : "failed", validationMessage: message.slice(0, 500), validatedAt: new Date() }).where(eq(schema.secrets.key, name));
}

/** Public metadata for the UI (never the value). */
export async function secretStatus() {
  const rows = await getDb().select({ key: schema.secrets.key, last4: schema.secrets.last4, updatedAt: schema.secrets.updatedAt, validatedAt: schema.secrets.validatedAt, validationStatus: schema.secrets.validationStatus, validationMessage: schema.secrets.validationMessage }).from(schema.secrets);
  return Object.fromEntries(
    SECRET_NAMES.map((n) => {
      const r = rows.find((x) => x.key === n);
      return [n, { source: process.env[n] ? "env" : r ? "database" : null, last4: process.env[n] ? process.env[n]!.slice(-4) : r?.last4 ?? null, updatedAt: r?.updatedAt ?? null, validatedAt: r?.validatedAt ?? null, validationStatus: r?.validationStatus ?? null, validationMessage: r?.validationMessage ?? null }];
    }),
  ) as Record<SecretName, { source: "env" | "database" | null; last4: string | null; updatedAt: Date | null; validatedAt: Date | null; validationStatus: string | null; validationMessage: string | null }>;
}

/** Entra configuration: env first, else wizard settings + stored secret. */
export async function entraConfig() {
  const s = await getSettings();
  const tenantId = process.env.ENTRA_TENANT_ID || s.integrations.entraTenantId || null;
  const clientId = process.env.ENTRA_CLIENT_ID || s.integrations.entraClientId || null;
  const clientSecret = await getSecret("ENTRA_CLIENT_SECRET");
  return {
    tenantId, clientId, clientSecret,
    adminGroupId: process.env.ENTRA_ADMIN_GROUP_ID || s.integrations.entraAdminGroupId || null,
    analystGroupId: process.env.ENTRA_ANALYST_GROUP_ID || s.integrations.entraAnalystGroupId || null,
    configured: Boolean(tenantId && clientId && clientSecret),
  };
}

export async function integrationStatus() {
  const [anthropic, firecrawl, kvk, brave, entra] = await Promise.all([getSecret("ANTHROPIC_API_KEY"), getSecret("FIRECRAWL_API_KEY"), getSecret("KVK_API_KEY"), getSecret("BRAVE_SEARCH_API_KEY"), entraConfig()]);
  return { anthropic: Boolean(anthropic), firecrawl: Boolean(firecrawl), kvk: Boolean(kvk), brave: Boolean(brave), entra: entra.configured, sessionSecret: Boolean(process.env.SESSION_SECRET) };
}
