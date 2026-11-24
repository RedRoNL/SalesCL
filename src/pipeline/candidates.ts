import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { canonicalDomain, normalizeCompanyName } from "@/domain/normalize";
import { evaluateExclusions, type ExclusionRule, type SuppressionRecord, type ExclusionSubject, type ExclusionResult } from "@/domain/exclusion";
import { getSettings } from "@/lib/settings";
import { findExistingCompany, addIdentifiers } from "./identity";

export interface CandidateInput {
  name: string;
  website?: string | null;
  city?: string | null;
  estimatedEmployees?: number | null;
  sourceId?: string | null;
  rationale?: string;
  discoveredBy: string;
  /** Discovery source that surfaced this company (for yield tracking). */
  discoverySourceId?: string | null;
  role?: string | null;
  industryId?: number | null;
  priority?: number;
}

let exclusionCache: { at: number; v: { rules: ExclusionRule[]; suppressions: SuppressionRecord[]; excludedCategories: string[] } } | null = null;
export async function loadExclusionContext(fresh = false) {
  if (!fresh && exclusionCache && Date.now() - exclusionCache.at < 30_000) return exclusionCache.v;
  const db = getDb();
  const rules = (await db.select().from(schema.exclusions).where(eq(schema.exclusions.active, true))) as ExclusionRule[];
  const suppressions = (await db.select().from(schema.suppressions)) as SuppressionRecord[];
  const settings = await getSettings();
  exclusionCache = { at: Date.now(), v: { rules, suppressions, excludedCategories: settings.icp.excludedCategories } };
  return exclusionCache.v;
}
export function invalidateExclusionCache() {
  exclusionCache = null;
}

export async function checkExclusions(subject: ExclusionSubject): Promise<ExclusionResult> {
  const ctx = await loadExclusionContext();
  return evaluateExclusions(subject, ctx.rules, ctx.suppressions, ctx.excludedCategories);
}

export type RegisterOutcome =
  | { status: "new"; companyId: string }
  | { status: "reused"; companyId: string }
  | { status: "duplicate"; matchedId?: string; reason: string }
  | { status: "excluded"; companyId: string; reasons: string[] }
  | { status: "capped" };

const REUSABLE = new Set(["candidate", "needs_research", "researched"]);

async function linkSource(sourceId: string | null | undefined, companyId: string, runId: string, wasNew: boolean, role?: string | null) {
  if (!sourceId) return;
  await getDb().insert(schema.sourceCompanies).values({ sourceId, companyId, runId, wasNew, role: role ?? null }).onConflictDoNothing();
}

/**
 * Register a discovered candidate for a run: deduplicate against the permanent
 * database (KvK, domains incl. historical, phones, parent group, aliases, fuzzy
 * names), enforce exclusions/suppressions, record which source surfaced it, then
 * create or reuse the company record.
 */
export async function registerCandidate(runId: string, input: CandidateInput, maxCandidates?: number): Promise<RegisterOutcome> {
  const db = getDb();
  const domain = canonicalDomain(input.website ?? null);
  const existing = await findExistingCompany({ name: input.name, domain, city: input.city });
  if (existing?.matchedId) {
    await linkSource(input.discoverySourceId, existing.matchedId, runId, false, input.role);
    // Remember the name variant / domain we just saw.
    if (existing.reason !== "fuzzy_name") await addIdentifiers(existing.matchedId, { names: [input.name], domains: [domain] }, "discovery");
    const [already] = await db.select({ id: schema.runCandidates.id }).from(schema.runCandidates).where(and(eq(schema.runCandidates.runId, runId), eq(schema.runCandidates.companyId, existing.matchedId)));
    if (!already && REUSABLE.has(existing.status) && existing.relationship === "none" && (!existing.delivered || existing.reactivationApproved)) {
      if (maxCandidates != null && (await candidateCapReached(runId, maxCandidates))) return { status: "capped" };
      await db.insert(schema.runCandidates).values({ runId, companyId: existing.matchedId, hunter: input.discoveredBy, discoverySourceId: input.discoverySourceId ?? null, priority: input.priority ?? 50, checkpoint: { reused: true } }).onConflictDoNothing();
      return { status: "reused", companyId: existing.matchedId };
    }
    return { status: "duplicate", matchedId: existing.matchedId, reason: `${existing.reason} (${existing.matchedName})` };
  }
  if (maxCandidates != null && (await candidateCapReached(runId, maxCandidates))) return { status: "capped" };

  const ex = await checkExclusions({ name: input.name, domain });
  const [company] = await db
    .insert(schema.companies)
    .values({
      officialName: input.name.trim().slice(0, 200), normalizedName: normalizeCompanyName(input.name), website: domain ? input.website ?? `https://${domain}` : null,
      canonicalDomain: domain, nlOfficeCity: input.city ?? null, industryId: input.industryId ?? null,
      status: ex.excluded ? "excluded" : "candidate", relationship: ex.suppressed ? "opted_out" : "none",
      contactEligibility: ex.suppressed ? "suppressed" : "unknown", discoveredBy: input.discoveredBy, discoveredRunId: runId, assignedAgent: input.discoveredBy,
    })
    .onConflictDoNothing()
    .returning({ id: schema.companies.id });
  if (!company) return { status: "duplicate", reason: "domein/KvK bestaat al" };
  if (domain) await db.insert(schema.domains).values({ domain, companyId: company.id, isPrimary: true }).onConflictDoNothing();
  await addIdentifiers(company.id, { names: [input.name], domains: [domain] }, "discovery");
  if (input.sourceId) await db.update(schema.researchSources).set({ companyId: company.id }).where(and(eq(schema.researchSources.id, input.sourceId), sql`${schema.researchSources.companyId} is null`));
  await linkSource(input.discoverySourceId, company.id, runId, true, input.role);
  if (ex.excluded) return { status: "excluded", companyId: company.id, reasons: ex.reasons.map((r) => r.reason) };
  await db.insert(schema.runCandidates).values({ runId, companyId: company.id, hunter: input.discoveredBy, discoverySourceId: input.discoverySourceId ?? null, priority: input.priority ?? 50, checkpoint: { estimatedEmployees: input.estimatedEmployees ?? null, rationale: input.rationale ?? null } }).onConflictDoNothing();
  return { status: "new", companyId: company.id };
}

export async function runCandidateTotal(runId: string): Promise<number> {
  const [r] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.runCandidates).where(eq(schema.runCandidates.runId, runId));
  return r.n;
}

/**
 * Candidates that still consume (or produced) research capacity. Rejected/skipped/failed candidates free their slot,
 * so a member list full of small firms cannot crowd out larger employers found later in the run (live-pilot finding).
 * Total work stays bounded by the per-run budget, the hard maxCandidatesPerRun on discovery and the stop-at-target rule.
 */
/** Active slots are bounded by maxCandidates; total screened candidates by 4× that (free screening is cheap). */
async function candidateCapReached(runId: string, maxCandidates: number) {
  return (await runActiveCandidateTotal(runId)) >= maxCandidates || (await runCandidateTotal(runId)) >= maxCandidates * 4;
}

export async function runActiveCandidateTotal(runId: string): Promise<number> {
  const [r] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.runCandidates).where(and(eq(schema.runCandidates.runId, runId), inArray(schema.runCandidates.status, ["pending", "in_progress", "done"])));
  return r.n;
}

export async function runCandidateCounts(runId: string) {
  const rows = await getDb().select({ status: schema.runCandidates.status, n: sql<number>`count(*)::int` }).from(schema.runCandidates).where(eq(schema.runCandidates.runId, runId)).groupBy(schema.runCandidates.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
}

export async function openCandidateCount(runId: string) {
  const [r] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.runCandidates).where(and(eq(schema.runCandidates.runId, runId), inArray(schema.runCandidates.status, ["pending", "in_progress"])));
  return r.n;
}

export async function qualifiedCount(runId: string) {
  const [r] = await getDb().select({ n: sql<number>`count(*)::int` }).from(schema.runCandidates).where(and(eq(schema.runCandidates.runId, runId), eq(schema.runCandidates.outcome, "qualified")));
  return r.n;
}
