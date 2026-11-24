/**
 * Sales Army worker — the unattended production execution process.
 * Runs independently of any browser or interactive Claude Code session.
 *
 *   npm run worker
 *
 * Responsibilities: job execution (pg-boss on PostgreSQL), weekly schedule
 * (Mon 08:00 Europe/Amsterdam by default, configurable), watchdog recovery of
 * interrupted runs, nightly retention cleanup, learning analysis.
 */
import { getBoss, JOBS } from "@/pipeline/queue";
import { env } from "@/lib/env";
import { handlers, markRunFailed } from "./handlers";
import { runInJob, AwaitingExecutor } from "@/agents/executor";
import { syncSchedules } from "./schedule";
import { getDb, schema } from "@/db/client";

async function main() {
  const boss = await getBoss();
  const concurrency = env().WORKER_CONCURRENCY;
  for (const [name, handler] of Object.entries(handlers)) {
    const local = name === JOBS.candidate ? concurrency : name === JOBS.chat ? 2 : 1;
    await boss.work(name, { batchSize: 1, localConcurrency: local }, async (jobs) => {
      for (const job of jobs) {
        try {
          await runInJob({ name, data: job.data as Record<string, unknown> }, () => (handler as (d: unknown) => Promise<void>)(job.data));
        } catch (err) {
          if (err instanceof AwaitingExecutor) continue; // parked for Claude Code — not a failure
          console.error(`[worker] ${name} job ${job.id} failed`, err);
          // Final failure of an orchestrate job → mark the run failed instead of failing silently.
          const data = job.data as { runId?: string };
          if (name === JOBS.orchestrate && data.runId && (job as { retryCount?: number }).retryCount !== undefined && (job as { retryCount: number }).retryCount >= 2) {
            await markRunFailed(data.runId, err instanceof Error ? err.message : String(err));
          }
          throw err;
        }
      }
    });
  }
  const schedule = await syncSchedules(boss);
  const beat = async () => {
    const value = { at: new Date().toISOString(), schedule: await syncSchedules(boss).catch(() => schedule), pid: process.pid, version: "2" };
    await getDb().insert(schema.systemSettings).values({ key: "worker_heartbeat", value }).onConflictDoUpdate({ target: schema.systemSettings.key, set: { value, updatedAt: new Date() } });
  };
  await beat();
  setInterval(() => beat().catch((e) => console.error("[worker] heartbeat", e)), 60 * 1000);
  console.log(`[worker] gestart — wekelijkse planning: ${schedule}; kandidaat-concurrency ${concurrency}`);
  const stop = async () => {
    console.log("[worker] stoppen…");
    await boss.stop({ graceful: true, timeout: 30000 });
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => {
  console.error("[worker] fatale fout", e);
  process.exit(1);
});
