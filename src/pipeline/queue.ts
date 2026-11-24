import { PgBoss } from "pg-boss";
import { runInJob, AwaitingExecutor } from "@/agents/executor";

/** Persistent job names. */
export const JOBS = {
  orchestrate: "run-orchestrate",
  harvest: "run-harvest",
  scout: "run-scout",
  hunt: "run-hunt",
  candidate: "run-candidate",
  finalize: "run-finalize",
  weekly: "weekly-trigger",
  chat: "agent-chat",
  learning: "learning-analyze",
  watchdog: "run-watchdog",
  retention: "retention-cleanup",
} as const;
export type JobName = (typeof JOBS)[keyof typeof JOBS];

export interface SendOpts {
  singletonKey?: string;
  retryLimit?: number;
  retryDelay?: number;
  startAfter?: number;
  /** Higher = sooner (pg-boss priority). Candidate jobs use source yield / screen score. */
  priority?: number;
}
export type JobHandlers = Partial<Record<JobName, (data: never) => Promise<void>>>;
export interface JobQueue {
  send(name: JobName, data: object, opts?: SendOpts): Promise<string | null>;
  /**
   * Run queued jobs inline for up to maxMs (the "pump"): used in Claude Subscription Mode so no
   * always-on worker process is required. Returns the number of jobs processed.
   */
  process?(maxMs: number, handlers: JobHandlers, names?: JobName[]): Promise<number>;
}

/** Jobs the pump advances. Without a worker, the session also runs the daily maintenance jobs (learning, retention). */
export const PUMP_JOBS: JobName[] = [JOBS.orchestrate, JOBS.harvest, JOBS.scout, JOBS.hunt, JOBS.finalize, JOBS.chat, JOBS.candidate, JOBS.learning, JOBS.retention];

/** Production queue: pg-boss on the same PostgreSQL database (durable, retries, singletons). */
export class PgBossQueue implements JobQueue {
  constructor(public boss: PgBoss) {}
  async send(name: JobName, data: object, opts: SendOpts = {}) {
    // pg-boss asserts on present-but-undefined option keys, so only set what is defined.
    const o: Record<string, unknown> = { retryLimit: opts.retryLimit ?? 3, retryDelay: opts.retryDelay ?? 30, retryBackoff: true, expireInSeconds: 60 * 60 };
    if (opts.singletonKey) o.singletonKey = opts.singletonKey;
    if (opts.startAfter != null) o.startAfter = opts.startAfter;
    if (opts.priority != null && Number.isFinite(Number(opts.priority))) o.priority = Math.round(Number(opts.priority));
    return this.boss.send(name, data, o);
  }
  async process(maxMs: number, handlers: JobHandlers, names: JobName[] = PUMP_JOBS) {
    const until = Date.now() + maxMs;
    let n = 0;
    let idle = false;
    while (Date.now() < until && !idle) {
      idle = true;
      for (const name of names) {
        if (Date.now() >= until) break;
        const handler = handlers[name];
        if (!handler) continue;
        const jobs = await this.boss.fetch<Record<string, unknown>>(name, { batchSize: 1 });
        for (const job of jobs) {
          idle = false;
          n++;
          try {
            await runInJob({ name, data: job.data }, () => (handler as (d: unknown) => Promise<void>)(job.data));
            await this.boss.complete(name, job.id);
          } catch (e) {
            if (e instanceof AwaitingExecutor) await this.boss.complete(name, job.id, { parked: true });
            else await this.boss.fail(name, job.id, { message: e instanceof Error ? e.message : String(e) });
          }
        }
      }
    }
    return n;
  }
}

let bossPromise: Promise<PgBoss> | null = null;
/** Lazily start a pg-boss client (API routes only send; the worker process runs handlers). */
export async function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    bossPromise = (async () => {
      const boss = new PgBoss({ connectionString: process.env.DATABASE_URL ?? "postgres://salesarmy:salesarmy@localhost:5432/salesarmy", schema: "pgboss" });
      boss.on("error", (e) => console.error("[pg-boss]", e));
      await boss.start();
      for (const name of Object.values(JOBS)) if (!(await boss.getQueue(name))) await boss.createQueue(name);
      return boss;
    })();
  }
  return bossPromise;
}

/** In-process queue for tests: deterministic, drained explicitly. */
export class InlineQueue implements JobQueue {
  private pending: { name: JobName; data: object; singletonKey?: string }[] = [];
  private handlers = new Map<JobName, (data: object) => Promise<void>>();
  public log: { name: JobName; data: object; error?: string }[] = [];
  on(name: JobName, h: (data: never) => Promise<void>) {
    this.handlers.set(name, h as (data: object) => Promise<void>);
  }
  async send(name: JobName, data: object, opts: SendOpts = {}) {
    if (opts.singletonKey && this.pending.some((p) => p.name === name && p.singletonKey === opts.singletonKey)) return null;
    this.pending.push({ name, data, singletonKey: opts.singletonKey });
    return `inline-${this.log.length + this.pending.length}`;
  }
  async process(_maxMs: number) {
    const before = this.log.length;
    await this.drain();
    return this.log.length - before;
  }
  async drain(max = 10000) {
    let n = 0;
    while (this.pending.length && n++ < max) {
      const job = this.pending.shift()!;
      const h = this.handlers.get(job.name);
      try {
        if (h) await runInJob({ name: job.name, data: job.data as Record<string, unknown> }, () => h(job.data));
        this.log.push({ name: job.name, data: job.data });
      } catch (e) {
        if (e instanceof AwaitingExecutor) {
          this.log.push({ name: job.name, data: job.data, error: "parked" });
          continue;
        }
        this.log.push({ name: job.name, data: job.data, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
}

let queueOverride: JobQueue | null = null;
export function setQueue(q: JobQueue | null) {
  queueOverride = q;
}
export async function getQueue(): Promise<JobQueue> {
  return queueOverride ?? new PgBossQueue(await getBoss());
}
