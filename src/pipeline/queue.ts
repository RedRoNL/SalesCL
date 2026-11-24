import { PgBoss } from "pg-boss";

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
export interface JobQueue {
  send(name: JobName, data: object, opts?: SendOpts): Promise<string | null>;
}

/** Production queue: pg-boss on the same PostgreSQL database (durable, retries, singletons). */
export class PgBossQueue implements JobQueue {
  constructor(public boss: PgBoss) {}
  async send(name: JobName, data: object, opts: SendOpts = {}) {
    return this.boss.send(name, data, { retryLimit: opts.retryLimit ?? 3, retryDelay: opts.retryDelay ?? 30, retryBackoff: true, singletonKey: opts.singletonKey, startAfter: opts.startAfter, priority: opts.priority, expireInSeconds: 60 * 60 });
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
  async drain(max = 10000) {
    let n = 0;
    while (this.pending.length && n++ < max) {
      const job = this.pending.shift()!;
      const h = this.handlers.get(job.name);
      try {
        if (h) await h(job.data);
        this.log.push({ name: job.name, data: job.data });
      } catch (e) {
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
