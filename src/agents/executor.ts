import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { getSettings } from "@/lib/settings";
import { getSecret } from "@/lib/secrets";
import { hasModelOverride } from "./model";

/**
 * AI execution modes.
 *  - "claude_code" (Claude Subscription Mode, default): agent tasks are parked as structured work items
 *    and executed by a native Claude Code session (cloud scheduled task) through the bridge, using the
 *    repository's subagents and skills. Billed to the existing Claude subscription; no API key involved.
 *  - "api" (Paid API Mode): the Messages API tool loop. Requires explicit approval and an API key.
 * There is never an automatic fallback from subscription to paid API.
 */
export type Executor = "claude_code" | "api";

/** Thrown when a task has been parked for a Claude Code session. Job runners treat it as "parked", not failed. */
export class AwaitingExecutor extends Error {
  constructor(public taskId: string, public agentId: string, public taskType: string) {
    super(`Wacht op Claude Code-sessie (taak ${taskType} van ${agentId})`);
  }
}

/** The job currently being executed, so a parked task knows which job to resume. */
export interface JobContext {
  name: string;
  data: Record<string, unknown>;
}
export const jobContext = new AsyncLocalStorage<JobContext>();
export function runInJob<T>(job: JobContext, fn: () => Promise<T>): Promise<T> {
  return jobContext.run(job, fn);
}

export async function currentExecutor(): Promise<Executor> {
  if (hasModelOverride()) return "api"; // tests inject a scripted model
  const s = await getSettings();
  return s.execution.mode === "api" ? "api" : "claude_code";
}

/** Can AI tasks be executed (now or by a later Claude Code session)? */
export async function executorAvailable(): Promise<boolean> {
  if ((await currentExecutor()) === "claude_code") return true;
  const s = await getSettings();
  return hasModelOverride() || (s.execution.paidApiApproved && Boolean(await getSecret("ANTHROPIC_API_KEY")));
}

/** Stable JSON (sorted keys) for idempotency keys. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
export function taskKey(parts: { agentId: string; taskType: string; runId?: string | null; companyId?: string | null; input: unknown }): string {
  return createHash("sha256").update(`${parts.agentId}|${parts.taskType}|${parts.runId ?? ""}|${parts.companyId ?? ""}|${stableStringify(parts.input)}`).digest("hex");
}
