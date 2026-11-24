import { and, eq, sql, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { getSettings } from "@/lib/settings";
import { BudgetExceededError } from "@/lib/budget";
import { canonicalDomain } from "@/domain/normalize";
import { runAgent } from "@/agents/runtime";
import { modelAvailable } from "@/agents/model";
import { AwaitingExecutor } from "@/agents/executor";
import * as S from "@/agents/schemas";
import type { AgentId } from "@/agents/types";
import { ResearchService, type FetchedSource } from "@/research/service";
import { NON_COMPANY_DOMAINS, quoteFound } from "@/research/extract";
import { FetchBlockedError } from "@/research/types";
import { registerCandidate, type CandidateInput } from "@/pipeline/candidates";
import { getRun, bumpStat, pauseRun, heartbeat } from "@/pipeline/runs";
import { getQueue, JOBS } from "@/pipeline/queue";
import { sourceStats } from "./sources";

const LIST_LINK_RE = /(leden|ledenlijst|lidbedrijven|onze-leden|members?\b|member-directory|exposanten|exhibitors?|standhouders|deelnemers|deelnemende|aangesloten|bedrijvengids|bedrijvenoverzicht|companies|directory|participants|portfolio|werkmaatschappijen|onze-bedrijven|ranking|top-?\d{2,3})/i;
const PAGINATION_RE = /([?&](page|pagina|p|pg)=\d+|\/page\/\d+|\/pagina\/\d+)/i;
const GENERIC_ANCHOR_RE = /^(website|www\.|https?:|lees meer|meer info(rmatie)?|bekijk|visit|klik( hier)?|homepage|read more|details|profiel|bezoek|link|ga naar|more|meer|contact|home)$/i;
const SOURCE_TYPE_TO_PAGE: Record<string, string> = { vacancy: "vacancy", ms_customer_reference: "ms_customer_story", partner_reference: "partner_reference", annual_report: "annual_report", procurement: "procurement" };

async function sectorName(code: string | null | undefined): Promise<string | null> {
  if (!code) return null;
  const [i] = await getDb().select().from(schema.industries).where(eq(schema.industries.code, code));
  return i?.nameNl.toLowerCase() ?? null;
}
async function industryIdOf(code: string | null | undefined) {
  if (!code) return null;
  const [i] = await getDb().select({ id: schema.industries.id }).from(schema.industries).where(eq(schema.industries.code, code));
  return i?.id ?? null;
}

/** Deterministic candidates: outbound links to company websites with a usable anchor text. */
/** Navigation/footer anchors that are never organisation names (seen in live harvests). */
const NAVIGATION_ANCHOR_RE = /^(©|\(c\)|copyright\b|ga naar\b|naar\b|lees (meer|verder)\b|bekijk\b|meer\b|klik\b|terug\b|volg ons\b|go to\b|read more\b|visit\b)|[»›→]|&[a-z]+;/i;
function decodeEntities(t: string) {
  return t.replace(/&(rsquo|lsquo|apos);/g, "'").replace(/&(rdquo|ldquo|quot);/g, '"').replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&raquo;/g, "»").replace(/&laquo;/g, "«").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function linkCandidates(page: Pick<FetchedSource, "url" | "links">): { name: string; website: string }[] {
  const own = canonicalDomain(page.url);
  const byDomain = new Map<string, { name: string; website: string }>();
  for (const l of page.links) {
    const d = canonicalDomain(l.href);
    if (!d || d === own || NON_COMPANY_DOMAINS.has(d) || [...NON_COMPANY_DOMAINS].some((x) => d.endsWith("." + x))) continue;
    const text = decodeEntities(l.text).replace(/\s+/g, " ").trim();
    const name = text && text.length >= 2 && text.length <= 80 && !GENERIC_ANCHOR_RE.test(text) && !NAVIGATION_ANCHOR_RE.test(text) && !/^https?:|\.(nl|com|eu)\b/i.test(text) ? text : null;
    if (!byDomain.has(d) || (name && !byDomain.get(d)!.name)) byDomain.set(d, { name: name ?? "", website: `https://${d}` });
  }
  return [...byDomain.values()].map((c) => ({ name: c.name || c.website.replace(/^https:\/\//, "").split(".")[0].replace(/-/g, " "), website: c.website }));
}

/** Cheap model extraction of named organisations; every name must literally occur on the page. */
async function llmCandidates(runId: string, page: FetchedSource, sourceType: string, industry: string | null, research: ResearchService) {
  if (!(await modelAvailable())) return [];
  const { output } = await runAgent<typeof S.ListExtractOutput>("market_intelligence_director", "extract_companies", {
    sourceType, industryName: industry, pageUrl: page.url, page: page.wrapped.slice(0, 14000),
  }, { runId, research });
  if (!output.isCompanyList) return [];
  return output.companies
    .filter((c) => quoteFound(page.text, c.name))
    .map((c) => ({ name: c.name, website: c.website && (quoteFound(page.text, c.website.replace(/^https?:\/\//, "").replace(/\/$/, "")) || page.links.some((l) => canonicalDomain(l.href) === canonicalDomain(c.website))) ? c.website : null, city: c.city, role: c.role }));
}

async function finishWork(workId: string, patch: Partial<typeof schema.runWork.$inferInsert>) {
  await getDb().update(schema.runWork).set({ ...patch, updatedAt: new Date() }).where(eq(schema.runWork.id, workId));
}

async function registerAll(runId: string, cands: (CandidateInput & { role?: string | null })[], sourcePriority: number) {
  const settings = await getSettings();
  const run = await getRun(runId);
  const maxCandidates = Math.min(settings.schedule.maxCandidatesPerRun, Math.ceil((run?.targetProspects ?? 100) * settings.schedule.candidateMultiplier * 1.6));
  const q = await getQueue();
  let created = 0;
  for (const c of cands) {
    const r = await registerCandidate(runId, { ...c, priority: sourcePriority }, maxCandidates);
    await bumpStat(runId, `discovery_${r.status}`);
    if (r.status === "capped") break;
    if (r.status === "new" || r.status === "reused") {
      created++;
      await q.send(JOBS.candidate, { runId, companyId: r.companyId }, { singletonKey: `${runId}:${r.companyId}`, priority: sourcePriority });
    }
  }
  return created;
}

/**
 * Harvest one discovery source for a run. Page sources: fetch the page, follow links to
 * member/exhibitor/ranking lists and pagination (same host, bounded), extract companies
 * deterministically from outbound links and — only when that yields little — with one cheap
 * model call per page. Query sources: run the search template for the industry and extract
 * organisations from the result pages (vacancies → employer; partner cases → customer).
 */
export async function harvestWork(runId: string, workId: string) {
  const db = getDb();
  const [work] = await db.select().from(schema.runWork).where(eq(schema.runWork.id, workId));
  if (!work || work.status !== "pending") return;
  const run = await getRun(runId);
  if (!run || run.status !== "running") return;
  const [src] = await db.select().from(schema.discoverySources).where(eq(schema.discoverySources.id, work.sourceId!));
  const settings = await getSettings();
  const industry = (work.params.industry as string) ?? null;
  const sector = await sectorName(industry);
  const industryId = await industryIdOf(industry);
  const research = await ResearchService.create({ runId });
  const [stat] = await sourceStats([src.id]);
  const priority = Math.max(10, Math.min(95, stat?.priority ?? 50));
  const cands: (CandidateInput & { role?: string | null })[] = [];
  let pages = 0;
  try {
    if (src.kind === "page" && src.url) {
      const first = await research.fetchPage(src.url, "association");
      const queue: string[] = [];
      const host = new URL(first.url).host;
      for (const l of first.links) {
        try {
          const u = new URL(l.href);
          if (u.host === host && (LIST_LINK_RE.test(u.pathname) || LIST_LINK_RE.test(l.text)) && !queue.includes(u.href)) queue.push(u.href);
        } catch {}
      }
      const visit: FetchedSource[] = [first];
      for (const url of queue.slice(0, settings.research.maxPagesPerSource - 1)) {
        try {
          const p = await research.fetchPage(url, "association");
          visit.push(p);
          for (const l of p.links) if (PAGINATION_RE.test(l.href) && new URL(l.href).host === host && !queue.includes(l.href) && queue.length < 40) queue.push(l.href);
        } catch {}
        if (visit.length >= settings.research.maxPagesPerSource) break;
      }
      for (const p of visit) {
        pages++;
        let found: { name: string; website: string | null; city?: string | null; role?: string }[] = linkCandidates(p);
        if (found.length < 8 && p.text.length > 400 && (p !== first || queue.length === 0)) found = [...found, ...(await llmCandidates(runId, p, src.sourceType, sector, research))];
        for (const f of found) cands.push({ name: f.name, website: f.website, city: f.city ?? null, sourceId: p.sourceId, discoveredBy: "market_intelligence_director", discoverySourceId: src.id, role: f.role ?? "listed", industryId });
      }
    } else if (src.kind === "query" && src.query) {
      const query = src.query.replace("{sector}", sector ?? "").replace("{regio}", src.region ?? "").replace(/\s+/g, " ").trim();
      if (!research.availability.search) {
        // No server-side search provider (Claude Subscription Mode default): the Claude Code session searches natively.
        const { output } = await runAgent<typeof S.DiscoveryOutput>("market_intelligence_director", "search_harvest", { query, sourceType: src.sourceType, industryName: sector }, { runId, research });
        const srcRows = output.candidates.map((c) => c.sourceId).filter(Boolean) as string[];
        const texts = new Map((srcRows.length ? await db.select().from(schema.researchSources).where(inArray(schema.researchSources.id, srcRows)) : []).map((r) => [r.id, r.excerpt ?? ""]));
        for (const c of output.candidates) {
          if (!c.sourceId || !texts.has(c.sourceId) || !quoteFound(texts.get(c.sourceId)!, c.name)) continue; // must occur on a retrieved page
          pages++;
          cands.push({ name: c.name, website: c.website, city: c.city, sourceId: c.sourceId, discoveredBy: "market_intelligence_director", discoverySourceId: src.id, role: "listed", industryId });
        }
      }
      const results = research.availability.search ? await research.search(query, 8) : [];
      for (const r of results.slice(0, 5)) {
        const d = canonicalDomain(r.url);
        if (!d || NON_COMPANY_DOMAINS.has(d)) continue;
        try {
          const p = await research.fetchPage(r.url, SOURCE_TYPE_TO_PAGE[src.sourceType] ?? "other");
          pages++;
          for (const f of await llmCandidates(runId, p, src.sourceType, sector, research))
            cands.push({ name: f.name, website: f.website ?? (f.role === "employer" ? `https://${d}` : null), city: f.city, sourceId: p.sourceId, discoveredBy: "market_intelligence_director", discoverySourceId: src.id, role: f.role, industryId });
        } catch {}
      }
    }
    const created = await registerAll(runId, cands, priority);
    const exhausted = src.kind === "page" && created === 0 && src.harvestCount > 0;
    await db.update(schema.discoverySources).set({
      harvestCount: sql`${schema.discoverySources.harvestCount} + 1`, pagesHarvested: sql`${schema.discoverySources.pagesHarvested} + ${pages}`, lastHarvestedAt: new Date(),
      status: exhausted ? "exhausted" : cands.length ? "active" : src.status === "unverified" ? "retired" : src.status, statusReason: cands.length ? null : "Geen organisaties gevonden op deze bron", lastError: null,
    }).where(eq(schema.discoverySources.id, src.id));
    await finishWork(workId, { status: "done", found: cands.length, newCandidates: created });
  } catch (e) {
    if (e instanceof AwaitingExecutor) return; // work unit stays pending until Claude Code submits
    if (e instanceof BudgetExceededError) {
      await pauseRun(runId, "system:budget", e.message);
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    // robots.txt / private-address refusals block a source; a DNS failure may be transient and is retried later.
    const blocked = e instanceof FetchBlockedError && !/niet resolvebaar/.test(msg);
    await db.update(schema.discoverySources).set({ lastError: msg.slice(0, 500), status: blocked ? "blocked" : src.status, statusReason: blocked ? msg.slice(0, 300) : src.statusReason, lastHarvestedAt: new Date() }).where(eq(schema.discoverySources.id, src.id));
    await finishWork(workId, { status: "failed", error: msg.slice(0, 1000), found: cands.length });
  }
}

/** Market Intelligence Director finds new sources for an under-covered industry; they are harvested in the same run. */
export async function scoutWork(runId: string, workId: string) {
  const db = getDb();
  const [work] = await db.select().from(schema.runWork).where(eq(schema.runWork.id, workId));
  if (!work || work.status !== "pending") return;
  const industry = work.params.industry as string;
  const sector = (await sectorName(industry)) ?? industry;
  try {
    const stats = (await sourceStats()).filter((s) => !s.industryCodes.length || s.industryCodes.includes(industry));
    const research = await ResearchService.create({ runId });
    const { output } = await runAgent<typeof S.ScoutOutput>("market_intelligence_director", "scout_sources", {
      industry, industryName: sector,
      existingSources: stats.slice(0, 80).map((s) => ({ name: s.name, url: s.url, query: s.query, type: s.sourceType, qualified: s.qualified, uniqueNew: s.uniqueNew })),
      wantedTypes: ["association", "trade_fair", "ranking", "business_park", "regional_network", "publication", "group_structure", "partner_reference"],
    }, { runId, research });
    const fetched = new Set((await db.select({ url: schema.researchSources.url }).from(schema.researchSources).where(eq(schema.researchSources.runId, runId))).map((r) => r.url));
    const added: string[] = [];
    for (const s of output.sources) {
      const d = s.url ? canonicalDomain(s.url) : null;
      if (s.url && (!d || NON_COMPANY_DOMAINS.has(d) || !fetched.has(s.url))) continue; // page sources must have been retrieved by the agent
      if (!s.url && !s.query) continue;
      const [row] = await db.insert(schema.discoverySources).values({ kind: s.url ? "page" : "query", sourceType: s.sourceType, name: s.name, url: s.url, query: s.url ? null : s.query, industryCodes: [industry], origin: "agent", statusReason: s.rationale.slice(0, 300) }).onConflictDoNothing().returning({ id: schema.discoverySources.id });
      if (row) added.push(row.id);
    }
    const q = await getQueue();
    for (const id of added.slice(0, 4)) {
      const [w] = await db.insert(schema.runWork).values({ runId, kind: "harvest", sourceId: id, params: { industry, exploration: true }, round: work.round }).returning();
      await q.send(JOBS.harvest, { runId, workId: w.id }, { singletonKey: w.id });
    }
    await finishWork(workId, { status: "done", found: output.sources.length, newCandidates: 0 });
  } catch (e) {
    if (e instanceof AwaitingExecutor) return;
    if (e instanceof BudgetExceededError) return void (await pauseRun(runId, "system:budget", e.message));
    await finishWork(workId, { status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 1000) });
  }
}

/** A hunter performs targeted discovery; the lists it used become permanent discovery sources. */
export async function huntWork(runId: string, workId: string) {
  const db = getDb();
  const [work] = await db.select().from(schema.runWork).where(eq(schema.runWork.id, workId));
  if (!work || work.status !== "pending") return;
  const agentId = work.params.agent as AgentId;
  const industry = work.params.industry as string;
  const sector = (await sectorName(industry)) ?? industry;
  const settings = await getSettings();
  const bands = { enterprise_hunter: settings.icp.enterpriseBand, midmarket_hunter: settings.icp.primaryBand, growth_market_hunter: settings.icp.growthBand } as Record<string, [number, number]>;
  try {
    const research = await ResearchService.create({ runId });
    const virtualQuery = `agent:${agentId}`;
    await db.insert(schema.discoverySources).values({ kind: "query", sourceType: "agent_research", name: `Agentonderzoek: ${agentId}`, query: virtualQuery, industryCodes: [], origin: "agent", status: "active" }).onConflictDoNothing();
    const [virtual] = await db.select().from(schema.discoverySources).where(eq(schema.discoverySources.query, virtualQuery));
    const prev = (await db.select({ q: schema.marketSegments.queriesUsed }).from(schema.marketSegments)).flatMap((r) => r.q ?? []).slice(-60);
    const { output } = await runAgent<typeof S.DiscoveryOutput>(agentId, "hunt", {
      industry, industryName: sector, sizeBand: bands[agentId] ?? settings.icp.primaryBand, quota: Number(work.params.quota ?? 20),
      searchThemes: (work.params.themes as string[]) ?? [], previousQueries: prev,
    }, { runId, research });
    const industryId = await industryIdOf(industry);
    const created = await registerAll(runId, output.candidates.map((c) => ({ ...c, discoveredBy: agentId, discoverySourceId: virtual.id, role: "listed", industryId })), 55);
    for (const p of output.poolsUsed) {
      if (!p.url || p.usefulness === "low") continue;
      const d = canonicalDomain(p.url);
      if (!d || NON_COMPANY_DOMAINS.has(d)) continue;
      await db.insert(schema.discoverySources).values({ kind: "page", sourceType: ["association", "trade_fair", "ranking", "directory", "publication"].includes(p.sourceType) ? p.sourceType : "directory", name: p.name, url: p.url, industryCodes: [industry], origin: "agent" }).onConflictDoNothing();
    }
    await db.insert(schema.marketSegments).values({ industryId, sizeBand: agentId, description: output.notes.slice(0, 1000), queriesUsed: output.queriesUsed, sourcesUsed: output.poolsUsed.map((p) => `${p.name}${p.url ? ` (${p.url})` : ""}`), candidatesFound: created, exhaustionEstimate: output.exhaustionEstimate, lastResearchedAt: new Date() });
    await finishWork(workId, { status: "done", found: output.candidates.length, newCandidates: created });
  } catch (e) {
    if (e instanceof AwaitingExecutor) return;
    if (e instanceof BudgetExceededError) return void (await pauseRun(runId, "system:budget", e.message));
    await finishWork(workId, { status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 1000) });
  }
}

export async function openWorkCount(runId: string) {
  const [r] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.runWork).where(and(eq(schema.runWork.runId, runId), eq(schema.runWork.status, "pending")));
  return r.n;
}

export { heartbeat };
