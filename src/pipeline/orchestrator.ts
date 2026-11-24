import { and, eq, desc, inArray, isNull, sql, notInArray } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { getSettings } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { BudgetExceededError, spendSince } from "@/lib/budget";
import { commercialPerformance, marketMap, effectiveIndustryTiers, generateRecommendations } from "@/lib/analytics";
import { runAgent } from "@/agents/runtime";
import { AwaitingExecutor } from "@/agents/executor";
import * as S from "@/agents/schemas";
import type { AgentId } from "@/agents/types";
import { ResearchService } from "@/research/service";
import { isoWeek, employeeEstimate, sizeBand } from "@/domain/normalize";
import { SERVICES } from "@/domain/services";
import { sourceStats, selectSources } from "@/discovery/sources";
import { openWorkCount, resumeDeferredWork } from "@/discovery/work";
import { buildCapabilities } from "./capabilities";
import { registerCandidate, openCandidateCount, runCandidateCounts, qualifiedCount } from "./candidates";
import { getRun, setRunStatus, heartbeat, bumpStat, pauseRun, runStatusSummary, type RunParams } from "./runs";
import { buildDossier } from "./dossier";
import { getQueue, JOBS } from "./queue";

type Plan = import("zod").infer<typeof S.WeeklyPlanOutput>;

/** Average new candidates a harvest produced historically (fallback 12). */
function expectedYield(stats: Awaited<ReturnType<typeof sourceStats>>): number {
  const harvested = stats.filter((s) => s.harvestCount > 0);
  if (!harvested.length) return 12;
  return Math.max(4, Math.round(harvested.reduce((a, s) => a + s.uniqueNew / s.harvestCount, 0) / harvested.length));
}

/**
 * Plan the run: CSO strategy (1 model call), then deterministic work planning against
 * the discovery-source database. Work units (harvest / scout / hunt) run in parallel in
 * the worker and stream candidates into the research funnel immediately — discovery and
 * research overlap instead of waiting for each other.
 */
export async function orchestrateRun(runId: string) {
  const db = getDb();
  const run = await getRun(runId);
  if (!run || ["cancelled", "completed", "failed", "paused"].includes(run.status)) return;
  await setRunStatus(runId, "running");
  const params = run.params as RunParams;
  const settings = await getSettings();
  const q = await getQueue();

  try {
    if (run.kind === "company") {
      const r = await registerCandidate(runId, { name: params.companyName ?? "Onbekend", website: params.companyWebsite ?? null, discoveredBy: "user" });
      await heartbeat(runId, "research");
      if (r.status === "new" || r.status === "reused") await q.send(JOBS.candidate, { runId, companyId: r.companyId }, { singletonKey: `${runId}:${r.companyId}` });
      else {
        await db.update(schema.researchRuns).set({ error: r.status === "excluded" ? `Uitgesloten: ${r.reasons.join("; ")}` : r.status === "duplicate" ? `Duplicaat: ${r.reason}` : "Niet geregistreerd" }).where(eq(schema.researchRuns.id, runId));
        await q.send(JOBS.finalize, { runId }, { singletonKey: `${runId}:advance` });
      }
      return;
    }

    const stats = await sourceStats();
    // ── Strategy (checkpointed).
    let plan = run.strategy as Plan | null;
    if (!plan) {
      await heartbeat(runId, "strategy");
      const [perf, map, prev] = await Promise.all([commercialPerformance(), marketMap(), runStatusSummary()]);
      const { output } = await runAgent<typeof S.WeeklyPlanOutput>("chief_sales_officer", "plan_week", {
        isoWeek: isoWeek(new Date(), settings.schedule.timezone), target: params.target,
        performance: { totals: perf.totals, byIndustry: perf.byIndustry, bySize: perf.bySize, byScoreBand: perf.byScoreBand, outcomeDistribution: perf.outcomeDistribution },
        marketMap: map.industries.map((i) => ({ code: i.code, tier: i.effectiveTier, discovered: i.discovered, qualified: i.qualified, appointments: i.appointments })),
        previousRuns: prev,
        sourceStats: stats.filter((s) => s.harvestCount > 0).sort((a, b) => b.priority - a.priority).slice(0, 25).map((s) => ({ name: s.name, type: s.sourceType, industries: s.industryCodes, uniqueNew: s.uniqueNew, qualified: s.qualified, priority: s.priority, status: s.status })),
        constraints: { industries: params.industries, sizeBand: params.minEmployees || params.maxEmployees ? [params.minEmployees ?? settings.icp.minEmployees, params.maxEmployees ?? settings.icp.maxEmployees] : undefined },
      }, { runId, capabilities: buildCapabilities() });
      const tiers = await effectiveIndustryTiers();
      output.industries = output.industries.filter((i) => (tiers.get(i.code)?.tier ?? 0) > 0 && (!params.industries?.length || params.industries.includes(i.code)));
      if (!output.industries.length && params.industries?.length)
        output.industries = params.industries.filter((c) => (tiers.get(c)?.tier ?? 0) > 0).map((code) => ({ code: code as Plan["industries"][number]["code"], quota: Math.ceil((params.target * settings.schedule.candidateMultiplier) / params.industries!.length), rationale: "Door gebruiker opgegeven sector", sizeFocus: "midmarket" as const }));
      plan = output;
      const [last] = await db.select().from(schema.strategies).orderBy(desc(schema.strategies.version)).limit(1);
      await db.insert(schema.strategies).values({ version: (last?.version ?? 0) + 1, content: { ...((last?.content as object) ?? {}), weeklyPlan: plan }, createdByAgent: "chief_sales_officer", runId, approved: true, approvedBy: "policy:within_boundaries" });
      await db.update(schema.researchRuns).set({ strategy: plan }).where(eq(schema.researchRuns.id, runId));
    }

    // ── Reuse first: reserve candidates from earlier runs (already screened, never paid for twice).
    await heartbeat(runId, "discovery");
    const reused = await seedFromReserve(runId, plan.industries.map((i) => i.code), Math.ceil(params.target * 0.6));
    if (reused) await bumpStat(runId, "reserveReused", reused);

    // ── Deterministic work planning against the source database.
    const existingWork = await db.select({ id: schema.runWork.id }).from(schema.runWork).where(eq(schema.runWork.runId, runId));
    if (!existingWork.length) {
      const perHarvest = expectedYield(stats);
      const units: (typeof schema.runWork.$inferInsert)[] = [];
      const plannedPages = new Set<string>(); // a page source is harvested at most once per run, whatever its industries
      for (const ind of plan.industries) {
        const slots = Math.min(8, Math.max(2, Math.ceil(ind.quota / perHarvest)));
        const picks = selectSources(stats.filter((s) => !(s.kind === "page" && plannedPages.has(s.id))), ind.code, slots, settings.research.explorationShare);
        for (const p of picks) if (stats.find((s) => s.id === p.sourceId)?.kind === "page") plannedPages.add(p.sourceId);
        for (const p of picks) units.push({ runId, kind: "harvest", sourceId: p.sourceId, params: { industry: ind.code, exploration: p.exploration } });
        const productive = stats.filter((s) => s.industryCodes.includes(ind.code) && s.status === "active" && s.qualified > 0).length;
        if (picks.length < slots || productive < 2) units.push({ runId, kind: "scout", params: { industry: ind.code } });
        if (ind.sizeFocus === "enterprise" && plan.hunterAllocation.enterprise > 0) units.push({ runId, kind: "hunt", params: { industry: ind.code, agent: "enterprise_hunter", quota: Math.ceil(ind.quota / 2), themes: plan.searchThemes } });
      }
      const rows = units.length ? await db.insert(schema.runWork).values(units).returning() : [];
      for (const w of rows) await q.send(w.kind === "harvest" ? JOBS.harvest : w.kind === "scout" ? JOBS.scout : JOBS.hunt, { runId, workId: w.id }, { singletonKey: w.id });
      await bumpStat(runId, "workPlanned", rows.length);
      if (!rows.length) await q.send(JOBS.finalize, { runId }, { singletonKey: `${runId}:advance` });
    }
    await heartbeat(runId, "research");
  } catch (err) {
    if (err instanceof AwaitingExecutor) return; // strategy parked for Claude Code; resumes on submit
    if (err instanceof BudgetExceededError) return void (await pauseRun(runId, "system:budget", err.message));
    await db.update(schema.researchRuns).set({ error: (err instanceof Error ? err.message : String(err)).slice(0, 2000) }).where(eq(schema.researchRuns.id, runId));
    throw err;
  }
}

/** Put previously screened, still-unused candidates back into the funnel (no repeat discovery cost). */
async function seedFromReserve(runId: string, industries: string[], limit: number) {
  const db = getDb();
  const settings = await getSettings();
  const inds = await db.select({ id: schema.industries.id }).from(schema.industries).where(inArray(schema.industries.code, industries.length ? industries : ["__none__"]));
  if (!inds.length) return 0;
  const reserve = await db
    .select({ id: schema.companies.id, score: schema.companies.screenScore })
    .from(schema.companies)
    .where(and(eq(schema.companies.status, "candidate"), eq(schema.companies.relationship, "none"), isNull(schema.companies.deletedAt), inArray(schema.companies.industryId, inds.map((i) => i.id)),
      sql`${schema.companies.lastResearchedAt} > now() - (${settings.research.factReuseDays} || ' days')::interval`,
      sql`not exists (select 1 from deliveries d where d.company_id = ${schema.companies.id})`,
      sql`not exists (select 1 from run_candidates rc join research_runs r on r.id = rc.run_id where rc.company_id = ${schema.companies.id} and r.status in ('running','paused','queued'))`))
    .orderBy(desc(schema.companies.screenScore))
    .limit(limit);
  const q = await getQueue();
  for (const r of reserve) {
    await db.insert(schema.runCandidates).values({ runId, companyId: r.id, hunter: "reserve", priority: Math.min(95, r.score ?? 60), checkpoint: { reused: true } }).onConflictDoNothing();
    await q.send(JOBS.candidate, { runId, companyId: r.id }, { singletonKey: `${runId}:${r.id}`, priority: Math.min(95, r.score ?? 60) });
  }
  return reserve.length;
}

/**
 * Called whenever work or candidates close. Finalises when everything is done; if the run
 * is short of its target and budget remains, starts one adaptive shortfall round first
 * (more exploration sources, source scouting, midmarket + growth hunters).
 */
export async function advanceRun(runId: string) {
  const db = getDb();
  const run = await getRun(runId);
  if (!run || run.status !== "running") return;
  // Deferred discovery (cap was reached) resumes as soon as rejections have freed slots and the target is not met yet.
  if ((await qualifiedCount(runId)) < run.targetProspects && (await resumeDeferredWork(runId)) > 0) return;
  if ((await openWorkCount(runId)) > 0 || (await openCandidateCount(runId)) > 0) return;
  const settings = await getSettings();
  const qualified = await qualifiedCount(runId);
  const round = Math.max(1, ...(await db.select({ r: schema.runWork.round }).from(schema.runWork).where(eq(schema.runWork.runId, runId))).map((w) => w.r));
  const spent = await spendSince(new Date(0), runId);
  const budget = run.budgetEur ? Number(run.budgetEur) : Infinity;
  const plan = run.strategy as Plan | null;
  if (run.kind !== "company" && plan && qualified < run.targetProspects && round < 2 && spent < budget * 0.7) {
    const q = await getQueue();
    const stats = await sourceStats();
    const units: (typeof schema.runWork.$inferInsert)[] = [];
    const used = new Set((await db.select({ s: schema.runWork.sourceId }).from(schema.runWork).where(eq(schema.runWork.runId, runId))).map((w) => w.s));
    for (const ind of plan.industries.slice(0, 4)) {
      for (const p of selectSources(stats.filter((s) => !used.has(s.id)), ind.code, 3, 0.6)) units.push({ runId, kind: "harvest", sourceId: p.sourceId, params: { industry: ind.code, exploration: p.exploration }, round: 2 });
      units.push({ runId, kind: "scout", params: { industry: ind.code }, round: 2 });
      units.push({ runId, kind: "hunt", params: { industry: ind.code, agent: "midmarket_hunter", quota: 15, themes: plan.searchThemes }, round: 2 });
    }
    const minEmp = (run.params as RunParams).minEmployees ?? settings.icp.minEmployees;
    if (minEmp < settings.icp.primaryBand[0] && plan.industries[0]) units.push({ runId, kind: "hunt", params: { industry: plan.industries[0].code, agent: "growth_market_hunter", quota: 10, themes: plan.searchThemes }, round: 2 });
    const rows = await db.insert(schema.runWork).values(units).returning();
    for (const w of rows) await q.send(w.kind === "harvest" ? JOBS.harvest : w.kind === "scout" ? JOBS.scout : JOBS.hunt, { runId, workId: w.id }, { singletonKey: w.id });
    await bumpStat(runId, "shortfallRound", 1);
    await audit({ actorType: "system", action: "run.shortfall_round", entityType: "research_run", entityId: runId, details: { qualified, target: run.targetProspects, units: rows.length } });
    return;
  }
  await finalizeRun(runId);
}

const PRIORITY = (score: number) => (score >= 85 ? "A" : score >= 70 ? "B" : "C");

/**
 * Rank QA-approved, contact-eligible prospects, write rationales in batches (Lead
 * Qualification Specialist), build the draft list, CSO review + management summary.
 */
export async function finalizeRun(runId: string) {
  const db = getDb();
  const run = await getRun(runId);
  if (!run || run.status === "completed" || run.status === "cancelled") return;
  if ((await openCandidateCount(runId)) > 0 || (await openWorkCount(runId)) > 0) return;
  await heartbeat(runId, "finalize");
  const settings = await getSettings();
  const params = run.params as RunParams;

  const qualified = await db
    .select({ c: schema.companies })
    .from(schema.runCandidates)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.runCandidates.companyId))
    .where(and(eq(schema.runCandidates.runId, runId), eq(schema.runCandidates.outcome, "qualified"), eq(schema.companies.contactEligibility, "eligible")));
  const ranked = qualified.map((r) => r.c).sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0) || (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0));
  const primary = ranked.filter((c) => sizeBand(employeeEstimate(c)) !== "50-299");
  const growth = ranked.filter((c) => sizeBand(employeeEstimate(c)) === "50-299");
  const growthCap = primary.length >= params.target ? Math.floor(params.target * settings.icp.growthMaxShare) : params.target - primary.length;
  const selected = [...primary.slice(0, params.target), ...growth.slice(0, Math.max(0, Math.min(growthCap, params.target - Math.min(primary.length, params.target))))]
    .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))
    .slice(0, params.target);

  // Batch rationale (≤20 per call) — one model call per batch instead of one per company.
  for (let i = 0; i < selected.length; i += 20) {
    const batch = selected.slice(i, i + 20);
    try {
      const companies = await Promise.all(batch.map(async (c) => {
        const d = await buildDossier(c.id, false);
        return { companyId: c.id, name: c.officialName, facts: { industry: d?.company.industry?.name, employees: employeeEstimate(c), technology: d?.technologyEvidence.slice(0, 8), signals: d?.buyingSignals.slice(0, 4) }, score: d?.score ? { fit: d.score.fit, confidence: d.score.confidence, components: d.score.components } : null, ruleBasedService: c.recommendedService ?? "ms_security_assessment" };
      }));
      const { output } = await runAgent<typeof S.RationaleBatchOutput>("lead_qualification_specialist", "rationale_batch", { companies }, { runId });
      for (const it of output.items) {
        const c = batch.find((x) => x.id === it.companyId);
        if (!c || !SERVICES.includes(it.recommendedService)) continue;
        const [score] = await db.select().from(schema.qualificationScores).where(eq(schema.qualificationScores.companyId, c.id)).orderBy(desc(schema.qualificationScores.createdAt)).limit(1);
        if (!score) continue;
        const override = it.recommendedService !== c.recommendedService;
        await db.update(schema.qualificationScores).set({ rationale: `${it.rationale}${override ? `\n[Afwijking van regel-dienst ${c.recommendedService}: ${it.serviceReason}]` : ""}\n\n${score.rationale}`, recommendedService: it.recommendedService, createdBy: "lead_qualification_specialist" }).where(eq(schema.qualificationScores.id, score.id));
        if (override) await db.update(schema.companies).set({ recommendedService: it.recommendedService }).where(eq(schema.companies.id, c.id));
      }
    } catch (e) {
      if (e instanceof AwaitingExecutor) throw e; // finalisation resumes when the batch rationale is submitted
      if (e instanceof BudgetExceededError) break;
      console.error(`[run ${runId}] rationale batch failed — deterministic rationale kept`, e instanceof Error ? e.message : e);
    }
  }

  const counts = await runCandidateCounts(runId);
  const shortfall = Math.max(0, params.target - selected.length);
  const qaRows = await db.select().from(schema.qaReviews).where(eq(schema.qaReviews.runId, runId));
  const rejectionReasons = await db.select({ outcome: schema.runCandidates.outcome }).from(schema.runCandidates).where(and(eq(schema.runCandidates.runId, runId), notInArray(schema.runCandidates.status, ["done", "pending", "in_progress"])));
  const reasonBuckets = rejectionReasons.reduce<Record<string, number>>((m, r) => {
    const k = (r.outcome ?? "onbekend").split(/[:(—]/)[0].trim().slice(0, 60);
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});
  const qaSummary = {
    reviewed: qaRows.length,
    approved: qaRows.filter((r) => r.verdict === "approved").length,
    rejected: qaRows.filter((r) => r.verdict === "rejected").length,
    needsResearch: qaRows.filter((r) => r.verdict === "needs_research").length,
    topIssues: Object.entries(qaRows.flatMap((r) => r.issues).reduce<Record<string, number>>((m, i) => ((m[i.slice(0, 80)] = (m[i.slice(0, 80)] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
  const shortfallExplanation = shortfall
    ? `Doel ${params.target}, ${selected.length} gekwalificeerd. Belangrijkste afvalredenen: ${Object.entries(reasonBuckets).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} (${v})`).join(", ")}. Kwaliteit is niet verlaagd om het aantal te halen.`
    : null;

  const listValues = { isoWeek: isoWeek(new Date(), settings.schedule.timezone), runId, status: "draft" as const, target: params.target, shortfall, shortfallExplanation, qaReport: { summary: qaSummary, candidateCounts: counts, rejectionReasons: reasonBuckets } };
  const [existingList] = await db.select().from(schema.prospectLists).where(and(eq(schema.prospectLists.runId, runId), inArray(schema.prospectLists.status, ["draft", "in_review"])));
  let list: typeof schema.prospectLists.$inferSelect;
  if (existingList) {
    await db.delete(schema.prospectListItems).where(eq(schema.prospectListItems.listId, existingList.id));
    [list] = await db.update(schema.prospectLists).set(listValues).where(eq(schema.prospectLists.id, existingList.id)).returning();
  } else {
    [list] = await db.insert(schema.prospectLists).values(listValues).returning();
  }
  let rank = 0;
  for (const c of selected) {
    const contacts = await db.select().from(schema.contacts).where(eq(schema.contacts.companyId, c.id));
    const pref = ["cio", "it_manager", "ciso", "security_officer", "cto", "cfo", "ceo", "other"];
    const best = contacts.sort((a, b) => pref.indexOf(a.roleCategory ?? "other") - pref.indexOf(b.roleCategory ?? "other"))[0];
    const [fresh] = await db.select({ fit: schema.companies.fitScore }).from(schema.companies).where(eq(schema.companies.id, c.id));
    await db.insert(schema.prospectListItems).values({ listId: list.id, companyId: c.id, rank: ++rank, priority: PRIORITY(fresh?.fit ?? c.fitScore ?? 0), contactRole: best?.roleTitle ?? "IT-manager / CIO", contactName: best?.sourceId ? best.fullName : null });
  }

  let managementSummary: string;
  const topSources = (await sourceStats()).filter((s) => s.harvestCount > 0).sort((a, b) => b.qualified - a.qualified).slice(0, 5).map((s) => ({ name: s.name, type: s.sourceType, uniqueNew: s.uniqueNew, qualified: s.qualified }));
  try {
    const { output } = await runAgent<typeof S.ListApprovalOutput>("chief_sales_officer", "approve_list", {
      isoWeek: list.isoWeek, stats: { target: params.target, selected: selected.length, candidates: counts, costEur: Number((await getRun(runId))?.costEur ?? 0), rejectionReasons: reasonBuckets, topSources }, qaSummary, shortfall,
      topCompanies: selected.slice(0, 15).map((c) => ({ name: c.officialName, fit: c.fitScore, confidence: c.confidenceScore, service: c.recommendedService, employees: employeeEstimate(c) })),
    }, { runId });
    managementSummary = output.managementSummary + (output.concerns.length ? `\n\n**Aandachtspunten CSO:**\n- ${output.concerns.join("\n- ")}` : "");
    await db.update(schema.prospectLists).set({ status: output.approveForReview ? "in_review" : "draft" }).where(eq(schema.prospectLists.id, list.id));
  } catch (e) {
    if (e instanceof AwaitingExecutor) throw e;
    managementSummary = `_Managementsamenvatting kon niet door de CSO worden opgesteld (${e instanceof Error ? e.message : e})._\n\nGeselecteerd: ${selected.length}/${params.target}. QA: ${qaSummary.approved} goedgekeurd, ${qaSummary.rejected} afgewezen, ${qaSummary.needsResearch} aanvullend onderzoek.`;
  }
  await db.update(schema.prospectLists).set({ managementSummary }).where(eq(schema.prospectLists.id, list.id));
  await setRunStatus(runId, "completed", { managementSummary, stage: "completed" });
  await audit({ actorType: "system", action: "run.completed", entityType: "research_run", entityId: runId, details: { listId: list.id, selected: selected.length, shortfall } });
  if (shortfall) await bumpStat(runId, "shortfall", shortfall);
  try {
    await generateRecommendations();
  } catch (e) {
    console.error("[learning] recommendation generation failed", e);
  }
  return list.id;
}

export type { AgentId };
export { ResearchService };
