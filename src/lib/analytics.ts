import { sql, eq, desc, and, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { sizeBand, employeeEstimate } from "@/domain/normalize";
import { wilson, twoProportionPValue, evidenceStrength, type EvidenceStrength } from "@/domain/stats";
import { getSettings } from "@/lib/settings";
import { startOfWeekAmsterdam } from "@/lib/budget";

/** Outcomes counted as commercial success ("appointment generated"). */
export const SUCCESS_OUTCOMES = new Set(["appointment_scheduled", "qualified_opportunity", "converted_to_customer"]);
export const CONTACTED_EXCLUDE = new Set(["not_yet_called"]);

export interface GroupStat {
  key: string;
  n: number;
  successes: number;
  rate: number;
  ciLow: number;
  ciHigh: number;
  pValue: number;
  strength: EvidenceStrength;
}

interface OutcomeRow {
  companyId: string;
  outcome: string;
  industry: string | null;
  employees: number | null;
  fitScore: number | null;
  service: string | null;
}

/** Latest non-superseded calling outcome per delivered company, with attributes. */
async function outcomeRows(): Promise<OutcomeRow[]> {
  const db = getDb();
  const rows = await db.execute(sql`
    select distinct on (cr.company_id) cr.company_id as "companyId", cr.outcome::text as outcome,
      i.code as industry, coalesce(c.employee_count, (c.employee_min + c.employee_max) / 2, c.employee_min) as employees,
      c.fit_score as "fitScore", c.recommended_service as service
    from calling_results cr
    join companies c on c.id = cr.company_id
    left join industries i on i.id = c.industry_id
    where cr.superseded_by_id is null
    order by cr.company_id, coalesce(cr.called_at, cr.created_at) desc
  `);
  return rows as unknown as OutcomeRow[];
}

function groupStats(rows: { key: string; success: boolean }[], minInd: number, minSig: number): GroupStat[] {
  const total = rows.length;
  const totalS = rows.filter((r) => r.success).length;
  const groups = new Map<string, { n: number; s: number }>();
  for (const r of rows) {
    const g = groups.get(r.key) ?? { n: 0, s: 0 };
    g.n++;
    if (r.success) g.s++;
    groups.set(r.key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => {
      const w = wilson(g.s, g.n);
      const p = twoProportionPValue(g.s, g.n, totalS - g.s, total - g.n);
      return { key, n: g.n, successes: g.s, rate: w.p, ciLow: w.low, ciHigh: w.high, pValue: p, strength: evidenceStrength(g.n, p, minInd, minSig) };
    })
    .sort((a, b) => b.n - a.n);
}

const scoreBand = (s: number | null) => (s == null ? "onbekend" : s >= 85 ? "85-100" : s >= 70 ? "70-84" : s >= 55 ? "55-69" : "<55");

export async function commercialPerformance() {
  const settings = await getSettings();
  const { minSampleForIndicative: mi, minSampleForSignificant: ms } = settings.learning;
  const db = getDb();
  const all = await outcomeRows();
  const called = all.filter((r) => !CONTACTED_EXCLUDE.has(r.outcome));
  const success = (r: OutcomeRow) => SUCCESS_OUTCOMES.has(r.outcome);

  const signalRows = (await db.execute(sql`select company_id as "companyId", array_agg(distinct signal_type) as types from buying_signals group by company_id`)) as unknown as { companyId: string; types: string[] }[];
  const sigMap = new Map(signalRows.map((r) => [r.companyId, r.types]));
  const techRows = (await db.execute(sql`
    select company_id as "companyId",
      max(case classification when 'confirmed' then 3 when 'strongly_indicated' then 2 when 'weakly_indicated' then 1 else 0 end) as best
    from technology_evidence where technology in ('microsoft_365','exchange_online') group by company_id`)) as unknown as { companyId: string; best: number }[];
  const techMap = new Map(techRows.map((r) => [r.companyId, Number(r.best)]));
  const techLabel = (n: number | undefined) => ["geen/onbekend", "zwak", "sterk", "bevestigd"][n ?? 0];

  const bySignal: { key: string; success: boolean }[] = [];
  for (const r of called) {
    const types = sigMap.get(r.companyId);
    if (!types?.length) bySignal.push({ key: "geen_signaal", success: success(r) });
    else for (const t of types) bySignal.push({ key: t, success: success(r) });
  }

  const outcomeDist = new Map<string, number>();
  for (const r of all) outcomeDist.set(r.outcome, (outcomeDist.get(r.outcome) ?? 0) + 1);

  const [pipeline] = (await db.execute(sql`
    select coalesce(sum(estimated_mrr_eur) filter (where stage = 'open'), 0)::float as "estimatedOpenMrr",
           (select coalesce(sum(contracted_mrr_eur), 0)::float from conversions) as "contractedMrr",
           (select count(*)::int from conversions) as conversions
    from opportunities`)) as unknown as { estimatedOpenMrr: number; contractedMrr: number; conversions: number }[];

  const totalSuccess = called.filter(success).length;
  return {
    generatedAt: new Date().toISOString(),
    method: "Laatste niet-vervangen belresultaat per geleverd bedrijf. Succes = afspraak, gekwalificeerde kans of klant. Wilson 95%-interval; p-waarde: twee-proporties z-toets groep vs. rest.",
    totals: { delivered: all.length, called: called.length, successes: totalSuccess, rate: called.length ? totalSuccess / called.length : 0, ci: wilson(totalSuccess, called.length) },
    byIndustry: groupStats(called.map((r) => ({ key: r.industry ?? "onbekend", success: success(r) })), mi, ms),
    bySize: groupStats(called.map((r) => ({ key: sizeBand(r.employees), success: success(r) })), mi, ms),
    byScoreBand: groupStats(called.map((r) => ({ key: scoreBand(r.fitScore), success: success(r) })), mi, ms),
    byService: groupStats(called.map((r) => ({ key: r.service ?? "onbekend", success: success(r) })), mi, ms),
    bySignal: groupStats(bySignal, mi, ms),
    byMicrosoftEvidence: groupStats(called.map((r) => ({ key: techLabel(techMap.get(r.companyId)), success: success(r) })), mi, ms),
    outcomeDistribution: Object.fromEntries(outcomeDist),
    revenue: {
      estimatedOpenMrrEur: pipeline?.estimatedOpenMrr ?? 0,
      contractedMrrEur: pipeline?.contractedMrr ?? 0,
      conversions: pipeline?.conversions ?? 0,
      note: "Geschat ≠ gecontracteerd. Geschatte pijplijn op basis van open opportunities.",
    },
  };
}
export type Performance = Awaited<ReturnType<typeof commercialPerformance>>;

/**
 * Turn performance into recommendations. Adjusts industry priority by at most
 * one tier automatically (approved boundary); everything else requires human approval.
 */
export async function generateRecommendations(perf?: Performance) {
  const p = perf ?? (await commercialPerformance());
  const settings = await getSettings();
  const db = getDb();
  const overall = p.totals.rate;
  const created: string[] = [];
  const overrides: Record<string, number> = {};
  const industries = await db.select().from(schema.industries);

  for (const g of p.byIndustry) {
    if (g.strength === "speculative") continue;
    const ind = industries.find((i) => i.code === g.key);
    if (!ind || ind.priorityTier === 0) continue;
    if (g.ciLow > overall) {
      const newTier = Math.max(1, ind.priorityTier - 1);
      const [r] = await db.insert(schema.recommendations).values({
        type: "prioritize_industry", title: `Prioriteer ${ind.nameNl}`,
        content: `Afspraakratio ${(g.rate * 100).toFixed(1)}% (95%-CI ${(g.ciLow * 100).toFixed(1)}–${(g.ciHigh * 100).toFixed(1)}%, n=${g.n}) ligt boven het gemiddelde van ${(overall * 100).toFixed(1)}%.`,
        evidenceStrength: g.strength, evidence: g, proposedChange: { industry: ind.code, priorityTier: newTier },
        requiresApproval: !settings.learning.autoAdjustIndustryPriority, status: settings.learning.autoAdjustIndustryPriority ? "applied" : "proposed", createdBy: "system:learning",
      }).returning({ id: schema.recommendations.id });
      created.push(r.id);
      if (settings.learning.autoAdjustIndustryPriority) overrides[ind.code] = newTier;
    } else if (g.ciHigh < overall) {
      const newTier = Math.min(4, ind.priorityTier + 1);
      const [r] = await db.insert(schema.recommendations).values({
        type: "deprioritize_industry", title: `Deprioriteer ${ind.nameNl}`,
        content: `Afspraakratio ${(g.rate * 100).toFixed(1)}% (95%-CI ${(g.ciLow * 100).toFixed(1)}–${(g.ciHigh * 100).toFixed(1)}%, n=${g.n}) ligt onder het gemiddelde van ${(overall * 100).toFixed(1)}%.`,
        evidenceStrength: g.strength, evidence: g, proposedChange: { industry: ind.code, priorityTier: newTier },
        requiresApproval: !settings.learning.autoAdjustIndustryPriority, status: settings.learning.autoAdjustIndustryPriority ? "applied" : "proposed", createdBy: "system:learning",
      }).returning({ id: schema.recommendations.id });
      created.push(r.id);
      if (settings.learning.autoAdjustIndustryPriority) overrides[ind.code] = newTier;
    }
  }

  // Score-band monotonicity check → scoring model hypothesis test (always requires approval).
  const band = (k: string) => p.byScoreBand.find((b) => b.key === k);
  const hi = band("85-100");
  const mid = band("70-84");
  if (hi && mid && hi.n >= settings.learning.minSampleForIndicative && mid.n >= settings.learning.minSampleForIndicative && hi.rate < mid.rate) {
    const [r] = await db.insert(schema.recommendations).values({
      type: "scoring_adjustment", title: "Scoremodel voorspelt afspraken niet monotoon",
      content: `Score 85–100 converteert ${(hi.rate * 100).toFixed(1)}% (n=${hi.n}) vs. 70–84 ${(mid.rate * 100).toFixed(1)}% (n=${mid.n}). Herzie gewichten; onderzoek welke componenten de hoge scores drijven.`,
      evidenceStrength: hi.strength === "statistically_meaningful" && mid.strength === "statistically_meaningful" ? "indicative" : "speculative",
      evidence: { hi, mid }, requiresApproval: true, createdBy: "system:learning",
    }).returning({ id: schema.recommendations.id });
    created.push(r.id);
  }
  const noMs = p.outcomeDistribution["no_microsoft_environment"] ?? 0;
  if (p.totals.called >= settings.learning.minSampleForIndicative && noMs / Math.max(1, p.totals.called) > 0.1) {
    const [r] = await db.insert(schema.recommendations).values({
      type: "new_criterion", title: "Strengere Microsoft-bewijseis",
      content: `${noMs} van ${p.totals.called} gebelde prospects meldden 'geen Microsoft-omgeving'. Overweeg minimaal 'sterk aangewezen' Exchange Online/M365-bewijs als kwalificatie-eis.`,
      evidenceStrength: "indicative", evidence: { noMs, called: p.totals.called }, requiresApproval: true, createdBy: "system:learning",
    }).returning({ id: schema.recommendations.id });
    created.push(r.id);
  }
  const wrong = (p.outcomeDistribution["wrong_contact"] ?? 0) + (p.outcomeDistribution["no_purchasing_authority"] ?? 0);
  if (p.totals.called >= settings.learning.minSampleForIndicative && wrong / Math.max(1, p.totals.called) > 0.15) {
    const [r] = await db.insert(schema.recommendations).values({
      type: "research_source", title: "Verbeter onderzoek naar beslisser en inkoopbevoegdheid",
      content: `${wrong} van ${p.totals.called} gesprekken: verkeerde contactpersoon of geen inkoopbevoegdheid. Investeer in groepsstructuur-onderzoek (KvK/jaarverslagen) en IT-rolidentificatie.`,
      evidenceStrength: "indicative", evidence: { wrong, called: p.totals.called }, requiresApproval: true, createdBy: "system:learning",
    }).returning({ id: schema.recommendations.id });
    created.push(r.id);
  }

  if (Object.keys(overrides).length) {
    const [last] = await db.select().from(schema.strategies).orderBy(desc(schema.strategies.version)).limit(1);
    const prev = (last?.content as { industryTierOverrides?: Record<string, number> }) ?? {};
    await db.insert(schema.strategies).values({
      version: (last?.version ?? 0) + 1,
      content: { ...prev, industryTierOverrides: { ...(prev.industryTierOverrides ?? {}), ...overrides }, basedOn: p.generatedAt },
      createdByAgent: "system:learning", approved: true, approvedBy: "policy:auto_adjust_industry_priority",
    });
  }
  return { created, overrides };
}

/** Effective industry tiers = base tiers + latest approved strategy overrides (±1 tier boundary). */
export async function effectiveIndustryTiers(): Promise<Map<string, { id: number; tier: number; nameNl: string }>> {
  const db = getDb();
  const inds = await db.select().from(schema.industries);
  const [strategy] = await db.select().from(schema.strategies).where(eq(schema.strategies.approved, true)).orderBy(desc(schema.strategies.version)).limit(1);
  const ov = ((strategy?.content as { industryTierOverrides?: Record<string, number> })?.industryTierOverrides) ?? {};
  return new Map(
    inds.map((i) => {
      const o = ov[i.code];
      const tier = i.priorityTier === 0 ? 0 : o != null ? Math.max(i.priorityTier - 1, Math.min(i.priorityTier + 1, o)) : i.priorityTier;
      return [i.code, { id: i.id, tier, nameNl: i.nameNl }];
    }),
  );
}

export async function marketMap() {
  const db = getDb();
  const tiers = await effectiveIndustryTiers();
  const rows = (await db.execute(sql`
    select i.code, i.name_nl as "nameNl", i.priority_tier as "baseTier", i.estimated_pool_size as "estimatedPool",
      count(c.id)::int as discovered,
      count(c.id) filter (where c.status not in ('candidate'))::int as researched,
      count(c.id) filter (where c.status in ('qualified','approved','exported'))::int as qualified,
      count(c.id) filter (where c.status = 'exported')::int as exported,
      count(c.id) filter (where c.status in ('rejected','excluded'))::int as rejected,
      (select count(*)::int from appointments a join companies c2 on c2.id = a.company_id where c2.industry_id = i.id) as appointments,
      max(c.last_researched_at) as "lastResearchedAt"
    from industries i left join companies c on c.industry_id = i.id and c.deleted_at is null
    group by i.id order by i.priority_tier, i.code`)) as unknown as {
    code: string; nameNl: string; baseTier: number; estimatedPool: number | null; discovered: number; researched: number; qualified: number; exported: number; rejected: number; appointments: number; lastResearchedAt: string | null;
  }[];
  const segments = await db.select().from(schema.marketSegments);
  return {
    note: "Geschatte marktdekking is onzeker: poolgroottes zijn alleen bekend als een beheerder of agent een onderbouwde schatting vastlegde.",
    industries: rows.map((r) => {
      const segs = segments.filter((s) => s.industryId === tiers.get(r.code)?.id);
      return {
        ...r,
        effectiveTier: tiers.get(r.code)?.tier ?? r.baseTier,
        coverage: r.estimatedPool ? Math.min(1, r.discovered / r.estimatedPool) : null,
        exhaustionEstimate: segs.length ? Math.max(...segs.map((s) => s.exhaustionEstimate ?? 0)) : null,
        queriesUsed: segs.flatMap((s) => s.queriesUsed ?? []).slice(-40),
        sourcesUsed: segs.flatMap((s) => s.sourcesUsed ?? []).slice(-20),
      };
    }),
  };
}

export async function dashboardStats() {
  const db = getDb();
  const weekStart = startOfWeekAmsterdam();
  const [c] = (await db.execute(sql`
    select count(*)::int as total,
      count(*) filter (where status in ('qualified','approved','exported') and updated_at >= ${weekStart})::int as "qualifiedThisWeek",
      count(*) filter (where last_researched_at >= ${weekStart})::int as "researchedThisWeek",
      count(*) filter (where status in ('rejected','excluded') and updated_at >= ${weekStart})::int as "rejectedThisWeek",
      count(*) filter (where status = 'exported')::int as exported,
      round(avg(fit_score) filter (where status in ('qualified','approved','exported')))::int as "avgFit"
    from companies where deleted_at is null`)) as unknown as Record<string, number>[];
  const [a] = (await db.execute(sql`select count(*)::int as appointments from appointments`)) as unknown as { appointments: number }[];
  const [costs] = (await db.execute(sql`
    select (select coalesce(sum(cost_eur),0) from agent_tasks where created_at >= ${weekStart})::float as "aiWeek",
           (select coalesce(sum(cost_eur),0) from provider_usage where created_at >= ${weekStart})::float as "providersWeek",
           (select coalesce(sum(cost_eur),0) from agent_tasks)::float as "aiTotal",
           (select coalesce(sum(cost_eur),0) from provider_usage)::float as "providersTotal"`)) as unknown as Record<string, number>[];
  const [activeRun] = await db.select().from(schema.researchRuns).where(sql`${schema.researchRuns.status} in ('queued','running','paused')`).orderBy(desc(schema.researchRuns.createdAt)).limit(1);
  const agentActivity = (await db.execute(sql`
    select agent_id as "agentId", count(*)::int as tasks, count(*) filter (where status='running')::int as running,
      count(*) filter (where status='failed')::int as failed, coalesce(sum(cost_eur),0)::float as cost, max(created_at) as "lastActive"
    from agent_tasks where created_at >= now() - interval '7 days' group by agent_id`)) as unknown as { agentId: string; tasks: number; running: number; failed: number; cost: number; lastActive: string }[];
  const perf = await commercialPerformance();
  const qualifiedTotal = await db.select({ n: sql<number>`count(*)::int` }).from(schema.companies).where(and(sql`${schema.companies.status} in ('qualified','approved','exported')`, isNull(schema.companies.deletedAt)));
  const totalCost = (costs?.aiTotal ?? 0) + (costs?.providersTotal ?? 0);
  return {
    companies: c,
    appointments: a?.appointments ?? 0,
    conversion: perf.totals,
    revenue: perf.revenue,
    costs: { ...costs, week: (costs?.aiWeek ?? 0) + (costs?.providersWeek ?? 0), total: totalCost, perQualified: qualifiedTotal[0].n ? totalCost / qualifiedTotal[0].n : null, perAppointment: a?.appointments ? totalCost / a.appointments : null },
    activeRun: activeRun ?? null,
    agentActivity,
  };
}

export { employeeEstimate };
