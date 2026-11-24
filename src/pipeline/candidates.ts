import { and, eq, isNull, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { canonicalDomain, normalizeCompanyName } from "@/domain/normalize";
import { findDuplicate, type CompanyIdentity } from "@/domain/dedup";
import { evaluateExclusions, type ExclusionRule, type SuppressionRecord, type ExclusionSubject, type ExclusionResult } from "@/domain/exclusion";
import { getSettings } from "@/lib/settings";

export interface CandidateInput {
  name: string;
  website?: string | null;
  city?: string | null;
  estimatedEmployees?: number | null;
  sourceId?: string | null;
  rationale?: string;
  discoveredBy: string;
}

export interface IdentityIndex {
  identities: (CompanyIdentity & { status: string; relationship: string; delivered: boolean; reactivationApproved: boolean })[];
}

export async function loadIdentityIndex(): Promise<IdentityIndex> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.companies.id, name: schema.companies.officialName, trading: schema.companies.tradingName, domain: schema.companies.canonicalDomain, kvk: schema.companies.kvkNumber, groupId: schema.companies.groupId, status: schema.companies.status, relationship: schema.companies.relationship, reactivationApproved: schema.companies.reactivationApproved })
    .from(schema.companies)
    .where(isNull(schema.companies.deletedAt));
  const aliases = await db.select().from(schema.companyAliases);
  const groups = await db.select().from(schema.companyGroups);
  const delivered = new Set((await db.select({ c: schema.deliveries.companyId }).from(schema.deliveries)).map((d) => d.c));
  return {
    identities: rows.map((r) => {
      const g = groups.find((x) => x.id === r.groupId);
      return {
        id: r.id, name: r.name, domain: r.domain, kvkNumber: r.kvk, groupId: r.groupId, groupName: g?.name ?? null, groupDomain: g?.primaryDomain ?? null,
        aliases: [...aliases.filter((a) => a.companyId === r.id).map((a) => a.alias), ...(r.trading ? [r.trading] : [])],
        status: r.status, relationship: r.relationship, delivered: delivered.has(r.id), reactivationApproved: r.reactivationApproved,
      };
    }),
  };
}

export async function loadExclusionContext(): Promise<{ rules: ExclusionRule[]; suppressions: SuppressionRecord[]; excludedCategories: string[] }> {
  const db = getDb();
  const rules = (await db.select().from(schema.exclusions).where(eq(schema.exclusions.active, true))) as ExclusionRule[];
  const suppressions = (await db.select().from(schema.suppressions)) as SuppressionRecord[];
  const settings = await getSettings();
  return { rules, suppressions, excludedCategories: settings.icp.excludedCategories };
}

export async function checkExclusions(subject: ExclusionSubject): Promise<ExclusionResult> {
  const ctx = await loadExclusionContext();
  return evaluateExclusions(subject, ctx.rules, ctx.suppressions, ctx.excludedCategories);
}

export type RegisterOutcome =
  | { status: "new"; companyId: string }
  | { status: "reused"; companyId: string }
  | { status: "duplicate"; matchedId?: string; reason: string }
  | { status: "excluded"; companyId: string; reasons: string[] };

const REUSABLE = new Set(["candidate", "needs_research", "researched"]);

/**
 * Register a discovered candidate for a run: deduplicate against the permanent
 * database (KvK, domain, parent group, aliases, fuzzy names), enforce
 * exclusions/suppressions, then create or reuse the company record.
 */
export async function registerCandidate(runId: string, input: CandidateInput, index: IdentityIndex): Promise<RegisterOutcome> {
  const db = getDb();
  const domain = canonicalDomain(input.website ?? null);
  const dup = findDuplicate({ name: input.name, domain }, index.identities);
  if (dup) {
    const existing = index.identities.find((i) => i.id === dup.matchedId);
    const already = existing ? await db.select().from(schema.runCandidates).where(and(eq(schema.runCandidates.runId, runId), eq(schema.runCandidates.companyId, existing.id!))) : [];
    if (existing && REUSABLE.has(existing.status) && existing.relationship === "none" && (!existing.delivered || existing.reactivationApproved) && !already.length) {
      await db.insert(schema.runCandidates).values({ runId, companyId: existing.id!, hunter: input.discoveredBy, checkpoint: { reused: true } }).onConflictDoNothing();
      return { status: "reused", companyId: existing.id! };
    }
    return { status: "duplicate", matchedId: dup.matchedId, reason: `${dup.reason} (${dup.matchedName})` };
  }

  const ex = await checkExclusions({ name: input.name, domain });
  const [company] = await db
    .insert(schema.companies)
    .values({
      officialName: input.name.trim().slice(0, 200), normalizedName: normalizeCompanyName(input.name), website: input.website ?? null,
      canonicalDomain: domain, nlOfficeCity: input.city ?? null, employeeCount: null,
      status: ex.excluded ? "excluded" : "candidate", relationship: ex.suppressed ? "opted_out" : "none",
      contactEligibility: ex.suppressed ? "suppressed" : "unknown", discoveredBy: input.discoveredBy, discoveredRunId: runId,
    })
    .onConflictDoNothing()
    .returning({ id: schema.companies.id });
  if (!company) return { status: "duplicate", reason: "domain/kvk unique constraint" };
  if (domain) await db.insert(schema.domains).values({ domain, companyId: company.id, isPrimary: true }).onConflictDoNothing();
  if (input.sourceId) await db.update(schema.researchSources).set({ companyId: company.id }).where(and(eq(schema.researchSources.id, input.sourceId), isNull(schema.researchSources.companyId)));
  index.identities.push({ id: company.id, name: input.name, domain, status: ex.excluded ? "excluded" : "candidate", relationship: "none", delivered: false, reactivationApproved: false, aliases: [] });
  if (ex.excluded) return { status: "excluded", companyId: company.id, reasons: ex.reasons.map((r) => r.reason) };
  await db.insert(schema.runCandidates).values({ runId, companyId: company.id, hunter: input.discoveredBy, checkpoint: { estimatedEmployees: input.estimatedEmployees ?? null, rationale: input.rationale ?? null } }).onConflictDoNothing();
  return { status: "new", companyId: company.id };
}

export async function runCandidateCounts(runId: string) {
  const rows = await getDb().select({ status: schema.runCandidates.status }).from(schema.runCandidates).where(eq(schema.runCandidates.runId, runId));
  const c: Record<string, number> = {};
  for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
  return c;
}

export async function openCandidateCount(runId: string) {
  const rows = await getDb().select({ id: schema.runCandidates.id }).from(schema.runCandidates).where(and(eq(schema.runCandidates.runId, runId), inArray(schema.runCandidates.status, ["pending", "in_progress"])));
  return rows.length;
}
