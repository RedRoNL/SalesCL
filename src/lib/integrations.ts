import Anthropic from "@anthropic-ai/sdk";
import Firecrawl from "@mendable/firecrawl-js";
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { getSettings } from "@/lib/settings";
import { getSecret, recordValidation, entraConfig, type SecretName } from "@/lib/secrets";
import { HttpFetchProvider } from "@/research/http";
import { DohDnsProvider, SystemDnsProvider } from "@/research/dns";

export interface CheckResult {
  ok: boolean;
  message: string;
  checkedAt: string;
}
const now = () => new Date().toISOString();

async function storeCheck(key: string, r: CheckResult) {
  const db = getDb();
  const [row] = (await db.execute(sql`select value from system_settings where key = 'integration_checks'`)) as unknown as { value: Record<string, CheckResult> }[];
  const value = { ...(row?.value ?? {}), [key]: r };
  await db.insert(schema.systemSettings).values({ key: "integration_checks", value }).onConflictDoUpdate({ target: schema.systemSettings.key, set: { value, updatedAt: new Date() } });
  if (["ANTHROPIC_API_KEY", "FIRECRAWL_API_KEY", "KVK_API_KEY", "BRAVE_SEARCH_API_KEY", "ENTRA_CLIENT_SECRET"].includes(key)) await recordValidation(key, r.ok, r.message);
  return r;
}

export async function lastChecks(): Promise<Record<string, CheckResult>> {
  const [row] = (await getDb().execute(sql`select value from system_settings where key = 'integration_checks'`)) as unknown as { value: Record<string, CheckResult> }[];
  return row?.value ?? {};
}

const fail = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Each validator performs the cheapest possible real call (free where the API allows). */
export const validators: Record<string, () => Promise<CheckResult>> = {
  /** Format check only: firing the scheduled task would start a real session (use the explicit test button). */
  async ROUTINE_FIRE_TOKEN() {
    const t = await getSecret("ROUTINE_FIRE_TOKEN");
    if (!t) return { ok: false, message: "Niet ingesteld", checkedAt: now() };
    return /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/.test(t) ? { ok: true, message: "Formaat geldig (test met 'start scheduled task nu')", checkedAt: now() } : { ok: false, message: "Onverwacht formaat (verwacht sk-ant-oat01-…)", checkedAt: now() };
  },
  async ANTHROPIC_API_KEY() {
    const key = await getSecret("ANTHROPIC_API_KEY");
    if (!key) return { ok: false, message: "Niet ingesteld", checkedAt: now() };
    try {
      const page = await new Anthropic({ apiKey: key, maxRetries: 1, timeout: 15000 }).models.list({ limit: 50 });
      const ids = page.data.map((m) => m.id);
      const s = await getSettings();
      const missing = [s.models.fast, s.models.standard, s.models.strong].filter((m) => !ids.includes(m));
      return { ok: missing.length === 0, message: missing.length ? `Sleutel geldig, maar modellen niet beschikbaar: ${missing.join(", ")}` : `Geldig — ${ids.length} modellen beschikbaar (gratis Models-API-controle)`, checkedAt: now() };
    } catch (e) {
      return { ok: false, message: fail(e), checkedAt: now() };
    }
  },
  async FIRECRAWL_API_KEY() {
    const key = await getSecret("FIRECRAWL_API_KEY");
    if (!key) return { ok: false, message: "Niet ingesteld (optioneel)", checkedAt: now() };
    try {
      const u = await new Firecrawl({ apiKey: key, timeoutMs: 15000 }).getCreditUsage();
      return { ok: true, message: `Geldig — ${u.remainingCredits} credits resterend`, checkedAt: now() };
    } catch (e) {
      return { ok: false, message: fail(e), checkedAt: now() };
    }
  },
  async BRAVE_SEARCH_API_KEY() {
    const key = await getSecret("BRAVE_SEARCH_API_KEY");
    if (!key) return { ok: false, message: "Niet ingesteld (optioneel)", checkedAt: now() };
    try {
      const r = await fetch("https://api.search.brave.com/res/v1/web/search?q=kvk&count=1&country=nl", { headers: { "X-Subscription-Token": key }, signal: AbortSignal.timeout(15000) });
      return { ok: r.ok, message: r.ok ? "Geldig (1 testzoekopdracht ≈ €0,005)" : `Fout ${r.status}`, checkedAt: now() };
    } catch (e) {
      return { ok: false, message: fail(e), checkedAt: now() };
    }
  },
  async KVK_API_KEY() {
    const key = await getSecret("KVK_API_KEY");
    if (!key) return { ok: false, message: "Niet ingesteld (optioneel)", checkedAt: now() };
    try {
      // The Zoeken API is free of per-query charges.
      const r = await fetch("https://api.kvk.nl/api/v2/zoeken?naam=kamer%20van%20koophandel&resultatenPerPagina=1", { headers: { apikey: key }, signal: AbortSignal.timeout(15000) });
      return { ok: r.ok || r.status === 404, message: r.ok || r.status === 404 ? "Geldig (gratis Zoeken-API-controle)" : `Fout ${r.status}`, checkedAt: now() };
    } catch (e) {
      return { ok: false, message: fail(e), checkedAt: now() };
    }
  },
  async ENTRA_CLIENT_SECRET() {
    const e = await entraConfig();
    if (!e.tenantId || !e.clientId) return { ok: false, message: "Tenant-ID en client-ID ontbreken", checkedAt: now() };
    try {
      const d = await fetch(`https://login.microsoftonline.com/${e.tenantId}/v2.0/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) });
      if (!d.ok) return { ok: false, message: `Tenant niet gevonden (${d.status})`, checkedAt: now() };
      if (!e.clientSecret) return { ok: false, message: "Tenant gevonden; clientgeheim ontbreekt", checkedAt: now() };
      const t = await fetch(`https://login.microsoftonline.com/${e.tenantId}/oauth2/v2.0/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(10000),
        body: new URLSearchParams({ client_id: e.clientId, client_secret: e.clientSecret, grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }),
      });
      const j = (await t.json().catch(() => ({}))) as { error_description?: string };
      return { ok: t.ok, message: t.ok ? `Geldig — redirect-URI: ${env().APP_URL.replace(/\/$/, "")}/api/auth/callback` : (j.error_description ?? `Fout ${t.status}`).split("\r\n")[0], checkedAt: now() };
    } catch (err) {
      return { ok: false, message: fail(err), checkedAt: now() };
    }
  },
  async connectivity() {
    const s = await getSettings();
    try {
      const r = await new HttpFetchProvider(env().RESEARCH_USER_AGENT).fetch(s.integrations.connectivityTestUrl);
      const dns = await (s.research.dnsProvider === "doh" ? new DohDnsProvider(env().DOH_RESOLVER_URL) : new SystemDnsProvider()).snapshot("microsoft.com");
      const ok = r.page.text.length > 0 && dns.mx.length > 0;
      return { ok, message: ok ? `Web en DNS bereikbaar (${new URL(s.integrations.connectivityTestUrl).host}, MX microsoft.com)` : "DNS gaf geen resultaat — controleer uitgaand netwerk/DoH-resolver", checkedAt: now() };
    } catch (e) {
      return { ok: false, message: `Uitgaand webverkeer geblokkeerd of fout: ${fail(e)}`, checkedAt: now() };
    }
  },
};

export async function runCheck(key: string): Promise<CheckResult> {
  const v = validators[key];
  if (!v) throw new Error("Onbekende controle");
  return storeCheck(key, await v());
}

/** Worker liveness: the worker writes a heartbeat every minute. */
export async function workerStatus() {
  const [row] = (await getDb().execute(sql`select value, updated_at from system_settings where key = 'worker_heartbeat'`)) as unknown as { value: { at: string; schedule: string; pid: number; version: string }; updated_at: string }[];
  if (!row) return { alive: false, message: "Worker heeft zich nog nooit gemeld — start `npm run worker`", lastSeen: null, schedule: null };
  const age = (Date.now() - new Date(row.value.at).getTime()) / 1000;
  return { alive: age < 180, message: age < 180 ? `Actief (laatste signaal ${Math.round(age)} s geleden)` : `Geen signaal sinds ${Math.round(age / 60)} min — worker draait niet`, lastSeen: row.value.at, schedule: row.value.schedule };
}

export type { SecretName };
