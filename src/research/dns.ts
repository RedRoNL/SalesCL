import { promises as dnsp } from "node:dns";
import type { DnsSnapshot } from "@/domain/msEvidence";
import type { DnsProvider } from "./types";

/**
 * Passive DNS lookups of publicly published records only (MX, TXT, CNAME).
 * This is not scanning: no ports are probed and no services are contacted.
 */
export const CNAME_LABELS = ["autodiscover", "enterpriseenrollment", "enterpriseregistration", "lyncdiscover", "selector1._domainkey", "selector2._domainkey", "msoid"];
export const SRV_LABELS = ["_sipfederationtls._tcp"];

export class SystemDnsProvider implements DnsProvider {
  readonly name = "system-dns";
  async snapshot(domain: string): Promise<DnsSnapshot> {
    const safe = async <T>(p: Promise<T>, fb: T) => p.catch(() => fb);
    const mx = (await safe(dnsp.resolveMx(domain), [])).sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
    const txt = (await safe(dnsp.resolveTxt(domain), [] as string[][])).map((c) => c.join(""));
    const cname: Record<string, string | null> = {};
    for (const l of CNAME_LABELS) cname[l] = (await safe(dnsp.resolveCname(`${l}.${domain}`), []))[0] ?? null;
    const srv: Record<string, string | null> = {};
    for (const l of SRV_LABELS) srv[l] = (await safe(dnsp.resolveSrv(`${l}.${domain}`), []))[0]?.name ?? null;
    return { domain, mx, txt, cname, srv };
  }
}

/** DNS-over-HTTPS (JSON API, RFC 8484-compatible resolvers such as Cloudflare/Google). */
export class DohDnsProvider implements DnsProvider {
  readonly name = "doh";
  constructor(private resolver: string, private fetchImpl: typeof fetch = fetch) {}
  private async q(name: string, type: string): Promise<string[]> {
    try {
      const r = await this.fetchImpl(`${this.resolver}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return [];
      const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
      const want = { MX: 15, TXT: 16, CNAME: 5, SRV: 33 }[type];
      return (j.Answer ?? []).filter((a) => a.type === want).map((a) => a.data);
    } catch {
      return [];
    }
  }
  async snapshot(domain: string): Promise<DnsSnapshot> {
    const mx = (await this.q(domain, "MX"))
      .map((d) => d.split(/\s+/))
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map((p) => p[1] ?? p[0]);
    const txt = (await this.q(domain, "TXT")).map((t) => t.replace(/^"|"$/g, "").replace(/"\s*"/g, ""));
    const cname: Record<string, string | null> = {};
    for (const l of CNAME_LABELS) cname[l] = (await this.q(`${l}.${domain}`, "CNAME"))[0] ?? null;
    const srv: Record<string, string | null> = {};
    for (const l of SRV_LABELS) srv[l] = (await this.q(`${l}.${domain}`, "SRV"))[0]?.split(/\s+/).pop() ?? null;
    return { domain, mx, txt, cname, srv };
  }
}

/**
 * Optional (Settings → integrations.tenantDiscovery, off by default): ask Microsoft's
 * public OpenID metadata endpoint whether a domain belongs to an Entra tenant.
 * One unauthenticated GET to login.microsoftonline.com; no traffic to the prospect,
 * no user enumeration, no authentication attempts.
 */
export async function lookupEntraTenant(domain: string, fetchImpl: typeof fetch = fetch): Promise<{ exists: boolean; tenantId: string | null }> {
  try {
    const r = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(domain)}/v2.0/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { exists: false, tenantId: null };
    const j = (await r.json()) as { issuer?: string };
    const m = j.issuer?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return { exists: Boolean(m), tenantId: m?.[0] ?? null };
  } catch {
    return { exists: false, tenantId: null };
  }
}
