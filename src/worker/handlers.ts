import { lt, sql, and, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { getSettings } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { generateRecommendations, commercialPerformance } from "@/lib/analytics";
import { orchestrateRun, advanceRun } from "@/pipeline/orchestrator";
import { harvestWork, scoutWork, huntWork } from "@/discovery/work";
import { processCandidate } from "@/pipeline/stages";
import { handleChat, type ChatJob } from "@/pipeline/chat";
import { createRun, recoverStaleRuns, setRunStatus } from "@/pipeline/runs";
import { JOBS, type JobName } from "@/pipeline/queue";
import { runAgent } from "@/agents/runtime";
import { modelAvailable } from "@/agents/model";

/** Job handlers shared by the pg-boss worker and the inline test queue. */
export const handlers: Record<JobName, (data: never) => Promise<void>> = {
  [JOBS.orchestrate]: async (d: { runId: string }) => orchestrateRun(d.runId),
  [JOBS.candidate]: async (d: { runId: string; companyId: string }) => processCandidate(d.runId, d.companyId),
  [JOBS.harvest]: async (d: { runId: string; workId: string }) => {
    await harvestWork(d.runId, d.workId);
    await advanceRun(d.runId);
  },
  [JOBS.scout]: async (d: { runId: string; workId: string }) => {
    await scoutWork(d.runId, d.workId);
    await advanceRun(d.runId);
  },
  [JOBS.hunt]: async (d: { runId: string; workId: string }) => {
    await huntWork(d.runId, d.workId);
    await advanceRun(d.runId);
  },
  [JOBS.finalize]: async (d: { runId: string }) => {
    await advanceRun(d.runId);
  },
  [JOBS.chat]: async (d: ChatJob) => handleChat(d),
  [JOBS.weekly]: async () => {
    const s = await getSettings();
    if (!s.schedule.enabled) return;
    if (!(await modelAvailable())) {
      await audit({ actorType: "system", action: "weekly.skipped", details: { reason: "geen AI-uitvoering beschikbaar (Paid API Mode zonder goedkeuring of sleutel)" } });
      throw new Error("Wekelijkse run niet gestart: AI-uitvoering niet beschikbaar");
    }
    const r = await createRun("weekly", { target: s.schedule.weeklyTarget }, "system:scheduler");
    await audit({ actorType: "system", action: r.created ? "weekly.started" : "weekly.duplicate_prevented", entityType: "research_run", entityId: r.runId });
  },
  [JOBS.learning]: async () => {
    // Weekly agent performance snapshot (history for HQ KPIs).
    const rows = (await getDb().execute(sql`
      select agent_id as "agentId", count(*)::int as tasks, count(*) filter (where status='succeeded')::int as succeeded,
        count(*) filter (where status='failed')::int as failed, coalesce(sum(cost_eur),0)::float as cost, coalesce(avg(tool_calls),0)::float as "avgToolCalls"
      from agent_tasks where created_at >= now() - interval '7 days' group by agent_id`)) as unknown as { agentId: string }[];
    const periodStart = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    for (const r of rows) await getDb().insert(schema.agentPerformanceSnapshots).values({ agentId: r.agentId, periodStart, metrics: r });
    const perf = await commercialPerformance();
    await generateRecommendations(perf);
    if ((await modelAvailable()) && perf.totals.called > 0) {
      const { output } = await runAgent<typeof import("@/agents/schemas").FeedbackAnalysisOutput>("sales_operations_manager", "analyze_feedback", { performance: perf, recentImports: null });
      for (const r of output.recommendations)
        await getDb().insert(schema.recommendations).values({ type: r.type, title: r.title, content: r.content, evidenceStrength: r.evidenceStrength, requiresApproval: true, createdBy: "agent:sales_operations_manager" });
    }
  },
  [JOBS.watchdog]: async () => {
    await recoverStaleRuns(30);
  },
  [JOBS.retention]: async () => {
    const s = await getSettings();
    const db = getDb();
    const now = new Date();
    await db.delete(schema.contacts).where(and(isNotNull(schema.contacts.retentionUntil), lt(schema.contacts.retentionUntil, now.toISOString().slice(0, 10))));
    await db.update(schema.researchSources).set({ excerpt: null }).where(lt(schema.researchSources.retrievedAt, new Date(now.getTime() - s.retention.sourceExcerptRetentionDays * 86400000)));
    await db.delete(schema.researchCache).where(lt(schema.researchCache.expiresAt, now));
    await db.delete(schema.auditLogs).where(lt(schema.auditLogs.createdAt, new Date(now.getTime() - s.retention.auditLogRetentionDays * 86400000)));
    await db.execute(sql`update companies set deleted_at = now() where status in ('rejected') and deleted_at is null and updated_at < now() - (${s.retention.rejectedCompanyRetentionDays} || ' days')::interval and relationship = 'none'`);
    await audit({ actorType: "system", action: "retention.cleanup" });
  },
};

export async function markRunFailed(runId: string, error: string) {
  await setRunStatus(runId, "failed", { error: error.slice(0, 2000) });
  await audit({ actorType: "system", action: "run.failed", entityType: "research_run", entityId: runId, details: { error: error.slice(0, 500) } });
}
