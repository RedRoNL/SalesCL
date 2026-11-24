import { sql, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { PAGE_SEEDS, QUERY_SEEDS } from "./seeds";

export interface SourceStat {
  id: string;
  kind: string;
  sourceType: string;
  name: string;
  url: string | null;
  query: string | null;
  industryCodes: string[];
  status: string;
  origin: string;
  harvestCount: number;
  lastHarvestedAt: string | null;
  reharvestDays: number;
  found: number;
  uniqueNew: number;
  qualified: number;
  delivered: number;
  appointments: number;
  /** 0..100 — Bayesian yield of qualified, unique companies, weighted by novelty. */
  priority: number;
}

export async function seedDiscoverySources() {
  const db = getDb();
  for (const s of [...PAGE_SEEDS, ...QUERY_SEEDS]) {
    await db.insert(schema.discoverySources).values({
      kind: s.kind, sourceType: s.sourceType, name: s.name, url: s.url ?? null, query: s.query ?? null, industryCodes: s.industries,
      region: s.region ?? null, reharvestDays: s.reharvestDays ?? 90, origin: "seed",
    }).onConflictDoNothing();
  }
}

/**
 * Yield statistics per source, computed from source_companies so they are always
 * consistent with the company records. Priority = (qualified+1)/(uniqueNew+4)
 * scaled, times a novelty factor (share of surfaced companies that were new).
 */
export async function sourceStats(ids?: string[]): Promise<SourceStat[]> {
  const rows = (await getDb().execute(sql`
    select s.id, s.kind, s.source_type as "sourceType", s.name, s.url, s.query, s.industry_codes as "industryCodes", s.status, s.origin,
      s.harvest_count as "harvestCount", s.last_harvested_at as "lastHarvestedAt", s.reharvest_days as "reharvestDays",
      count(sc.id)::int as found,
      count(sc.id) filter (where sc.was_new)::int as "uniqueNew",
      count(sc.id) filter (where sc.was_new and c.status in ('qualified','approved','exported'))::int as qualified,
      count(distinct d.company_id) filter (where sc.was_new)::int as delivered,
      count(distinct a.company_id) filter (where sc.was_new)::int as appointments
    from discovery_sources s
    left join source_companies sc on sc.source_id = s.id
    left join companies c on c.id = sc.company_id
    left join deliveries d on d.company_id = sc.company_id
    left join appointments a on a.company_id = sc.company_id
    ${ids?.length ? sql`where s.id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})` : sql``}
    group by s.id`)) as unknown as Omit<SourceStat, "priority">[];
  return rows.map((r) => {
    const novelty = r.found ? r.uniqueNew / r.found : 1;
    const yieldRate = (r.qualified + 1) / (r.uniqueNew + 4) + r.appointments * 0.05;
    return { ...r, priority: Math.round(Math.min(1, yieldRate * (0.4 + 0.6 * novelty)) * 100) };
  });
}

export interface HarvestPlan {
  sourceId: string;
  industry: string;
  exploration: boolean;
}

/**
 * Choose sources for an industry: exploit the highest-yield proven sources and
 * reserve an exploration share for unverified/new ones. Page sources respect
 * their re-harvest interval; query templates are deduplicated by the search cache.
 */
export function selectSources(stats: SourceStat[], industry: string, slots: number, explorationShare: number, now = Date.now()): HarvestPlan[] {
  const eligible = stats.filter((s) => {
    if (!["active", "unverified"].includes(s.status)) return false;
    if (s.industryCodes.length && !s.industryCodes.includes(industry)) return false;
    if (s.kind === "page" && s.lastHarvestedAt && now - new Date(s.lastHarvestedAt).getTime() < s.reharvestDays * 86400000) return false;
    return true;
  });
  const proven = eligible.filter((s) => s.harvestCount > 0).sort((a, b) => b.priority - a.priority);
  // Exploration: never-harvested sources; industry-specific before generic, agent/admin-found before seeds.
  const fresh = eligible.filter((s) => s.harvestCount === 0).sort((a, b) => Number(b.industryCodes.length > 0) - Number(a.industryCodes.length > 0) || Number(b.origin !== "seed") - Number(a.origin !== "seed"));
  const nExplore = Math.min(fresh.length, Math.max(proven.length ? Math.round(slots * explorationShare) : slots, 1));
  const chosen = [...fresh.slice(0, nExplore).map((s) => ({ s, e: true })), ...proven.slice(0, Math.max(0, slots - nExplore)).map((s) => ({ s, e: false }))];
  if (chosen.length < slots) for (const s of fresh.slice(nExplore)) if (chosen.length < slots) chosen.push({ s, e: true });
  return chosen.map(({ s, e }) => ({ sourceId: s.id, industry, exploration: e }));
}

export async function markSources(ids: string[], patch: Partial<typeof schema.discoverySources.$inferInsert>) {
  if (ids.length) await getDb().update(schema.discoverySources).set(patch).where(inArray(schema.discoverySources.id, ids));
}
