import { and, eq, desc, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { getSettings } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { BudgetExceededError } from "@/lib/budget";
import { commercialPerformance, marketMap, effectiveIndustryTiers, generateRecommendations } from "@/lib/analytics";
import { runAgent } from "@/agents/runtime";
import * as S from "@/agents/schemas";
import type { AgentId } from "@/agents/types";
import { ResearchService } from "@/research/service";
import { isoWeek, employeeEstimate, sizeBand } from "@/domain/normalize";
import { buildCapabilities } from "./capabilities";
import { loadIdentityIndex, registerCandidate, openCandidateCount, runCandidateCounts } from "./candidates";
import { getRun, setRunStatus, heartbeat, bumpStat, pauseRun, runStatusSummary, type RunParams } from "./runs";
import { getQueue, JOBS } from "./queue";

type Plan = import("zod").infer<typeof S.WeeklyPlanOutput>;

/** Simple concurrency limiter for parallel agent tasks. */
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = { status: "fulfilled", value: await fn(items[idx]) };
      } catch (e) {
        out[idx] = { status: "rejected", reason: e };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

const HUNTER: Record<"enterprise" | "midmarket" | "growth", AgentId> = { enterprise: "enterprise_hunter", midmarket: "midmarket_hunter", growth: "growth_market_hunter" };

/**
 * Stage 1–4 of the weekly pipeline, executed as a durable job:
 * strategy (CSO) → discovery (Market Intelligence + Hunters, in parallel) →
 * preliminary filtering & deduplication (code) → fan-out of candidate jobs.
 * Each stage checkpoints on the run row so an interrupted job resumes.
 */
export async function orchestrateRun(runId: string) {
  const db = getDb();
  const run = await getRun(runId);
  if (!run || ["cancelled", "completed", "failed", "paused"].includes(run.status)) return;
  await setRunStatus(runId, "running");
  const params = run.params as RunParams;
  const settings = await getSettings();
  const research = await ResearchService.create({ runId });
  const q = await getQueue();

  try {
    // ── Company-specific research: skip strategy/discovery.
    if (run.kind === "company") {
      const idx = await loadIdentityIndex();
      const r = await registerCandidate(runId, { name: params.companyName ?? "Onbekend", website: params.companyWebsite ?? null, discoveredBy: "user" }, idx);
      await heartbeat(runId, "research");
      if (r.status === "new" || r.status === "reused") await q.send(JOBS.candidate, { runId, companyId: r.companyId }, { singletonKey: `${runId}:${r.companyId}` });
      else {
        await db.update(schema.researchRuns).set({ error: r.status === "excluded" ? `Uitgesloten: ${r.reasons.join("; ")}` : `Duplicaat: ${"reason" in r ? r.reason : ""}` }).where(eq(schema.researchRuns.id, runId));
        await q.send(JOBS.finalize, { runId }, { singletonKey: `${runId}:finalize` });
      }
      return;
    }

    // ── Stage 1: strategy (checkpointed).
    let plan = run.strategy as Plan | null;
    if (!plan) {
      await heartbeat(runId, "strategy");
      const [perf, map, prev] = await Promise.all([commercialPerformance(), marketMap(), runStatusSummary()]);
      const { output } = await runAgent<typeof S.WeeklyPlanOutput>("chief_sales_officer", "plan_week", {
        isoWeek: isoWeek(new Date(), settings.schedule.timezone), target: params.target,
        performance: { totals: perf.totals, byIndustry: perf.byIndustry, bySize: perf.bySize, byScoreBand: perf.byScoreBand, outcomeDistribution: perf.outcomeDistribution },
        marketMap: map.industries.map((i) => ({ code: i.code, tier: i.effectiveTier, discovered: i.discovered, qualified: i.qualified, appointments: i.appointments, exhaustion: i.exhaustionEstimate })),
        previousRuns: prev,
        constraints: { industries: params.industries, sizeBand: params.minEmployees || params.maxEmployees ? [params.minEmployees ?? settings.icp.minEmployees, params.maxEmployees ?? settings.icp.maxEmployees] : undefined },
      }, { runId, research, capabilities: buildCapabilities() });
      // Enforce boundaries in code: no excluded sectors, respect user constraints.
      const tiers = await effectiveIndustryTiers();
      output.industries = output.industries.filter((i) => (tiers.get(i.code)?.tier ?? 0) > 0 && (!params.industries?.length || params.industries.includes(i.code)));
      if (!output.industries.length && params.industries?.length)
        output.industries = params.industries.filter((c) => (tiers.get(c)?.tier ?? 0) > 0).map((code) => ({ code: code as Plan["industries"][number]["code"], quota: Math.ceil((params.target * settings.schedule.candidateMultiplier) / params.industries!.length), rationale: "Door gebruiker opgegeven sector", sizeFocus: "midmarket" as const }));
      plan = output;
      const [last] = await db.select().from(schema.strategies).orderBy(desc(schema.strategies.version)).limit(1);
      const prevContent = (last?.content as Record<string, unknown>) ?? {};
      await db.insert(schema.strategies).values({ version: (last?.version ?? 0) + 1, content: { ...prevContent, weeklyPlan: plan }, createdByAgent: "chief_sales_officer", runId, approved: true, approvedBy: "policy:within_boundaries" });
      await db.update(schema.researchRuns).set({ strategy: plan }).where(eq(schema.researchRuns.id, runId));
    }

    // ── Stage 2–4: discovery, filtering, deduplication.
    await heartbeat(runId, "discovery");
    const maxCandidates = Math.min(settings.schedule.maxCandidatesPerRun, Math.ceil(params.target * settings.schedule.candidateMultiplier));
    const done = new Set(((run.stats as Record<string, unknown>)?.discoveryDone as string[] | undefined) ?? []);
    const idx = await loadIdentityIndex();
    const tiers = await effectiveIndustryTiers();
    const bands = { enterprise: settings.icp.enterpriseBand, midmarket: settings.icp.primaryBand, growth: settings.icp.growthBand } as const;

    const tasks = plan.industries
      .filter((i) => !done.has(`${i.code}:${i.sizeFocus}`))
      .filter((i) => i.sizeFocus !== "growth" || plan!.hunterAllocation.growth > 0);

    for (let pass = 0; pass < 2; pass++) {
      const registeredSoFar = (await runCandidateCounts(runId));
      const total = Object.values(registeredSoFar).reduce((a, b) => a + b, 0);
      if (total >= maxCandidates) break;
      const work = pass === 0 ? tasks : plan.industries.filter((i) => i.sizeFocus === "midmarket").slice(0, 3);
      if (!work.length) break;
      await pool(work, 3, async (ind) => {
        const current = await getRun(runId);
        if (current?.status !== "running") return;
        const segs = await db.select().from(schema.marketSegments).where(eq(schema.marketSegments.industryId, tiers.get(ind.code)?.id ?? -1));
        const agentId: AgentId = segs.length === 0 && pass === 0 ? "market_intelligence_director" : HUNTER[ind.sizeFocus];
        const taskType = agentId === "market_intelligence_director" ? "discover_pools" : "hunt";
        const known = idx.identities.filter((i) => i.name).slice(-300).map((i) => i.name);
        const { output } = await runAgent<typeof S.DiscoveryOutput>(agentId, taskType, {
          industry: ind.code, industryName: tiers.get(ind.code)?.nameNl ?? ind.code, sizeBand: bands[ind.sizeFocus], quota: ind.quota,
          searchThemes: plan!.searchThemes, previousQueries: segs.flatMap((s) => s.queriesUsed ?? []).slice(-60), knownCompanyNames: known,
        }, { runId, research, capabilities: buildCapabilities() });
        let newCount = 0;
        for (const cand of output.candidates) {
          const counts = await runCandidateCounts(runId);
          if (Object.values(counts).reduce((a, b) => a + b, 0) >= maxCandidates) break;
          const r = await registerCandidate(runId, { ...cand, discoveredBy: agentId }, idx);
          await bumpStat(runId, `discovery_${r.status}`);
          if (r.status === "new" || r.status === "reused") newCount++;
          if (r.status === "excluded") await db.update(schema.companies).set({ industryId: tiers.get(ind.code)?.id ?? null }).where(eq(schema.companies.id, r.companyId));
          if (r.status === "new") await db.update(schema.companies).set({ industryId: tiers.get(ind.code)?.id ?? null, assignedAgent: agentId }).where(eq(schema.companies.id, r.companyId));
        }
        await db.insert(schema.marketSegments).values({
          industryId: tiers.get(ind.code)?.id ?? null, sizeBand: ind.sizeFocus, description: output.notes.slice(0, 1000),
          sourcesUsed: output.poolsUsed.map((p) => `${p.name}${p.url ? ` (${p.url})` : ""} [${p.usefulness}]`), queriesUsed: output.queriesUsed,
          candidatesFound: newCount, exhaustionEstimate: output.exhaustionEstimate, lastResearchedAt: new Date(),
        });
        done.add(`${ind.code}:${ind.sizeFocus}`);
        await db.update(schema.researchRuns).set({ stats: sql`jsonb_set(coalesce(${schema.researchRuns.stats}, '{}'::jsonb), '{discoveryDone}', ${JSON.stringify([...done])}::jsonb)` }).where(eq(schema.researchRuns.id, runId));
        await heartbeat(runId);
      }).then((results) => {
        const budgetErr = results.find((r) => r.status === "rejected" && r.reason instanceof BudgetExceededError);
        if (budgetErr && budgetErr.status === "rejected") throw budgetErr.reason;
        for (const r of results) if (r.status === "rejected") console.error(`[run ${runId}] discovery task failed:`, r.reason?.message ?? r.reason);
      });
    }

    // ── Fan out candidate research jobs (parallel execution in the worker pool).
    const fresh = await getRun(runId);
    if (fresh?.status !== "running") return;
    await heartbeat(runId, "research");
    const pending = await db.select({ companyId: schema.runCandidates.companyId }).from(schema.runCandidates).where(and(eq(schema.runCandidates.runId, runId), inArray(schema.runCandidates.status, ["pending"])));
    for (const p of pending) await q.send(JOBS.candidate, { runId, companyId: p.companyId }, { singletonKey: `${runId}:${p.companyId}` });
    if (!pending.length) await q.send(JOBS.finalize, { runId }, { singletonKey: `${runId}:finalize` });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      await pauseRun(runId, "system:budget", err.message);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    await db.update(schema.researchRuns).set({ error: msg.slice(0, 2000) }).where(eq(schema.researchRuns.id, runId));
    throw err; // retried by the queue; final failure handled in worker onFail
  }
}

const PRIORITY = (score: number) => (score >= 85 ? "A" : score >= 70 ? "B" : "C");

/**
 * Stages 11–12: rank QA-approved, contact-eligible prospects, build the weekly
 * list (as draft for human approval), CSO review + management summary.
 */
export async function finalizeRun(runId: string) {
  const db = getDb();
  const run = await getRun(runId);
  if (!run || run.status === "completed" || run.status === "cancelled") return;
  if ((await openCandidateCount(runId)) > 0) return; // not done yet
  await heartbeat(runId, "finalize");
  const settings = await getSettings();
  const params = run.params as RunParams;

  const qualified = await db
    .select({ c: schema.companies })
    .from(schema.runCandidates)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.runCandidates.companyId))
    .where(and(eq(schema.runCandidates.runId, runId), eq(schema.runCandidates.outcome, "qualified"), eq(schema.companies.contactEligibility, "eligible")));
  const ranked = qualified
    .map((r) => r.c)
    .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0) || (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0));

  // Growth band (50–300) capped unless the primary market leaves a shortfall.
  const primary = ranked.filter((c) => sizeBand(employeeEstimate(c)) !== "50-299");
  const growth = ranked.filter((c) => sizeBand(employeeEstimate(c)) === "50-299");
  const growthCap = primary.length >= params.target ? Math.floor(params.target * settings.icp.growthMaxShare) : params.target - primary.length;
  const selected = [...primary.slice(0, params.target), ...growth.slice(0, Math.max(0, Math.min(growthCap, params.target - Math.min(primary.length, params.target))))]
    .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))
    .slice(0, params.target);

  const counts = await runCandidateCounts(runId);
  const shortfall = Math.max(0, params.target - selected.length);
  const qaRows = await db.select().from(schema.qaReviews).where(eq(schema.qaReviews.runId, runId));
  const qaSummary = {
    reviewed: qaRows.length,
    approved: qaRows.filter((r) => r.verdict === "approved").length,
    rejected: qaRows.filter((r) => r.verdict === "rejected").length,
    needsResearch: qaRows.filter((r) => r.verdict === "needs_research").length,
    topIssues: Object.entries(qaRows.flatMap((r) => r.issues).reduce<Record<string, number>>((m, i) => ((m[i.slice(0, 80)] = (m[i.slice(0, 80)] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
  const shortfallExplanation = shortfall
    ? `Doel ${params.target}, ${selected.length} gekwalificeerd. Kandidaten: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}. Kwaliteit is niet verlaagd om het aantal te halen.`
    : null;

  const listValues = { isoWeek: isoWeek(new Date(), settings.schedule.timezone), runId, status: "draft" as const, target: params.target, shortfall, shortfallExplanation, qaReport: { summary: qaSummary, candidateCounts: counts } };
  // A re-finalised run (after retrying failed tasks) rebuilds its unexported list instead of creating a duplicate.
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
    await db.insert(schema.prospectListItems).values({ listId: list.id, companyId: c.id, rank: ++rank, priority: PRIORITY(c.fitScore ?? 0), contactRole: best?.roleTitle ?? "IT-manager / CIO", contactName: best?.sourceId ? best.fullName : null });
  }

  // CSO review and management summary. A model failure does not lose the list: the summary is marked as missing.
  let managementSummary: string;
  try {
    const { output } = await runAgent<typeof S.ListApprovalOutput>("chief_sales_officer", "approve_list", {
      isoWeek: list.isoWeek, stats: { target: params.target, selected: selected.length, candidates: counts, costEur: Number(run.costEur) }, qaSummary, shortfall,
      topCompanies: selected.slice(0, 15).map((c) => ({ name: c.officialName, fit: c.fitScore, confidence: c.confidenceScore, service: c.recommendedService, employees: employeeEstimate(c) })),
    }, { runId, capabilities: buildCapabilities() });
    managementSummary = output.managementSummary + (output.concerns.length ? `\n\n**Aandachtspunten CSO:**\n- ${output.concerns.join("\n- ")}` : "");
    await db.update(schema.prospectLists).set({ status: output.approveForReview ? "in_review" : "draft" }).where(eq(schema.prospectLists.id, list.id));
  } catch (e) {
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
