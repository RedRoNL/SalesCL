import { and, eq, inArray, sql, desc } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { isoWeek } from "@/domain/normalize";
import { getQueue, JOBS } from "./queue";
import { currentExecutor } from "@/agents/executor";
import type { StartRunParams } from "@/agents/tools";

export type RunKind = "weekly" | "manual" | "sector" | "company" | "pilot";
export interface RunParams {
  target: number;
  industries?: string[];
  minEmployees?: number;
  maxEmployees?: number;
  companyName?: string;
  companyWebsite?: string;
  depth?: "light" | "standard" | "deep";
  instructions?: string;
  providers?: { search?: string; fetch?: string };
  pilot?: string;
}

/**
 * Create a research run. Duplicate prevention: weekly runs use idempotency key
 * "weekly:<ISO week>"; manual runs with identical parameters within an active
 * run are deduplicated.
 */
export async function createRun(kind: RunKind, params: RunParams, triggeredBy: string, budgetEur?: number) {
  const db = getDb();
  const settings = await getSettings();
  const key =
    kind === "weekly"
      ? `weekly:${isoWeek(new Date(), settings.schedule.timezone)}`
      : `${kind}:${JSON.stringify(params)}:active`;
  if (kind !== "weekly") {
    const [active] = await db
      .select({ id: schema.researchRuns.id })
      .from(schema.researchRuns)
      .where(and(eq(schema.researchRuns.idempotencyKey, key), inArray(schema.researchRuns.status, ["queued", "running", "paused"])));
    if (active) return { runId: active.id, created: false };
  }
  const inserted = await db
    .insert(schema.researchRuns)
    .values({ kind, params, idempotencyKey: key, targetProspects: params.target, budgetEur: (budgetEur ?? settings.budget.perRunDefaultEur).toFixed(2), triggeredBy, stage: "queued", executor: await currentExecutor() })
    .onConflictDoNothing({ target: schema.researchRuns.idempotencyKey })
    .returning({ id: schema.researchRuns.id });
  if (!inserted.length) {
    const [existing] = await db.select({ id: schema.researchRuns.id }).from(schema.researchRuns).where(eq(schema.researchRuns.idempotencyKey, key));
    return { runId: existing.id, created: false };
  }
  const runId = inserted[0].id;
  // Non-weekly keys are released when the run ends so a new identical run can be started later.
  await audit({ actorType: triggeredBy.startsWith("user:") ? "user" : "system", actorId: triggeredBy, action: "run.created", entityType: "research_run", entityId: runId, details: { kind, params } });
  await (await getQueue()).send(JOBS.orchestrate, { runId }, { singletonKey: runId });
  return { runId, created: true };
}

export function startRunFromAgent(userId: string | null) {
  return (p: StartRunParams) =>
    createRun(p.kind, { target: p.target, industries: p.industries, minEmployees: p.minEmployees, maxEmployees: p.maxEmployees, companyName: p.companyName, companyWebsite: p.companyWebsite, instructions: p.instructions }, `agent:chief_sales_officer${userId ? `:for:${userId}` : ""}`);
}

export async function getRun(runId: string) {
  const [run] = await getDb().select().from(schema.researchRuns).where(eq(schema.researchRuns.id, runId));
  return run ?? null;
}

export async function setRunStatus(runId: string, status: "running" | "paused" | "cancelled" | "completed" | "failed", extra: Partial<typeof schema.researchRuns.$inferInsert> = {}) {
  const finished = status === "completed" || status === "failed" || status === "cancelled";
  await getDb()
    .update(schema.researchRuns)
    .set({
      status,
      ...(status === "running" ? { startedAt: sql`coalesce(${schema.researchRuns.startedAt}, now())` } : {}),
      ...(finished ? { finishedAt: new Date(), idempotencyKey: sql`case when ${schema.researchRuns.kind} = 'weekly' then ${schema.researchRuns.idempotencyKey} else ${schema.researchRuns.idempotencyKey} || ':' || ${schema.researchRuns.id} end` } : {}),
      heartbeatAt: new Date(),
      ...extra,
    })
    .where(eq(schema.researchRuns.id, runId));
}

export async function heartbeat(runId: string, stage?: string) {
  await getDb().update(schema.researchRuns).set({ heartbeatAt: new Date(), ...(stage ? { stage } : {}) }).where(eq(schema.researchRuns.id, runId));
}

export async function bumpStat(runId: string, key: string, by = 1) {
  await getDb()
    .update(schema.researchRuns)
    .set({ stats: sql`jsonb_set(coalesce(${schema.researchRuns.stats}, '{}'::jsonb), ${`{${key}}`}::text[], to_jsonb(coalesce((${schema.researchRuns.stats}->>${key})::int, 0) + ${by}))` })
    .where(eq(schema.researchRuns.id, runId));
}

/** Pause: in-flight candidate jobs stop at their next checkpoint; resume re-enqueues pending work. */
export async function pauseRun(runId: string, actor: string, reason = "Handmatig gepauzeerd") {
  await setRunStatus(runId, "paused", { pauseReason: reason });
  await audit({ actorType: actor.startsWith("user:") ? "user" : "system", actorId: actor, action: "run.paused", entityType: "research_run", entityId: runId, details: { reason } });
}
export async function cancelRun(runId: string, actor: string) {
  await setRunStatus(runId, "cancelled");
  await audit({ actorType: "user", actorId: actor, action: "run.cancelled", entityType: "research_run", entityId: runId });
}
export async function resumeRun(runId: string, actor: string) {
  const run = await getRun(runId);
  if (!run || run.status !== "paused") return false;
  await setRunStatus(runId, "running", { pauseReason: null });
  await requeuePending(runId);
  await audit({ actorType: "user", actorId: actor, action: "run.resumed", entityType: "research_run", entityId: runId });
  return true;
}

/** Re-enqueue all non-terminal candidates (resume, retry-failed, crash recovery). */
export async function requeuePending(runId: string, includeFailed = false) {
  const db = getDb();
  const run = await getRun(runId);
  if (!run) return 0;
  if (run.stage === "queued" || run.stage === "strategy" || run.stage === "discovery") {
    await (await getQueue()).send(JOBS.orchestrate, { runId }, { singletonKey: `${runId}:resume:${Date.now()}` });
    return 1;
  }
  // Re-enqueue unfinished discovery work units.
  if (includeFailed) await db.update(schema.runWork).set({ status: "pending", error: null }).where(and(eq(schema.runWork.runId, runId), eq(schema.runWork.status, "failed")));
  // A deliberate retry re-parks AI tasks that failed in Claude Subscription Mode (their keys no longer match).
  if (includeFailed) await db.update(schema.agentTasks).set({ idempotencyKey: null, executor: "claude_code:retried" }).where(and(eq(schema.agentTasks.runId, runId), eq(schema.agentTasks.status, "failed"), eq(schema.agentTasks.executor, "claude_code")));
  const pendingWork = await db.select().from(schema.runWork).where(and(eq(schema.runWork.runId, runId), eq(schema.runWork.status, "pending")));
  for (const w of pendingWork) await (await getQueue()).send(w.kind === "harvest" ? JOBS.harvest : w.kind === "scout" ? JOBS.scout : JOBS.hunt, { runId, workId: w.id }, { singletonKey: `${w.id}:${Date.now()}` });
  const statuses = includeFailed ? ["pending", "in_progress", "failed"] : ["pending", "in_progress"];
  if (includeFailed) {
    const reset = await db.update(schema.runCandidates).set({ status: "pending", lastError: null, attempts: 0 }).where(and(eq(schema.runCandidates.runId, runId), eq(schema.runCandidates.status, "failed"))).returning({ id: schema.runCandidates.id });
    // Retrying failed work re-opens a finished run; finalisation then rebuilds its (unexported) list.
    if (reset.length && (run.status === "completed" || run.status === "failed")) {
      await db.update(schema.researchRuns).set({ status: "running", finishedAt: null, error: null, heartbeatAt: new Date() }).where(eq(schema.researchRuns.id, runId));
    }
  }
  const rows = await db.select({ companyId: schema.runCandidates.companyId }).from(schema.runCandidates).where(and(eq(schema.runCandidates.runId, runId), inArray(schema.runCandidates.status, statuses)));
  const q = await getQueue();
  for (const r of rows) await q.send(JOBS.candidate, { runId, companyId: r.companyId }, { singletonKey: `${runId}:${r.companyId}:${Date.now()}` });
  if (!rows.length) await q.send(JOBS.finalize, { runId }, { singletonKey: `${runId}:advance` });
  return rows.length + pendingWork.length;
}

/** Watchdog: runs with no heartbeat for 30 min are considered interrupted and recovered. */
export async function recoverStaleRuns(maxAgeMinutes = 30) {
  const db = getDb();
  const stale = await db
    .select({ id: schema.researchRuns.id })
    .from(schema.researchRuns)
    .where(and(eq(schema.researchRuns.status, "running"), sql`${schema.researchRuns.heartbeatAt} < now() - (${maxAgeMinutes} || ' minutes')::interval`));
  for (const r of stale) {
    await audit({ actorType: "system", action: "run.recovered", entityType: "research_run", entityId: r.id });
    await heartbeat(r.id);
    await requeuePending(r.id);
  }
  return stale.length;
}

export async function runStatusSummary(runId?: string) {
  const db = getDb();
  const runs = runId
    ? await db.select().from(schema.researchRuns).where(eq(schema.researchRuns.id, runId))
    : await db.select().from(schema.researchRuns).orderBy(desc(schema.researchRuns.createdAt)).limit(5);
  return runs.map((r) => ({ id: r.id, kind: r.kind, status: r.status, stage: r.stage, target: r.targetProspects, costEur: Number(r.costEur), stats: r.stats, createdAt: r.createdAt, pauseReason: r.pauseReason, error: r.error }));
}
