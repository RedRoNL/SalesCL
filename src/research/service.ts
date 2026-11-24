import { createHash } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { getSettings, type Settings } from "@/lib/settings";
import { getSecret } from "@/lib/secrets";
import { assertPaidProviderApproved, assertWithinBudget } from "@/lib/budget";
import { modelCostEur } from "@/lib/costs";
import { sanitizeUntrusted, wrapUntrusted } from "@/domain/untrusted";
import { canonicalDomain } from "@/domain/normalize";
import type { DnsSnapshot } from "@/domain/msEvidence";
import { getModelClient } from "@/agents/model";
import type { DnsProvider, FetchProvider, PageLink, RegistryProvider, SearchProvider, SearchResult } from "./types";
import { ProviderUnavailableError, ThinContentError } from "./types";
import { FirecrawlProvider } from "./firecrawl";
import { HttpFetchProvider } from "./http";
import { DohDnsProvider, SystemDnsProvider, lookupEntraTenant } from "./dns";
import { KvkProvider } from "./kvk";
import { BraveSearchProvider } from "./brave";
import { AnthropicWebSearchProvider } from "./anthropicSearch";
import { selectSubpages, type ExtractPage, type PageKind } from "./extract";

export interface ResearchContext {
  runId?: string | null;
  agentTaskId?: string | null;
  agentId?: string | null;
  companyId?: string | null;
}

export interface Providers {
  search: SearchProvider | null;
  fetch: FetchProvider;
  /** Optional JS-rendering fallback (Firecrawl) — used only on ThinContentError. */
  render?: FetchProvider | null;
  dns: DnsProvider;
  registry: RegistryProvider | null;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// Process-wide provider singletons (robots.txt cache, HTTP keep-alive) keyed by configuration.
let providerCache: { sig: string; p: Providers } | null = null;

/** Build providers from settings + secrets; missing credentials degrade gracefully. */
export async function buildProviders(settings: Settings): Promise<Providers> {
  const e = env();
  const [anthropic, firecrawl, brave, kvk] = await Promise.all([getSecret("ANTHROPIC_API_KEY"), getSecret("FIRECRAWL_API_KEY"), getSecret("BRAVE_SEARCH_API_KEY"), getSecret("KVK_API_KEY")]);
  const r = settings.research;
  const sig = JSON.stringify([settings.execution.mode, settings.execution.paidApiApproved, r.searchProvider, r.fetchProvider, r.dnsProvider, r.registryProvider, r.firecrawlRenderFallback, settings.models.fast, Boolean(anthropic), firecrawl?.slice(-6), brave?.slice(-6), kvk?.slice(-6)]);
  if (providerCache?.sig === sig) return providerCache.p;

  let search: SearchProvider | null = null;
  try {
    if (r.searchProvider === "firecrawl") search = new FirecrawlProvider(firecrawl ?? undefined);
    else if (r.searchProvider === "brave") search = new BraveSearchProvider(brave);
    else if (r.searchProvider === "anthropic_web_search" && anthropic) search = new AnthropicWebSearchProvider(await getModelClient(), settings.models.fast);
  } catch {
    search = null;
  }
  const http = new HttpFetchProvider(e.RESEARCH_USER_AGENT);
  let fetchP: FetchProvider = http;
  let render: FetchProvider | null = null;
  if (firecrawl) {
    if (r.fetchProvider === "firecrawl") fetchP = new FirecrawlProvider(firecrawl);
    else if (r.firecrawlRenderFallback) render = new FirecrawlProvider(firecrawl);
  }
  const dns = r.dnsProvider === "doh" ? new DohDnsProvider(e.DOH_RESOLVER_URL) : new SystemDnsProvider();
  const registry = r.registryProvider === "kvk" && kvk ? new KvkProvider(kvk) : null;
  const p = { search, fetch: fetchP, render, dns, registry };
  providerCache = { sig, p };
  return p;
}

let providerOverride: Providers | null = null;
export function setProviders(p: Providers | null) {
  providerOverride = p;
  providerCache = null;
}

export interface FetchedSource {
  sourceId: string;
  url: string;
  title: string | null;
  wrapped: string;
  excerpt: string;
  text: string;
  links: PageLink[];
  injectionFlags: string[];
  cached: boolean;
}

/**
 * Research gateway used by the pipeline and all agents:
 *  - provider selection & paid-provider approval, budget enforcement
 *  - caching / reuse: identical lookups are never paid twice; a cached page reuses
 *    the existing source row for the same company instead of creating duplicates
 *  - politeness delay per host; robots.txt cached per process
 *  - provenance: every retrieval is a research_sources row
 *  - untrusted-content sanitisation before content reaches a model
 */
export class ResearchService {
  private lastHit = new Map<string, number>();
  private constructor(private providers: Providers, private settings: Settings, private ctx: ResearchContext) {}

  static async create(ctx: ResearchContext): Promise<ResearchService> {
    const settings = await getSettings();
    return new ResearchService(providerOverride ?? (await buildProviders(settings)), settings, ctx);
  }

  withContext(ctx: Partial<ResearchContext>): ResearchService {
    const s = new ResearchService(this.providers, this.settings, { ...this.ctx, ...ctx });
    s.lastHit = this.lastHit;
    return s;
  }

  get availability() {
    return { search: this.providers.search?.name ?? null, fetch: this.providers.fetch.name, render: this.providers.render?.name ?? null, dns: this.providers.dns.name, registry: this.providers.registry?.name ?? null };
  }

  private async usage(provider: string, operation: string, units: number, eurPerUnit: number, cached: boolean, eurOverride?: number) {
    await getDb().insert(schema.providerUsage).values({
      provider, operation, units, costEur: (cached ? 0 : eurOverride ?? units * eurPerUnit).toFixed(4), cached,
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
  private async cachePut(provider: string, key: string, response: unknown, ttlDays = this.settings.research.cacheTtlDays) {
    const expiresAt = new Date(Date.now() + ttlDays * 86400000);
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
    if (provider === "brave") return this.settings.budget.braveEurPerQuery;
    return 0;
  }

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    const p = this.providers.search;
    if (!p) throw new ProviderUnavailableError("search", "geen zoekprovider geconfigureerd (Setup → Onderzoeksproviders)");
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
    let results: SearchResult[];
    if (p instanceof AnthropicWebSearchProvider) {
      const model = this.settings.models.fast;
      const r = await new AnthropicWebSearchProvider(await getModelClient(), model, async (msg) => {
        await this.usage(p.name, "search", 1, 0, false, modelCostEur(model, msg.usage, this.settings.models.usdToEur));
      }).search(query, { limit });
      results = r.results;
    } else {
      const r = await p.search(query, { limit, country: "NL" });
      results = r.results;
      await this.usage(p.name, "search", r.units, this.eurPerUnit(p.name), false);
    }
    await this.cachePut(p.name, key, results, 14);
    return results;
  }

  private async retrieve(url: string): Promise<{ finalUrl: string; status: number; title: string | null; text: string; links: PageLink[]; provider: string; cached: boolean }> {
    const p = this.providers.fetch;
    const key = sha(url);
    const hit = await this.cacheGet<{ finalUrl: string; status: number; title: string | null; text: string; links?: PageLink[]; provider?: string }>("page", key);
    if (hit) return { ...hit, links: hit.links ?? [], provider: hit.provider ?? p.name, cached: true };
    const host = new URL(url).hostname;
    await this.politeness(host);
    let provider = p;
    let res;
    try {
      if (p.paid) {
        await assertPaidProviderApproved(p.name);
        await assertWithinBudget(this.ctx.runId);
      }
      res = await p.fetch(url);
    } catch (e) {
      // Rendering fallback only for JavaScript-only pages — never for access denials or bot challenges.
      if (!(e instanceof ThinContentError) || !this.providers.render) throw e;
      provider = this.providers.render;
      await assertPaidProviderApproved(provider.name);
      await assertWithinBudget(this.ctx.runId);
      res = await provider.fetch(url);
    }
    const page = { finalUrl: res.page.finalUrl, status: res.page.status, title: res.page.title, text: res.page.text, links: res.page.links ?? [], provider: provider.name };
    await this.cachePut("page", key, page);
    await this.usage(provider.name, "fetch", res.units, this.eurPerUnit(provider.name), false);
    return { ...page, cached: false };
  }

  /**
   * Retrieve a page, store provenance (reusing the existing source row for the same
   * company+URL+content), and return sanitised, wrapped content plus links.
   */
  async fetchPage(url: string, sourceType: string): Promise<FetchedSource> {
    const page = await this.retrieve(url);
    if (page.cached) await this.usage(page.provider, "fetch", 0, 0, true);
    const sanitized = sanitizeUntrusted(page.text, 12000);
    // The stored excerpt must be exactly what the agent was shown, otherwise correct quotes from the second half of a
    // page fail verification and sourced facts are silently dropped (live-pilot finding). Still bounded (12k chars).
    const excerpt = sanitized.text;
    const hash = sha(page.text);
    const finalUrl = page.finalUrl || url;
    const db = getDb();
    const [existing] = await db
      .select({ id: schema.researchSources.id })
      .from(schema.researchSources)
      .where(and(eq(schema.researchSources.url, finalUrl), eq(schema.researchSources.contentHash, hash), this.ctx.companyId ? eq(schema.researchSources.companyId, this.ctx.companyId) : isNull(schema.researchSources.companyId)))
      .limit(1);
    let sourceId = existing?.id;
    if (!sourceId) {
      const [src] = await db
        .insert(schema.researchSources)
        .values({ companyId: this.ctx.companyId ?? null, url: finalUrl, title: page.title?.slice(0, 300) ?? null, sourceType, provider: page.cached ? `${page.provider}:cache` : page.provider, contentHash: hash, excerpt, httpStatus: page.status, runId: this.ctx.runId ?? null })
        .returning({ id: schema.researchSources.id });
      sourceId = src.id;
    }
    return { sourceId, url: finalUrl, title: page.title, wrapped: wrapUntrusted({ kind: "web_page", url: finalUrl, sourceId }, sanitized), excerpt, text: sanitized.text, links: page.links, injectionFlags: sanitized.injectionFlags, cached: page.cached };
  }

  /**
   * Free screening crawl: homepage + up to N relevant subpages (contact, about,
   * legal/colophon, careers, news) on the company's own site.
   */
  async crawlSite(website: string, maxPages = this.settings.research.screenPages): Promise<ExtractPage[]> {
    const home = await this.fetchPage(website, "official_site");
    const pages: ExtractPage[] = [{ sourceId: home.sourceId, url: home.url, kind: "home", text: home.text }];
    for (const sp of selectSubpages(home.url, home.links, maxPages - 1)) {
      try {
        const f = await this.fetchPage(sp.url, sp.kind === "careers" ? "vacancy" : "official_site");
        pages.push({ sourceId: f.sourceId, url: f.url, kind: sp.kind as PageKind, text: f.text });
      } catch {
        /* a missing subpage is not fatal */
      }
    }
    return pages;
  }

  /** Passive public DNS lookup (+ optional Entra tenant metadata) for Microsoft indicators. */
  async dns(domainInput: string): Promise<{ sourceId: string; snapshot: DnsSnapshot }> {
    const domain = canonicalDomain(domainInput);
    if (!domain) throw new Error(`Ongeldig domein: ${domainInput}`);
    const key = sha(`${domain}|${this.settings.integrations.tenantDiscovery}`);
    let snap = await this.cacheGet<DnsSnapshot>(this.providers.dns.name, key);
    if (!snap) {
      snap = await this.providers.dns.snapshot(domain);
      if (this.settings.integrations.tenantDiscovery) snap.tenant = await lookupEntraTenant(domain);
      await this.cachePut(this.providers.dns.name, key, snap, 30);
    }
    await this.usage(this.providers.dns.name, "dns", 1, 0, false);
    const summary = `MX: ${snap.mx.join(", ") || "-"}\nTXT: ${snap.txt.filter((t) => /^(v=spf1|ms=)/i.test(t)).join(" | ") || "-"}\nCNAME: ${Object.entries(snap.cname).map(([k, v]) => `${k}=${v ?? "-"}`).join(", ")}\nSRV: ${Object.entries(snap.srv ?? {}).map(([k, v]) => `${k}=${v ?? "-"}`).join(", ") || "-"}${snap.tenant ? `\nEntra-tenant: ${snap.tenant.exists ? "ja" : "nee"}` : ""}`;
    const db = getDb();
    const [existing] = await db
      .select({ id: schema.researchSources.id })
      .from(schema.researchSources)
      .where(and(eq(schema.researchSources.url, `dns:${domain}`), eq(schema.researchSources.contentHash, sha(summary)), or(this.ctx.companyId ? eq(schema.researchSources.companyId, this.ctx.companyId) : isNull(schema.researchSources.companyId))))
      .limit(1);
    if (existing) return { sourceId: existing.id, snapshot: snap };
    const [src] = await db
      .insert(schema.researchSources)
      .values({ companyId: this.ctx.companyId ?? null, url: `dns:${domain}`, title: `DNS-records ${domain}`, sourceType: "dns", provider: this.providers.dns.name, contentHash: sha(summary), excerpt: summary, runId: this.ctx.runId ?? null })
      .returning({ id: schema.researchSources.id });
    return { sourceId: src.id, snapshot: snap };
  }

  get registryAvailable() {
    return Boolean(this.providers.registry);
  }

  async registry(q: { name?: string; kvkNumber?: string }) {
    const p = this.providers.registry;
    if (!p) throw new ProviderUnavailableError("registry", "KvK API niet geconfigureerd/goedgekeurd");
    const key = sha(JSON.stringify(q));
    const cached = await this.cacheGet<Awaited<ReturnType<RegistryProvider["search"]>>["records"]>(p.name, key);
    let records = cached;
    if (!records) {
      await assertPaidProviderApproved(p.name);
      await assertWithinBudget(this.ctx.runId);
      const r = await p.search(q);
      await this.usage(p.name, "lookup", r.units, this.eurPerUnit(p.name), false);
      await this.cachePut(p.name, key, r.records, 180);
      records = r.records;
    }
    const out: (typeof records[number] & { sourceId: string })[] = [];
    for (const rec of records) {
      const [row] = await getDb().insert(schema.researchSources).values({
        companyId: this.ctx.companyId ?? null, url: `https://www.kvk.nl/zoeken/?source=all&q=${rec.kvkNumber}`, title: `KvK ${rec.kvkNumber} ${rec.name}`,
        sourceType: "registry", provider: p.name, excerpt: JSON.stringify(rec), contentHash: sha(JSON.stringify(rec)), runId: this.ctx.runId ?? null,
      }).returning({ id: schema.researchSources.id });
      out.push({ ...rec, sourceId: row.id });
    }
    return out;
  }
}
