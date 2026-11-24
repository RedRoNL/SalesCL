import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { getSettings } from "@/lib/settings";

export class BudgetExceededError extends Error {
  constructor(public scope: "run" | "week" | "month", public spent: number, public limit: number) {
    super(`Budget overschreden (${scope}): €${spent.toFixed(2)} van €${limit.toFixed(2)}`);
  }
}

function startOfWeekAmsterdam(now = new Date()): Date {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - day);
  return d;
}
function startOfMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Total spend (AI + providers) since `from`, optionally for one run. */
export async function spendSince(from: Date, runId?: string): Promise<number> {
  const db = getDb();
  const ai = await db
    .select({ v: sql<string>`coalesce(sum(${schema.agentTasks.costEur}),0)` })
    .from(schema.agentTasks)
    .where(runId ? and(gte(schema.agentTasks.createdAt, from), eq(schema.agentTasks.runId, runId)) : gte(schema.agentTasks.createdAt, from));
  const prov = await db
    .select({ v: sql<string>`coalesce(sum(${schema.providerUsage.costEur}),0)` })
    .from(schema.providerUsage)
    .where(runId ? and(gte(schema.providerUsage.createdAt, from), eq(schema.providerUsage.runId, runId)) : gte(schema.providerUsage.createdAt, from));
  return Number(ai[0].v) + Number(prov[0].v);
}

/** Throws BudgetExceededError if any configured budget is exhausted. */
export async function assertWithinBudget(runId?: string | null): Promise<void> {
  const s = await getSettings();
  const week = await spendSince(startOfWeekAmsterdam());
  if (s.budget.weeklyEur > 0 && week >= s.budget.weeklyEur) throw new BudgetExceededError("week", week, s.budget.weeklyEur);
  const month = await spendSince(startOfMonth());
  if (s.budget.monthlyEur > 0 && month >= s.budget.monthlyEur) throw new BudgetExceededError("month", month, s.budget.monthlyEur);
  if (runId) {
    const [run] = await getDb().select({ budget: schema.researchRuns.budgetEur }).from(schema.researchRuns).where(eq(schema.researchRuns.id, runId));
    const limit = run?.budget ? Number(run.budget) : null;
    if (limit != null && limit > 0) {
      const spent = await spendSince(new Date(0), runId);
      if (spent >= limit) throw new BudgetExceededError("run", spent, limit);
    }
  }
}

/** Paid third-party providers must be explicitly approved by an administrator. */
export async function assertPaidProviderApproved(provider: string): Promise<void> {
  const s = await getSettings();
  if (!s.budget.approvedPaidProviders.includes(provider)) {
    throw new Error(`Betaalde provider '${provider}' is niet goedgekeurd (Instellingen → Budget)`);
  }
}

export { startOfWeekAmsterdam, startOfMonth };
