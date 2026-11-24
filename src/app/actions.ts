"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { getCurrentUser } from "@/lib/auth/current";
import { hasRole, type Role } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { createRun, pauseRun, resumeRun, cancelRun, requeuePending } from "@/pipeline/runs";
import { approveList, decideItem, overrideQa } from "@/lib/lists";
import { updateSetting, SettingsSchema, type SettingsKey } from "@/lib/settings";
import { normalizeExclusionValue } from "@/domain/exclusion";
import { canonicalDomain, normalizeCompanyName } from "@/domain/normalize";
import { ScoringWeightsSchema, ScoringThresholdsSchema, ScoringRulesSchema } from "@/domain/scoring";
import { postChatMessage } from "@/pipeline/chat";
import { AGENT_IDS } from "@/agents/types";
import { importRelationships } from "@/lib/relationshipImport";

async function requireActionUser(role: Role) {
  const u = await getCurrentUser();
  if (!u) throw new Error("Niet ingelogd");
  if (!hasRole(u, role)) throw new Error("Onvoldoende rechten");
  return u;
}
const actor = (u: { sub: string }) => `user:${u.sub}`;

export async function startRunAction(fd: FormData) {
  const u = await requireActionUser("analyst");
  const p = z.object({
    kind: z.enum(["manual", "sector", "company"]),
    target: z.coerce.number().int().min(1).max(300),
    industries: z.array(z.string()).optional(),
    minEmployees: z.coerce.number().int().min(1).optional().or(z.literal("").transform(() => undefined)),
    maxEmployees: z.coerce.number().int().max(100000).optional().or(z.literal("").transform(() => undefined)),
    companyName: z.string().max(200).optional(),
    companyWebsite: z.string().max(300).optional(),
    depth: z.enum(["light", "standard", "deep"]),
    budgetEur: z.coerce.number().min(0).max(10000),
    instructions: z.string().max(1500).optional(),
  }).parse({
    kind: fd.get("kind"), target: fd.get("target"), industries: fd.getAll("industries").map(String), minEmployees: fd.get("minEmployees") ?? undefined, maxEmployees: fd.get("maxEmployees") ?? undefined,
    companyName: (fd.get("companyName") as string) || undefined, companyWebsite: (fd.get("companyWebsite") as string) || undefined, depth: fd.get("depth"), budgetEur: fd.get("budgetEur"), instructions: (fd.get("instructions") as string) || undefined,
  });
  if (p.kind === "company" && !p.companyName) throw new Error("Bedrijfsnaam is verplicht voor bedrijfsonderzoek");
  const r = await createRun(p.kind, { target: p.kind === "company" ? 1 : p.target, industries: p.industries?.length ? p.industries : undefined, minEmployees: p.minEmployees, maxEmployees: p.maxEmployees, companyName: p.companyName, companyWebsite: p.companyWebsite, depth: p.depth, instructions: p.instructions }, actor(u), p.budgetEur);
  redirect(`/research/${r.runId}`);
}

export async function runControlAction(runId: string, action: "pause" | "resume" | "cancel" | "retry") {
  const u = await requireActionUser("analyst");
  if (action === "pause") await pauseRun(runId, actor(u));
  if (action === "resume") await resumeRun(runId, actor(u));
  if (action === "cancel") await cancelRun(runId, actor(u));
  if (action === "retry") {
    await requeuePending(runId, true);
    await audit({ actorType: "user", actorId: u.sub, action: "run.retry_failed", entityType: "research_run", entityId: runId });
  }
  revalidatePath(`/research/${runId}`);
  revalidatePath("/research");
}

export async function decideItemAction(listId: string, itemId: string, status: "approved" | "rejected", reason?: string) {
  const u = await requireActionUser("analyst");
  await decideItem(itemId, status, actor(u), reason);
  revalidatePath(`/lists/${listId}`);
}

export async function approveListAction(listId: string, approvePending: boolean) {
  const u = await requireActionUser("analyst");
  await approveList(listId, actor(u), approvePending);
  revalidatePath(`/lists/${listId}`);
}

export async function overrideQaAction(reviewId: string, companyId: string, fd: FormData) {
  const u = await requireActionUser("admin");
  await overrideQa(reviewId, actor(u), String(fd.get("reason") ?? ""));
  revalidatePath(`/prospects/${companyId}`);
}

export async function updateSettingsAction(key: SettingsKey, fd: FormData) {
  const u = await requireActionUser("admin");
  let value: unknown;
  try {
    value = JSON.parse(String(fd.get("json") ?? "{}"));
  } catch {
    throw new Error("Ongeldige JSON");
  }
  if (!(key in SettingsSchema.shape)) throw new Error("Onbekende instelling");
  await updateSetting(key, value, actor(u));
  await audit({ actorType: "user", actorId: u.sub, action: "settings.updated", entityType: "setting", entityId: key });
  revalidatePath("/settings");
}

export async function addExclusionAction(fd: FormData) {
  const u = await requireActionUser("admin");
  const p = z.object({ scope: z.enum(["company", "domain", "parent_company", "legal_entity", "sector", "name"]), value: z.string().min(2).max(200), category: z.string().min(2).max(40), reason: z.string().min(3).max(300) })
    .parse({ scope: fd.get("scope"), value: fd.get("value"), category: fd.get("category"), reason: fd.get("reason") });
  const [row] = await getDb().insert(schema.exclusions).values({ ...p, normalizedValue: normalizeExclusionValue(p.scope, p.value), createdBy: actor(u), permanent: p.category === "competitor" }).returning();
  await audit({ actorType: "user", actorId: u.sub, action: "exclusion.added", entityType: "exclusion", entityId: row.id, details: p });
  revalidatePath("/settings");
}

export async function toggleExclusionAction(id: string, active: boolean) {
  const u = await requireActionUser("admin");
  const [ex] = await getDb().select().from(schema.exclusions).where(eq(schema.exclusions.id, id));
  if (ex?.permanent && !active) throw new Error("Permanente uitsluitingen kunnen niet worden gedeactiveerd");
  await getDb().update(schema.exclusions).set({ active }).where(eq(schema.exclusions.id, id));
  await audit({ actorType: "user", actorId: u.sub, action: active ? "exclusion.activated" : "exclusion.deactivated", entityType: "exclusion", entityId: id });
  revalidatePath("/settings");
}

export async function addSuppressionAction(fd: FormData) {
  const u = await requireActionUser("analyst");
  const type = z.enum(["domain", "kvk", "name", "phone"]).parse(fd.get("identifierType"));
  const raw = z.string().min(2).max(200).parse(fd.get("identifierValue"));
  const value = type === "domain" ? canonicalDomain(raw) ?? raw : type === "name" ? normalizeCompanyName(raw) : raw.replace(/\s/g, "");
  await getDb().insert(schema.suppressions).values({ identifierType: type, identifierValue: value, reason: "opt_out", source: actor(u) }).onConflictDoNothing();
  await audit({ actorType: "user", actorId: u.sub, action: "suppression.added", entityType: "suppression", details: { type } });
  revalidatePath("/settings");
}

export async function createScoringVersionAction(fd: FormData) {
  const u = await requireActionUser("admin");
  const weights = ScoringWeightsSchema.parse(JSON.parse(String(fd.get("weights"))));
  const thresholds = ScoringThresholdsSchema.parse(JSON.parse(String(fd.get("thresholds"))));
  const rules = ScoringRulesSchema.parse(JSON.parse(String(fd.get("rules"))));
  const db = getDb();
  const versions = await db.select({ v: schema.scoringConfigs.version }).from(schema.scoringConfigs);
  const version = Math.max(0, ...versions.map((v) => v.v)) + 1;
  await db.update(schema.scoringConfigs).set({ active: false });
  await db.insert(schema.scoringConfigs).values({ version, weights, thresholds, rules, active: true, notes: String(fd.get("notes") ?? "").slice(0, 500), createdBy: actor(u), approvedBy: actor(u) });
  await audit({ actorType: "user", actorId: u.sub, action: "scoring.version_created", details: { version } });
  revalidatePath("/settings");
}

export async function decideRecommendationAction(id: string, decision: "approved" | "rejected") {
  const u = await requireActionUser("admin");
  const db = getDb();
  const [rec] = await db.select().from(schema.recommendations).where(eq(schema.recommendations.id, id));
  if (!rec) throw new Error("Niet gevonden");
  await db.update(schema.recommendations).set({ status: decision === "approved" && rec.proposedChange ? "applied" : decision, decidedBy: actor(u) }).where(eq(schema.recommendations.id, id));
  // Approved industry-priority changes become base tier changes (human-approved).
  const change = rec.proposedChange as { industry?: string; priorityTier?: number } | null;
  if (decision === "approved" && change?.industry && change.priorityTier != null) {
    await db.update(schema.industries).set({ priorityTier: change.priorityTier }).where(eq(schema.industries.code, change.industry));
  }
  await audit({ actorType: "user", actorId: u.sub, action: `recommendation.${decision}`, entityType: "recommendation", entityId: id });
  revalidatePath("/market");
  revalidatePath("/settings");
}

export async function setUserRoleAction(userId: string, fd: FormData) {
  const u = await requireActionUser("admin");
  const role = z.enum(["admin", "analyst", "viewer"]).parse(fd.get("role"));
  const active = fd.get("active") === "on";
  if (userId === u.sub && (role !== "admin" || !active)) throw new Error("U kunt uw eigen beheerdersrechten niet intrekken");
  await getDb().update(schema.users).set({ role, active }).where(eq(schema.users.id, userId));
  await audit({ actorType: "user", actorId: u.sub, action: "user.updated", entityType: "user", entityId: userId, details: { role, active } });
  revalidatePath("/settings");
}

export async function reactivateCompanyAction(companyId: string, fd: FormData) {
  const u = await requireActionUser("admin");
  const reason = z.string().min(10).max(500).parse(fd.get("reason"));
  const [c] = await getDb().select().from(schema.companies).where(eq(schema.companies.id, companyId));
  if (c.contactEligibility === "suppressed" || c.relationship === "opted_out") throw new Error("Opt-out kan niet worden gereactiveerd");
  await getDb().update(schema.companies).set({ reactivationApproved: true, status: "candidate", relationship: c.relationship === "rejected" ? "none" : c.relationship }).where(eq(schema.companies.id, companyId));
  await audit({ actorType: "user", actorId: u.sub, action: "company.reactivated", entityType: "company", entityId: companyId, details: { reason } });
  revalidatePath(`/prospects/${companyId}`);
}

export async function setRelationshipAction(companyId: string, fd: FormData) {
  const u = await requireActionUser("analyst");
  const rel = z.enum(["none", "customer", "active_opportunity", "prior_prospect", "rejected"]).parse(fd.get("relationship"));
  await getDb().update(schema.companies).set({ relationship: rel }).where(eq(schema.companies.id, companyId));
  await audit({ actorType: "user", actorId: u.sub, action: "company.relationship", entityType: "company", entityId: companyId, details: { rel } });
  revalidatePath(`/prospects/${companyId}`);
}

/** GDPR erasure: remove personal data and research content; keep minimal suppression if opted out. */
export async function eraseCompanyAction(companyId: string) {
  const u = await requireActionUser("admin");
  const db = getDb();
  await db.delete(schema.contacts).where(eq(schema.contacts.companyId, companyId));
  await db.update(schema.researchSources).set({ excerpt: null }).where(eq(schema.researchSources.companyId, companyId));
  await db.update(schema.companies).set({ deletedAt: new Date(), phonePublic: null }).where(eq(schema.companies.id, companyId));
  await audit({ actorType: "user", actorId: u.sub, action: "company.erased", entityType: "company", entityId: companyId });
  redirect("/prospects");
}

export async function setIndustryPoolAction(industryId: number, fd: FormData) {
  const u = await requireActionUser("admin");
  const size = fd.get("size") ? z.coerce.number().int().min(0).max(100000).parse(fd.get("size")) : null;
  const source = z.string().max(300).parse(fd.get("source") ?? "");
  await getDb().update(schema.industries).set({ estimatedPoolSize: size, poolEstimateSource: source || null }).where(eq(schema.industries.id, industryId));
  await audit({ actorType: "user", actorId: u.sub, action: "industry.pool_updated", entityType: "industry", entityId: String(industryId), details: { size, source } });
  revalidatePath("/market");
}

export async function sendChatAction(threadId: string, agentId: string, message: string) {
  const u = await requireActionUser("viewer");
  const id = z.enum(AGENT_IDS).parse(agentId);
  const text = z.string().min(1).max(8000).parse(message);
  await postChatMessage({ threadId: z.string().uuid().parse(threadId), agentId: id, userId: u.sub, userRole: u.role, message: text });
}

export async function importRelationshipsAction(fd: FormData) {
  const u = await requireActionUser("admin");
  const file = fd.get("file");
  if (!(file instanceof File)) throw new Error("Geen bestand");
  const kind = z.enum(["customer", "active_opportunity", "prior_prospect", "rejected"]).parse(fd.get("kind"));
  const res = await importRelationships(Buffer.from(await file.arrayBuffer()), file.name, kind, actor(u));
  await audit({ actorType: "user", actorId: u.sub, action: "relationships.imported", details: { kind, ...res } });
  revalidatePath("/settings");
  revalidatePath("/prospects");
}

export async function setIndustryTierAction(industryId: number, fd: FormData) {
  const u = await requireActionUser("admin");
  const tier = z.coerce.number().int().min(1).max(4).parse(fd.get("tier"));
  const [ind] = await getDb().select().from(schema.industries).where(eq(schema.industries.id, industryId));
  if (!ind || ind.priorityTier === 0) throw new Error("Uitgesloten sectoren kunnen hier niet worden gewijzigd");
  await getDb().update(schema.industries).set({ priorityTier: tier }).where(eq(schema.industries.id, industryId));
  await audit({ actorType: "user", actorId: u.sub, action: "industry.tier_updated", entityType: "industry", entityId: String(industryId), details: { tier } });
  revalidatePath("/settings");
}
