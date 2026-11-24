import { and, eq, sql, desc } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { createRun } from "@/pipeline/runs";
import { phoneInSource } from "@/pipeline/stages";
import { audit } from "@/lib/audit";

/** The three live pilots from the build brief: 10 qualified companies each, 300–5,000 FTE. */
export const PILOT_PRESETS = {
  manufacturing: { label: "10 maakbedrijven", industries: ["manufacturing", "industrial_engineering"], target: 10 },
  logistics: { label: "10 logistiek & transport", industries: ["logistics", "transportation", "maritime", "distribution"], target: 10 },
  operational: { label: "10 overige operationele sectoren", industries: ["food_production", "energy", "utilities", "construction", "infrastructure", "wholesale"], target: 10 },
} as const;
export type PilotKey = keyof typeof PILOT_PRESETS;

/** Paid research never starts without an explicit, recorded budget approval. */
export async function startPilot(key: PilotKey, budgetEur: number, approved: boolean, actor: string) {
  // Budget €0 = no paid spend (Claude Subscription Mode + free providers). Any paid budget needs explicit approval.
  if (!(budgetEur >= 0 && budgetEur <= 200)) throw new Error("Pilotbudget moet tussen €0 en €200 liggen");
  if (budgetEur > 0 && !approved) throw new Error("Expliciete budgetgoedkeuring is vereist voor betaalde pilotkosten");
  const p = PILOT_PRESETS[key];
  const r = await createRun("pilot", { target: p.target, industries: [...p.industries], minEmployees: 300, maxEmployees: 5000, pilot: key }, actor, budgetEur);
  await audit({ actorType: "user", actorId: actor, action: "pilot.started", entityType: "research_run", entityId: r.runId, details: { key, budgetEur, approved } });
  return r;
}

/** Measurements requested for every pilot. */
export async function pilotMetrics(runId: string) {
  const db = getDb();
  const [run] = await db.select().from(schema.researchRuns).where(eq(schema.researchRuns.id, runId));
  if (!run) return null;
  const rcs = await db.select({ rc: schema.runCandidates, c: schema.companies }).from(schema.runCandidates).innerJoin(schema.companies, eq(schema.companies.id, schema.runCandidates.companyId)).where(eq(schema.runCandidates.runId, runId));
  const qualified = rcs.filter((x) => x.rc.outcome === "qualified");
  const rejected = rcs.filter((x) => x.rc.status === "rejected");
  const ev = (await db.execute(sql`
    select te.company_id as id, max(case te.classification when 'confirmed' then 3 when 'strongly_indicated' then 2 when 'weakly_indicated' then 1 else 0 end)::int as best
    from technology_evidence te join run_candidates rc on rc.company_id = te.company_id and rc.run_id = ${runId}
    where te.technology in ('microsoft_365','exchange_online') group by te.company_id`)) as unknown as { id: string; best: number }[];
  const phoneSources = await db.select().from(schema.researchSources).where(sql`${schema.researchSources.id} in (select phone_source_id from companies c join run_candidates rc on rc.company_id = c.id where rc.run_id = ${runId} and c.phone_source_id is not null)`);
  const verifiedPhones = rcs.filter((x) => x.c.phonePublic && phoneInSource(x.c.phonePublic, phoneSources.find((s) => s.id === x.c.phoneSourceId)?.excerpt)).length;
  const [cost] = (await db.execute(sql`select (select coalesce(sum(cost_eur),0) from agent_tasks where run_id = ${runId})::float as ai, (select coalesce(sum(cost_eur),0) from provider_usage where run_id = ${runId})::float as providers`)) as unknown as { ai: number; providers: number }[];
  const sources = (await db.execute(sql`
    select s.name, s.source_type as type, count(sc.id)::int as found, count(sc.id) filter (where sc.was_new)::int as "unique",
      count(rc.id) filter (where rc.outcome = 'qualified')::int as qualified
    from source_companies sc join discovery_sources s on s.id = sc.source_id
    left join run_candidates rc on rc.company_id = sc.company_id and rc.run_id = ${runId}
    where sc.run_id = ${runId} group by s.id order by qualified desc, "unique" desc`)) as unknown as { name: string; type: string; found: number; unique: number; qualified: number }[];
  const qa = await db.select().from(schema.qaReviews).where(and(eq(schema.qaReviews.runId, runId)));
  const qaReasons = qa.filter((q) => q.verdict !== "approved").flatMap((q) => q.issues).reduce<Record<string, number>>((m, i) => ((m[i.slice(0, 90)] = (m[i.slice(0, 90)] ?? 0) + 1), m), {});
  const rejectReasons = rejected.reduce<Record<string, number>>((m, x) => {
    const k = (x.rc.outcome ?? "onbekend").split(/[:(—]/)[0].trim().slice(0, 60);
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});
  const stats = (run.stats ?? {}) as Record<string, number>;
  const total = (cost?.ai ?? 0) + (cost?.providers ?? 0);
  return {
    runId, pilot: (run.params as { pilot?: string }).pilot ?? null, status: run.status, target: run.targetProspects,
    candidatesDiscovered: rcs.length, candidatesRejected: rejected.length, qualified: qualified.length,
    reserve: stats.reserve ?? 0, needsResearch: rcs.filter((x) => x.rc.status === "skipped").length - (stats.reserve ?? 0),
    verifiedMicrosoftEvidence: ev.filter((e) => e.best >= 2).length,
    verifiedPhones, verifiedEmployeeCounts: rcs.filter((x) => x.c.employeeSourceId).length,
    durationMinutes: run.startedAt ? Math.round(((run.finishedAt ?? new Date()).getTime() - run.startedAt.getTime()) / 60000) : null,
    totalCostEur: total, aiCostEur: cost?.ai ?? 0, providerCostEur: cost?.providers ?? 0,
    costPerQualifiedEur: qualified.length ? total / qualified.length : null,
    duplicatesDetected: (stats.discovery_duplicate ?? 0) + rcs.filter((x) => /Duplicaat/.test(x.rc.outcome ?? "")).length,
    sourceQuality: sources, rejectionReasons: rejectReasons, qaRejectionReasons: qaReasons,
  };
}

export async function pilotRuns() {
  return getDb().select().from(schema.researchRuns).where(eq(schema.researchRuns.kind, "pilot")).orderBy(desc(schema.researchRuns.createdAt)).limit(20);
}
