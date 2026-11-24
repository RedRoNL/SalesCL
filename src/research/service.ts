import { createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { getSettings, type Settings } from "@/lib/settings";
import { assertPaidProviderApproved, assertWithinBudget } from "@/lib/budget";
import { modelCostEur } from "@/lib/costs";
import { sanitizeUntrusted, wrapUntrusted } from "@/domain/untrusted";
import { canonicalDomain } from "@/domain/normalize";
import type { DnsSnapshot } from "@/domain/msEvidence";
import { getModelClient } from "@/agents/model";
import type { DnsProvider, FetchProvider, RegistryProvider, SearchProvider, SearchResult } from "./types";
import { ProviderUnavailableError } from "./types";
import { FirecrawlProvider } from "./firecrawl";
import { HttpFetchProvider } from "./http";
import { DohDnsProvider, SystemDnsProvider } from "./dns";
import { KvkProvider } from "./kvk";
import { AnthropicWebSearchProvider } from "./anthropicSearch";

export interface ResearchContext {
  runId?: string | null;
  agentTaskId?: string | null;
  agentId?: string | null;
  companyId?: string | null;
}

export interface Providers {
  search: SearchProvider | null;
  fetch: FetchProvider;
  dns: DnsProvider;
  registry: RegistryProvider | null;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Build providers from settings + env; missing credentials degrade gracefully. */
export function buildProviders(settings: Settings): Providers {
  const e = env();
  let search: SearchProvider | null = null;
  try {
    if (settings.research.searchProvider === "firecrawl") search = new FirecrawlProvider(e.FIRECRAWL_API_KEY);
  } catch {
    search = null;
  }
  if (!search && settings.research.searchProvider !== "none" && e.ANTHROPIC_API_KEY) {
    search = new AnthropicWebSearchProvider(getModelClient(), settings.models.fast);
  }
  let fetchP: FetchProvider = new HttpFetchProvider(e.RESEARCH_USER_AGENT);
  if (settings.research.fetchProvider === "firecrawl" && e.FIRECRAWL_API_KEY) fetchP = new FirecrawlProvider(e.FIRECRAWL_API_KEY);
  const dns = settings.research.dnsProvider === "doh" ? new DohDnsProvider(e.DOH_RESOLVER_URL) : new SystemDnsProvider();
  let registry: RegistryProvider | null = null;
  if (settings.research.registryProvider === "kvk" && e.KVK_API_KEY) registry = new KvkProvider(e.KVK_API_KEY);
  return { search, fetch: fetchP, dns, registry };
}

let providerOverride: Providers | null = null;
export function setProviders(p: Providers | null) {
  providerOverride = p;
}

/**
 * Research gateway used by all agents. Responsibilities:
 *  - provider selection & paid-provider approval
 *  - budget enforcement before paid calls
 *  - caching / research reuse (no paying twice for the same lookup)
 *  - politeness delay per host
 *  - provenance: every fetched page becomes a research_sources row
 *  - untrusted-content sanitisation before content reaches a model
 */
export class ResearchService {
  private lastHit = new Map<string, number>();
  private constructor(private providers: Providers, private settings: Settings, private ctx: ResearchContext) {}

  static async create(ctx: ResearchContext): Promise<ResearchService> {
    const settings = await getSettings();
    return new ResearchService(providerOverride ?? buildProviders(settings), settings, ctx);
  }

  withContext(ctx: Partial<ResearchContext>): ResearchService {
    const s = new ResearchService(this.providers, this.settings, { ...this.ctx, ...ctx });
    s.lastHit = this.lastHit;
    return s;
  }

  get availability() {
    return { search: this.providers.search?.name ?? null, fetch: this.providers.fetch.name, dns: this.providers.dns.name, registry: this.providers.registry?.name ?? null };
  }

  private async usage(provider: string, operation: string, units: number, eurPerUnit: number, cached: boolean) {
    await getDb().insert(schema.providerUsage).values({
      provider, operation, units, costEur: (cached ? 0 : units * eurPerUnit).toFixed(4), cached,
      runId: this.ctx.runId ?? null, agentTaskId: this.ctx.agentTaskId ?? null, agentId: this.ctx.agentId ?? null, companyId: this.ctx.companyId ?? null,
    });
  }

  private async cacheGet<T>(provider: string, key: string): Promise<T | null> {
    const [row] = await getDb()
      .select()
      .from(schema.researchCache)
      .where(and(eq(schema.researchCache.provider, provider), eq(schema.researchCache.cacheKey, key), gt(schema.researchCache.expiresAt, new Date())));
    return row ? (row.response as T) : null;
  }
  private async cachePut(provider: string, key: string, response: unknown) {
    const expiresAt = new Date(Date.now() + this.settings.research.cacheTtlDays * 86400000);
    await getDb()
      .insert(schema.researchCache)
      .values({ provider, cacheKey: key, response: response as object, expiresAt })
      .onConflictDoUpdate({ target: [schema.researchCache.provider, schema.researchCache.cacheKey], set: { response: response as object, expiresAt, createdAt: new Date() } });
  }

  private async politeness(host: string) {
    const last = this.lastHit.get(host) ?? 0;
    const wait = this.settings.research.requestDelayMs - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastHit.set(host, Date.now());
  }

  private eurPerUnit(provider: string): number {
    if (provider === "firecrawl") return this.settings.budget.firecrawlEurPerCredit;
    if (provider === "kvk") return this.settings.budget.kvkEurPerCall;
    return 0;
  }

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    const p = this.providers.search;
    if (!p) throw new ProviderUnavailableError("search", "geen zoekprovider geconfigureerd (FIRECRAWL_API_KEY of ANTHROPIC_API_KEY)");
    const key = sha(`${query.trim().toLowerCase()}|${limit}`);
    const cached = await this.cacheGet<SearchResult[]>(p.name, key);
    if (cached) {
      await this.usage(p.name, "search", 0, 0, true);
      return cached;
    }
    if (p.paid) {
      await assertPaidProviderApproved(p.name);
      await assertWithinBudget(this.ctx.runId);
    }
    let units = 0;
    let results: SearchResult[];
    if (p instanceof AnthropicWebSearchProvider) {
      // Usage of the search model is tracked as provider cost.
      const r = await new AnthropicWebSearchProvider(getModelClient(), this.settings.models.fast, async (msg) => {
        const eur = modelCostEur(this.settings.models.fast, msg.usage, this.settings.models.usdToEur);
        await getDb().insert(schema.providerUsage).values({ provider: p.name, operation: "search", units: 1, costEur: eur.toFixed(4), runId: this.ctx.runId ?? null, agentTaskId: this.ctx.agentTaskId ?? null, agentId: this.ctx.agentId ?? null });
      }).search(query, { limit });
      results = r.results;
    } else {
      const r = await p.search(query, { limit, country: "NL" });
      results = r.results;
      units = r.units;
      await this.usage(p.name, "search", units, this.eurPerUnit(p.name), false);
    }
    await this.cachePut(p.name, key, results);
    return results;
  }

  /**
   * Retrieve a page, store provenance, and return sanitised, wrapped content.
   * Reuses a recent stored source for the same URL instead of re-fetching.
   */
  async fetchPage(url: string, sourceType: string): Promise<{ sourceId: string; title: string | null; wrapped: string; excerpt: string; injectionFlags: string[] }> {
    const p = this.providers.fetch;
    const key = sha(url);
    let page = await this.cacheGet<{ finalUrl: string; status: number; title: string | null; text: string }>(p.name, key);
    const cached = Boolean(page);
    if (!page) {
      if (p.paid) {
        await assertPaidProviderApproved(p.name);
        await assertWithinBudget(this.ctx.runId);
      }
      const host = new URL(url).hostname;
      await this.politeness(host);
      const r = await p.fetch(url);
      page = { finalUrl: r.page.finalUrl, status: r.page.status, title: r.page.title, text: r.page.text };
      await this.cachePut(p.name, key, page);
      await this.usage(p.name, "fetch", r.units, this.eurPerUnit(p.name), false);
    } else {
      await this.usage(p.name, "fetch", 0, 0, true);
    }
    const sanitized = sanitizeUntrusted(page.text, 12000);
    // Store a bounded excerpt (data minimisation) — enough to verify quotes.
    const excerpt = sanitizeUntrusted(page.text, 6000).text;
    const [src] = await getDb()
      .insert(schema.researchSources)
      .values({
        companyId: this.ctx.companyId ?? null, url: page.finalUrl || url, title: page.title?.slice(0, 300) ?? null, sourceType,
        provider: cached ? `${p.name}:cache` : p.name, contentHash: sha(page.text), excerpt, httpStatus: page.status, runId: this.ctx.runId ?? null,
      })
      .returning({ id: schema.researchSources.id });
    return { sourceId: src.id, title: page.title, wrapped: wrapUntrusted({ kind: "web_page", url: page.finalUrl || url, sourceId: src.id }, sanitized), excerpt, injectionFlags: sanitized.injectionFlags };
  }

  /** Passive public DNS lookup for Microsoft infrastructure indicators. */
  async dns(domainInput: string): Promise<{ sourceId: string; snapshot: DnsSnapshot }> {
    const domain = canonicalDomain(domainInput);
    if (!domain) throw new Error(`Ongeldig domein: ${domainInput}`);
    const key = sha(domain);
    let snap = await this.cacheGet<DnsSnapshot>(this.providers.dns.name, key);
    if (!snap) {
      snap = await this.providers.dns.snapshot(domain);
      await this.cachePut(this.providers.dns.name, key, snap);
    }
    await this.usage(this.providers.dns.name, "dns", 1, 0, false);
    const summary = `MX: ${snap.mx.join(", ") || "-"}\nTXT: ${snap.txt.filter((t) => /^(v=spf1|ms=)/i.test(t)).join(" | ") || "-"}\nCNAME: ${Object.entries(snap.cname).map(([k, v]) => `${k}=${v ?? "-"}`).join(", ")}`;
    const [src] = await getDb()
      .insert(schema.researchSources)
      .values({ companyId: this.ctx.companyId ?? null, url: `dns:${domain}`, title: `DNS-records ${domain}`, sourceType: "dns", provider: this.providers.dns.name, contentHash: sha(summary), excerpt: summary, runId: this.ctx.runId ?? null })
      .returning({ id: schema.researchSources.id });
    return { sourceId: src.id, snapshot: snap };
  }

  async registry(q: { name?: string; kvkNumber?: string }) {
    const p = this.providers.registry;
    if (!p) throw new ProviderUnavailableError("registry", "KvK API niet geconfigureerd/goedgekeurd");
    const key = sha(JSON.stringify(q));
    const cached = await this.cacheGet<Awaited<ReturnType<RegistryProvider["search"]>>["records"]>(p.name, key);
    if (cached) return cached;
    await assertPaidProviderApproved(p.name);
    await assertWithinBudget(this.ctx.runId);
    const r = await p.search(q);
    await this.usage(p.name, "lookup", r.units, this.eurPerUnit(p.name), false);
    await this.cachePut(p.name, key, r.records);
    for (const rec of r.records) {
      await getDb().insert(schema.researchSources).values({
        companyId: this.ctx.companyId ?? null, url: `https://www.kvk.nl/zoeken/?source=all&q=${rec.kvkNumber}`, title: `KvK ${rec.kvkNumber} ${rec.name}`,
        sourceType: "registry", provider: p.name, excerpt: JSON.stringify(rec), runId: this.ctx.runId ?? null,
      });
    }
    return r.records;
  }
}
