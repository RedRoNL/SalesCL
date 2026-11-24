import { and, eq, desc, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db/client";
import { getSettings, type Settings } from "@/lib/settings";
import { BudgetExceededError } from "@/lib/budget";
import { audit } from "@/lib/audit";
import { runAgent, AgentError } from "@/agents/runtime";
import { modelAvailable } from "@/agents/model";
import { AwaitingExecutor } from "@/agents/executor";
import * as S from "@/agents/schemas";
import { ResearchService } from "@/research/service";
import { extractDeterministic, quoteFound, NON_COMPANY_DOMAINS, type DeterministicProfile, type ExtractPage, focusExcerpt } from "@/research/extract";
import { canonicalDomain, normalizeCompanyName, normalizePhoneNL, normalizeLegalForm, employeeEstimate } from "@/domain/normalize";
import { classifyDns, summarizeEvidence, technologyConfidence, validateAgentClaim, CLASS_RANK, type MsTech, type EvidenceClass } from "@/domain/msEvidence";
import { scoreCompany, potentialScore, templateRationale, DEFAULT_SCORING, type ScoringConfig, type ScoringInput } from "@/domain/scoring";
import { recommendService, SERVICE_LABELS } from "@/domain/services";
import { evaluateEligibility } from "@/domain/eligibility";
import { nameSimilarity } from "@/domain/dedup";
import { effectiveIndustryTiers } from "@/lib/analytics";
import { buildDossier } from "./dossier";
import { checkExclusions, openCandidateCount, qualifiedCount } from "./candidates";
import { findExistingCompany, addIdentifiers } from "./identity";
import { buildCapabilities } from "./capabilities";
import { bumpStat, getRun, heartbeat, pauseRun } from "./runs";
import { getQueue, JOBS } from "./queue";

/**
 * Progressive research funnel (v2). Cost rises with each stage; candidates leave as early as possible.
 *   screen      free: own-site crawl, passive DNS, regex extraction, phone/KvK dedup, early gates
 *   extract     one cheap model call (no tools) over pages already retrieved; quotes verified by code
 *   deep        dynamic: KvK lookup (€0.02) → gap-filling agent → Microsoft specialist (only if needed)
 *   signals     dynamic: only for candidates with high preliminary fit; then deterministic final score
 *   qa          independent QA agent, only for exceptional/strong
 *   eligibility deterministic contact eligibility
 */
export const STAGES = ["discovered", "screen", "extract", "deep", "signals", "qa", "eligibility", "done"] as const;
type Stage = (typeof STAGES)[number];

export interface SizeBounds {
  min: number;
  max: number;
}
/** Run-level size bounds (pilots: 300–5,000) or the ICP defaults (hard ceiling = 2× ICP max). */
export function sizeBounds(params: { minEmployees?: number; maxEmployees?: number }, settings: Settings): SizeBounds {
  return { min: params.minEmployees ?? settings.icp.minEmployees, max: params.maxEmployees ?? settings.icp.maxEmployees * 2 };
}

export class StopCandidate extends Error {
  constructor(public outcome: string, public companyStatus: "rejected" | "excluded" | "needs_research" | "qualified" | "candidate") {
    super(outcome);
  }
}

async function activeScoringConfig(): Promise<{ id: string | null; cfg: ScoringConfig }> {
  const [row] = await getDb().select().from(schema.scoringConfigs).where(eq(schema.scoringConfigs.active, true)).orderBy(desc(schema.scoringConfigs.version)).limit(1);
  if (!row) return { id: null, cfg: DEFAULT_SCORING };
  return { id: row.id, cfg: { weights: row.weights, thresholds: row.thresholds, rules: row.rules } as ScoringConfig };
}

async function sourcesById(ids: (string | null | undefined)[]) {
  const clean = [...new Set(ids.filter(Boolean) as string[])].filter((id) => z.string().uuid().safeParse(id).success);
  if (!clean.length) return new Map<string, typeof schema.researchSources.$inferSelect>();
  const rows = await getDb().select().from(schema.researchSources).where(inArray(schema.researchSources.id, clean));
  return new Map(rows.map((r) => [r.id, r]));
}

const digits = (s: string) => s.replace(/\D/g, "");
/** Does the phone number appear in the stored source excerpt? (accepts 0xx and +31xx forms) */
export function phoneInSource(phone: string, excerpt: string | null | undefined): boolean {
  if (!excerpt) return false;
  const d = digits(phone).replace(/^31/, "");
  const ex = digits(excerpt);
  return ex.includes("0" + d) || ex.includes("31" + d);
}

const factExpiry = (s: Settings) => new Date(Date.now() + s.research.factReuseDays * 86400000);

async function getCompany(companyId: string) {
  const [c] = await getDb().select().from(schema.companies).where(eq(schema.companies.id, companyId));
  return c;
}

async function latestJsonFact(companyId: string, field: string): Promise<Record<string, unknown>> {
  const [prev] = await getDb().select().from(schema.companyFacts).where(and(eq(schema.companyFacts.companyId, companyId), eq(schema.companyFacts.field, field))).orderBy(desc(schema.companyFacts.observedAt)).limit(1);
  try {
    return prev ? JSON.parse((prev.value as { v: string }).v) : {};
  } catch {
    return {};
  }
}

async function upsertFieldConfidence(companyId: string, patch: Record<string, number | null>, settings: Settings) {
  const merged = (await latestJsonFact(companyId, "field_confidence")) as Record<string, number | null>;
  for (const [k, v] of Object.entries(patch)) if (v != null && (merged[k] == null || v > (merged[k] ?? 0))) merged[k] = v;
  await getDb().insert(schema.companyFacts).values({ companyId, field: "field_confidence", value: { v: JSON.stringify(merged) }, confidence: 1, recordedBy: "system", expiresAt: factExpiry(settings) });
}

async function upsertCompliance(companyId: string, patch: Record<string, unknown>, settings: Settings) {
  const merged = await latestJsonFact(companyId, "compliance");
  for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null && v !== false) merged[k] = v;
  await getDb().insert(schema.companyFacts).values({ companyId, field: "compliance", value: { v: JSON.stringify(merged) }, confidence: 1, recordedBy: "system", expiresAt: factExpiry(settings) });
}

// ───────────────────────────── stage: screen (free) ─────────────────────────────
async function resolveWebsite(name: string, research: ResearchService, ctx?: { runId: string; companyId: string; city: string | null }): Promise<string | null> {
  if (!research.availability.search && ctx) {
    // Claude Subscription Mode: the session finds and verifies the website with native search + fetch_page.
    const { output } = await runAgent<typeof S.FindWebsiteOutput>("company_research_specialist", "find_website", { companyId: ctx.companyId, name, city: ctx.city }, { runId: ctx.runId, companyId: ctx.companyId, research });
    if (!output.website || output.confidence === "low" || !output.sourceId) return null;
    const [src] = await getDb().select().from(schema.researchSources).where(eq(schema.researchSources.id, output.sourceId));
    return src && canonicalDomain(src.url) === canonicalDomain(output.website) ? `https://${canonicalDomain(output.website)}` : null;
  }
  try {
    const results = await research.search(`${name} officiële website`, 6);
    const tokens = normalizeCompanyName(name).split(" ").filter((t) => t.length > 2);
    for (const r of results) {
      const d = canonicalDomain(r.url);
      if (!d || NON_COMPANY_DOMAINS.has(d)) continue;
      const label = d.split(".")[0].replace(/-/g, "");
      if (tokens.some((t) => label.includes(t)) || nameSimilarity(r.title, name) > 0.8) return `https://${d}`;
    }
  } catch {
    /* no search provider → stays unknown */
  }
  return null;
}

async function stageScreen(runId: string, companyId: string, research: ResearchService, settings: Settings, bounds: SizeBounds) {
  const db = getDb();
  let c = await getCompany(companyId);
  const fresh = c.researchTier && c.lastResearchedAt && Date.now() - c.lastResearchedAt.getTime() < settings.research.factReuseDays * 86400000;
  if (fresh) {
    await bumpStat(runId, "reusedResearch");
    return { pages: null as ExtractPage[] | null, det: null as DeterministicProfile | null };
  }
  if (!c.website) {
    const site = await resolveWebsite(c.officialName, research, { runId, companyId, city: c.nlOfficeCity });
    if (!site) throw new StopCandidate("Geen officiële website gevonden", "needs_research");
    const d = canonicalDomain(site);
    const dup = await findExistingCompany({ name: c.officialName, domain: d, excludeCompanyId: companyId });
    if (dup && dup.reason !== "fuzzy_name") throw new StopCandidate(`Duplicaat (${dup.reason}) van ${dup.matchedName}`, "rejected");
    const clash = d ? await db.select({ id: schema.companies.id }).from(schema.companies).where(and(eq(schema.companies.canonicalDomain, d), ne(schema.companies.id, companyId))) : [];
    if (clash.length) throw new StopCandidate("Duplicaat (domein)", "rejected");
    await db.update(schema.companies).set({ website: site, canonicalDomain: d }).where(eq(schema.companies.id, companyId));
    c = await getCompany(companyId);
  }

  let pages: ExtractPage[];
  try {
    pages = await research.crawlSite(c.website!);
  } catch (e) {
    if (e instanceof BudgetExceededError) throw e;
    throw new StopCandidate(`Website niet bereikbaar of geblokkeerd: ${e instanceof Error ? e.message : e}`.slice(0, 300), "needs_research");
  }
  const det = extractDeterministic(pages);

  const dnsItems: { technology: MsTech; classification: EvidenceClass }[] = [];
  if (c.canonicalDomain) {
    try {
      const { sourceId, snapshot } = await research.dns(c.canonicalDomain);
      for (const it of classifyDns(snapshot)) {
        dnsItems.push(it);
        await db.insert(schema.technologyEvidence).values({ companyId, technology: it.technology, classification: it.classification, evidenceType: it.evidenceType, detail: it.detail, sourceId, recordedBy: "system:dns-classifier", runId });
      }
    } catch {}
  }
  for (const m of det.msMentions) {
    await db.insert(schema.technologyEvidence).values({ companyId, technology: m.value, classification: m.classification, evidenceType: m.evidenceType, detail: `"${m.quote.slice(0, 300)}"`, sourceId: m.sourceId, recordedBy: "system:website-scan", runId });
  }
  for (const v of det.securityVacancies.slice(0, 2)) {
    await db.insert(schema.buyingSignals).values({ companyId, signalType: "security_vacancy", title: `Vacature: ${v.value}`, explanation: v.quote.slice(0, 500), relevance: /ciso|security|informatiebeveiliging/i.test(v.value) ? "high" : "medium", commercialAssessment: "Werving voor IT-/securityrol: capaciteitsvraag die Protect 365 kan invullen", signalDate: null, sourceId: v.sourceId, recordedBy: "system:website-scan", runId });
  }

  const phone = det.bestPhone?.value ?? null;
  const kvk = det.bestKvk?.value ?? null;
  if (phone || kvk) {
    const dup = await findExistingCompany({ name: c.officialName, domain: c.canonicalDomain, phone, kvkNumber: kvk, excludeCompanyId: companyId });
    if (dup && ["kvk", "phone", "domain"].includes(dup.reason)) throw new StopCandidate(`Duplicaat (${dup.reason}) van ${dup.matchedName}`, "rejected");
  }
  const kvkClash = kvk ? await db.select({ id: schema.companies.id }).from(schema.companies).where(and(eq(schema.companies.kvkNumber, kvk), ne(schema.companies.id, companyId))) : [];
  await db.update(schema.companies).set({
    phonePublic: c.phonePublic ?? phone, phoneSourceId: c.phoneSourceId ?? det.bestPhone?.sourceId ?? null,
    kvkNumber: c.kvkNumber ?? (kvkClash.length ? null : kvk), legalForm: c.legalForm ?? det.bestLegalForm?.value ?? null,
    employeeCount: c.employeeCount ?? det.bestEmployees?.value ?? null, employeeSourceId: c.employeeSourceId ?? det.bestEmployees?.sourceId ?? null,
    researchTier: "screened", lastResearchedAt: new Date(), status: "researching", updatedAt: new Date(),
  }).where(eq(schema.companies.id, companyId));
  await addIdentifiers(companyId, { phones: [phone], kvk, domains: [c.canonicalDomain] }, "research");
  const facts = [
    ...(det.bestPhone ? [{ field: "phone", v: det.bestPhone.value, f: det.bestPhone, conf: det.bestPhone.pageKind === "contact" ? 0.9 : 0.75 }] : []),
    ...(det.bestKvk ? [{ field: "kvk_number", v: det.bestKvk.value, f: det.bestKvk, conf: 0.9 }] : []),
    ...(det.bestLegalForm ? [{ field: "legal_form", v: det.bestLegalForm.value, f: det.bestLegalForm, conf: 0.75 }] : []),
    ...(det.bestEmployees ? [{ field: "employees", v: String(det.bestEmployees.value), f: det.bestEmployees, conf: 0.6 }] : []),
    ...det.certifications.map((x) => ({ field: "certification", v: x.value, f: x, conf: 0.8 })),
  ];
  if (facts.length) await db.insert(schema.companyFacts).values(facts.map((x) => ({ companyId, field: x.field, value: { v: x.v, quote: x.f.quote }, sourceId: x.f.sourceId, confidence: x.conf, recordedBy: "system:website-scan", expiresAt: factExpiry(settings) })));
  await upsertFieldConfidence(companyId, { phone: det.bestPhone ? 0.85 : null, legalForm: det.bestLegalForm ? 0.7 : null, employees: det.bestEmployees ? 0.55 : null }, settings);
  const certs = det.certifications.map((x) => x.value);
  await upsertCompliance(companyId, { certificationsOrRegulator: certs.length > 0, sensitiveData: certs.some((x) => /NEN7510|27701/.test(x)), dora: certs.includes("DORA") }, settings);

  // Early, free gates.
  const summary = summarizeEvidence(dnsItems);
  if (summary.microsoft_365 === "contradicted" && !det.msMentions.some((m) => m.classification === "strongly_indicated")) throw new StopCandidate("Geen Microsoft-omgeving: mail via Google Workspace en geen Microsoft-vermeldingen", "rejected");
  const est = det.bestEmployees?.value ?? null;
  if (est != null && est < Math.min(bounds.min, settings.icp.minEmployees) && det.bestEmployees!.pageKind !== "news") throw new StopCandidate(`Te klein (${est} medewerkers volgens eigen website)`, "rejected");
  return { pages, det };
}

// ───────────────────────────── stage: extract (one cheap call) ─────────────────────────────
async function stageExtract(runId: string, companyId: string, research: ResearchService, settings: Settings, screen: { pages: ExtractPage[] | null; det: DeterministicProfile | null }, bounds: SizeBounds) {
  const db = getDb();
  const c = await getCompany(companyId);
  if (!screen.pages && (c.researchTier === "extracted" || c.researchTier === "deep")) return; // reused, still fresh
  const pages = screen.pages ?? (await db.select().from(schema.researchSources).where(and(eq(schema.researchSources.companyId, companyId), inArray(schema.researchSources.sourceType, ["official_site", "vacancy"]))).limit(6)).map((s) => ({ sourceId: s.id, url: s.url, kind: "other" as const, text: s.excerpt ?? "" }));
  if (!pages.length) throw new StopCandidate("Geen opgehaalde pagina's om te analyseren", "needs_research");
  const srcMap = await sourcesById(pages.map((p) => p.sourceId));
  const textOf = (id: string) => srcMap.get(id)?.excerpt ?? pages.find((p) => p.sourceId === id)?.text ?? "";
  const tiers = await effectiveIndustryTiers();
  const [hint] = c.industryId ? await db.select().from(schema.industries).where(eq(schema.industries.id, c.industryId)) : [];
  const det = screen.det;
  const { output: o } = await runAgent<typeof S.ExtractProfileOutput>("company_research_specialist", "extract_profile", {
    companyId, name: c.officialName, domain: c.canonicalDomain, industryHint: hint?.code ?? null,
    deterministic: det ? { phone: det.bestPhone?.value, kvk: det.bestKvk?.value, legalForm: det.bestLegalForm?.value, employees: det.bestEmployees ? { value: det.bestEmployees.value, quote: det.bestEmployees.quote, sourceId: det.bestEmployees.sourceId } : null } : null,
    pages: pages.slice(0, 6).map((p) => ({ sourceId: p.sourceId, kind: p.kind, url: p.url, content: focusExcerpt(textOf(p.sourceId), 3500) })),
  }, { runId, companyId, research });

  // Code-side verification: every quoted field must literally occur in its source.
  const ok = (q: { sourceId: string; quote: string } | null | undefined): q is { sourceId: string; quote: string } => Boolean(q && srcMap.has(q.sourceId) && quoteFound(textOf(q.sourceId), q.quote));
  const employees = o.employees && ok(o.employees) ? o.employees : null;
  const legal = o.legalForm && ok(o.legalForm) ? normalizeLegalForm(o.legalForm.value) ?? o.legalForm.value.toLowerCase() : null;
  const kvk = o.kvkNumber && ok(o.kvkNumber) ? o.kvkNumber.value : null;
  const group = o.group && ok(o.group) ? o.group : null;
  const authority = o.purchasingAuthority !== "unknown" && o.purchasingAuthorityQuote && pages.some((p) => quoteFound(textOf(p.sourceId), o.purchasingAuthorityQuote!)) ? o.purchasingAuthority : c.purchasingAuthority ?? "unknown";
  const industryId = tiers.get(o.industryCode)?.id ?? c.industryId;

  let groupId = c.groupId;
  if (group && normalizeCompanyName(group.name) !== normalizeCompanyName(o.officialName)) {
    const gNorm = normalizeCompanyName(group.name);
    const [g] = await db.select().from(schema.companyGroups).where(eq(schema.companyGroups.normalizedName, gNorm));
    groupId = g?.id ?? (await db.insert(schema.companyGroups).values({ name: group.name, normalizedName: gNorm, primaryDomain: canonicalDomain(group.domain), hqCountry: group.hqCountry, itPurchasingLocation: authority === "abroad_central" ? "abroad" : authority === "unknown" ? "unknown" : "NL" }).returning({ id: schema.companyGroups.id }))[0].id;
  }
  const kvkClash = kvk && !c.kvkNumber ? await db.select({ id: schema.companies.id }).from(schema.companies).where(and(eq(schema.companies.kvkNumber, kvk), ne(schema.companies.id, companyId))) : [];
  if (kvkClash.length) throw new StopCandidate("Duplicaat (KvK-nummer al bekend)", "rejected");
  await db.update(schema.companies).set({
    officialName: o.officialName || c.officialName, normalizedName: normalizeCompanyName(o.officialName || c.officialName), tradingName: o.tradingName, industryId, subIndustry: o.subIndustry,
    hqCity: o.hqCity, hqCountry: o.hqCountry, groupId, purchasingAuthority: authority,
    employeeCount: employees ? employees.count : c.employeeCount, employeeMin: employees ? employees.min : c.employeeMin, employeeMax: employees ? employees.max : c.employeeMax, employeeSourceId: employees ? employees.sourceId : c.employeeSourceId,
    legalForm: c.legalForm ?? legal, kvkNumber: c.kvkNumber ?? kvk, researchTier: "extracted", updatedAt: new Date(),
  }).where(eq(schema.companies.id, companyId));
  if (o.tradingName && normalizeCompanyName(o.tradingName) !== normalizeCompanyName(o.officialName)) await db.insert(schema.companyAliases).values({ companyId, alias: o.tradingName, normalizedAlias: normalizeCompanyName(o.tradingName) });
  await addIdentifiers(companyId, { names: [o.officialName, o.tradingName], kvk }, "research");
  if (kvk || legal) await db.insert(schema.legalEntities).values({ companyId, name: o.officialName, normalizedName: normalizeCompanyName(o.officialName), kvkNumber: kvk, legalForm: legal, sourceId: o.kvkNumber?.sourceId ?? o.legalForm?.sourceId ?? null });

  for (const m of o.msClaims) {
    if (!ok(m)) continue;
    const src = srcMap.get(m.sourceId)!;
    const v = validateAgentClaim({ technology: m.technology as MsTech, classification: m.classification, evidenceType: src.sourceType === "vacancy" ? "vacancy" : "website", detail: `"${m.quote}"`, sourceId: m.sourceId, quote: m.quote }, { sourceType: src.sourceType, excerpt: src.excerpt });
    if (v && v.classification !== "unknown") await db.insert(schema.technologyEvidence).values({ companyId, technology: v.technology, classification: v.classification, evidenceType: v.evidenceType, detail: v.detail.slice(0, 500), sourceId: v.sourceId ?? null, recordedBy: "company_research_specialist", runId });
  }
  for (const s of o.signals) if (ok(s)) await db.insert(schema.buyingSignals).values({ companyId, signalType: s.signalType, title: s.title, explanation: s.explanation, relevance: s.relevance, commercialAssessment: s.explanation, signalDate: s.signalDate, sourceId: s.sourceId, recordedBy: "company_research_specialist", runId });
  const retention = new Date(Date.now() + settings.retention.contactRetentionDays * 86400000).toISOString().slice(0, 10);
  for (const d of o.decisionMakerRoles) if (ok(d)) await db.insert(schema.contacts).values({ companyId, roleTitle: d.roleTitle, roleCategory: d.roleCategory, fullName: d.fullName, sourceId: d.sourceId, retentionUntil: retention });
  if (o.injectionAttemptsObserved.length) await db.insert(schema.companyFacts).values({ companyId, field: "injection_attempts", value: { v: o.injectionAttemptsObserved.join(" | ") }, confidence: 1, recordedBy: "system", expiresAt: new Date(Date.now() + 365 * 86400000) });
  await db.insert(schema.companyFacts).values({ companyId, field: "business_category", value: { v: o.businessCategory }, confidence: 0.8, recordedBy: "company_research_specialist", expiresAt: factExpiry(settings) });
  await upsertFieldConfidence(companyId, { employees: employees ? 0.8 : null, industry: 0.75, headquarters: o.hqCity ? 0.7 : null, authority: authority !== "unknown" ? 0.65 : null, legalForm: legal ? 0.75 : null }, settings);
  await upsertCompliance(companyId, { ...o.compliance }, settings);

  const after = await getCompany(companyId);
  const [g] = groupId ? await db.select().from(schema.companyGroups).where(eq(schema.companyGroups.id, groupId)) : [];
  const delivered = (await db.select({ id: schema.deliveries.id }).from(schema.deliveries).where(eq(schema.deliveries.companyId, companyId))).length > 0;
  const ex = await checkExclusions({ companyId, name: after.officialName, tradingName: after.tradingName, domain: after.canonicalDomain, kvkNumber: after.kvkNumber, groupName: g?.name, groupDomain: g?.primaryDomain, industryCode: o.industryCode, businessCategory: o.businessCategory, phone: after.phonePublic, relationship: after.relationship, previouslyDelivered: delivered, reactivationApproved: after.reactivationApproved });
  if (ex.excluded) throw new StopCandidate(`Uitgesloten: ${ex.reasons.map((r) => r.reason).join("; ")}`, "excluded");
  if (groupId) {
    const dup = await findExistingCompany({ name: after.officialName, domain: after.canonicalDomain, kvkNumber: after.kvkNumber, groupName: g?.name, groupDomain: g?.primaryDomain, excludeCompanyId: companyId });
    if (dup && dup.reason !== "fuzzy_name") throw new StopCandidate(`Duplicaat (${dup.reason}) van ${dup.matchedName}`, "rejected");
  }
  const est = employeeEstimate(after);
  if (est != null && (est < bounds.min || est > bounds.max)) throw new StopCandidate(`Buiten omvang voor deze run (${est} medewerkers; ${bounds.min}–${bounds.max})`, "rejected");
  if (authority === "abroad_central") throw new StopCandidate("IT-inkoop gecentraliseerd in het buitenland", "rejected");
}

// ───────────────────────────── scoring input (deterministic) ─────────────────────────────
export async function scoringInputFromDb(companyId: string) {
  const db = getDb();
  const c = await getCompany(companyId);
  const tech = await db.select().from(schema.technologyEvidence).where(eq(schema.technologyEvidence.companyId, companyId));
  const signals = await db.select().from(schema.buyingSignals).where(eq(schema.buyingSignals.companyId, companyId));
  const facts = await db.select().from(schema.companyFacts).where(eq(schema.companyFacts.companyId, companyId)).orderBy(desc(schema.companyFacts.observedAt));
  const sources = await db.select({ type: schema.researchSources.sourceType, url: schema.researchSources.url }).from(schema.researchSources).where(eq(schema.researchSources.companyId, companyId));
  const parse = <T>(f: string, fb: T): T => {
    try {
      const v = (facts.find((x) => x.field === f)?.value as { v?: string } | undefined)?.v;
      return v ? (JSON.parse(v) as T) : fb;
    } catch {
      return fb;
    }
  };
  const fc = parse<Record<string, number | null>>("field_confidence", {});
  const compliance = parse<ScoringInput["compliance"]>("compliance", {});
  const tiers = await effectiveIndustryTiers();
  const [ind] = c.industryId ? await db.select().from(schema.industries).where(eq(schema.industries.id, c.industryId)) : [];
  const msSummary = summarizeEvidence(tech);
  const techConf = technologyConfidence(tech);
  const m365Conf = Math.max(techConf.microsoft_365.confidence, techConf.exchange_online.confidence);
  const oldest = facts.filter((f) => f.sourceId).reduce((m, f) => Math.max(m, (Date.now() - f.observedAt.getTime()) / 86400000), 0);
  const hosts = new Set(sources.filter((s) => s.type !== "dns" && s.type !== "registry").map((s) => { try { return new URL(s.url).hostname.replace(/^www\./, ""); } catch { return s.url; } }));
  // DNS and the register are independent of the website → count as distinct evidence origins.
  const origins = hosts.size + (sources.some((s) => s.type === "dns") ? 1 : 0) + (sources.some((s) => s.type === "registry") ? 1 : 0);
  const input: ScoringInput = {
    msEvidence: msSummary,
    employees: employeeEstimate(c),
    industryTier: ind ? tiers.get(ind.code)?.tier ?? ind.priorityTier : null,
    compliance: { ...compliance, nis2: compliance.nis2 ?? (ind?.nis2Sector as "essential" | "important" | null) ?? null, dora: Boolean(compliance.dora || ind?.doraApplicable) },
    purchasingAuthority: c.purchasingAuthority,
    signals: signals.map((s) => ({ relevance: s.relevance as "high" | "medium" | "low", signalDate: s.signalDate, hasSource: Boolean(s.sourceId) })),
    fieldConfidence: {
      employees: c.employeeSourceId ? fc.employees ?? 0.6 : 0, industry: fc.industry ?? (ind ? 0.5 : 0), headquarters: fc.headquarters ?? (c.hqCity ? 0.5 : 0),
      microsoft: m365Conf, authority: c.purchasingAuthority && c.purchasingAuthority !== "unknown" ? fc.authority ?? 0.5 : 0, phone: c.phonePublic && c.phoneSourceId ? fc.phone ?? 0.8 : 0, legalForm: c.legalForm ? fc.legalForm ?? 0.7 : 0,
    },
    oldestFactAgeDays: oldest,
    sourceCount: origins,
    hardExclusion: c.contactEligibility === "suppressed" || c.relationship !== "none",
  };
  return { input, signalTypes: signals.map((s) => s.signalType), compliance: input.compliance, msSummary, techConf };
}

// ───────────────────────────── stage: deep (dynamic) ─────────────────────────────
async function stageDeep(runId: string, companyId: string, research: ResearchService, settings: Settings, bounds: SizeBounds) {
  const db = getDb();
  let c = await getCompany(companyId);
  // 1. Licensed register first: cheapest authoritative source for legal form and headcount.
  if (research.registryAvailable && (!c.legalForm || employeeEstimate(c) == null)) {
    try {
      const recs = await research.registry(c.kvkNumber ? { kvkNumber: c.kvkNumber } : { name: c.officialName });
      const rec = recs.find((r) => (c.kvkNumber && r.kvkNumber === c.kvkNumber) || nameSimilarity(r.name, c.officialName) >= 0.85);
      if (rec) {
        await db.update(schema.companies).set({
          kvkNumber: c.kvkNumber ?? rec.kvkNumber, legalForm: c.legalForm ?? normalizeLegalForm(rec.legalForm) ?? rec.legalForm,
          ...(employeeEstimate(c) == null && rec.employees ? { employeeCount: rec.employees, employeeSourceId: rec.sourceId } : {}),
        }).where(eq(schema.companies.id, companyId));
        await addIdentifiers(companyId, { kvk: rec.kvkNumber }, "registry");
        await upsertFieldConfidence(companyId, { legalForm: 0.95, employees: rec.employees ? 0.8 : null }, settings);
        c = await getCompany(companyId);
      }
    } catch (e) {
      if (e instanceof BudgetExceededError) throw e;
    }
  }
  const { cfg } = await activeScoringConfig();
  const { input, techConf } = await scoringInputFromDb(companyId);
  const potential = potentialScore(input, cfg);
  await db.update(schema.companies).set({ screenScore: potential }).where(eq(schema.companies.id, companyId));
  if (potential < Math.max(cfg.thresholds.research, settings.research.minScreenScoreForExtraction)) throw new StopCandidate(`Lage potentie (${potential}) na screening en extractie`, "rejected");

  // 2. Gap-filling agent only for real, critical gaps.
  const gaps: string[] = [];
  if (employeeEstimate(c) == null) gaps.push("employees");
  if (!c.phonePublic) gaps.push("phone");
  if (!c.legalForm) gaps.push("legalForm");
  if (!c.purchasingAuthority || c.purchasingAuthority === "unknown") gaps.push("purchasingAuthority");
  if (gaps.some((g) => g === "employees" || g === "phone" || g === "legalForm")) {
    const known = await db.select({ id: schema.researchSources.id, url: schema.researchSources.url, type: schema.researchSources.sourceType }).from(schema.researchSources).where(eq(schema.researchSources.companyId, companyId)).limit(20);
    const { output: g } = await runAgent<typeof S.GapFillOutput>("company_research_specialist", "deep_research", { companyId, name: c.officialName, website: c.website, gaps, knownSources: known.map((k) => ({ sourceId: k.id, url: k.url, type: k.type })) }, { runId, companyId, research, capabilities: buildCapabilities() });
    const srcs = await sourcesById([g.employees?.sourceId, g.legalForm?.sourceId, g.kvkNumber?.sourceId, g.phone?.sourceId, g.purchasingAuthorityQuote?.sourceId, g.group?.sourceId]);
    const ok = (q: { sourceId: string; quote: string } | null | undefined) => Boolean(q && srcs.has(q.sourceId) && quoteFound(srcs.get(q.sourceId)!.excerpt ?? "", q.quote));
    const phone = g.phone && ok(g.phone) ? normalizePhoneNL(g.phone.value) : null;
    const patch: Partial<typeof schema.companies.$inferInsert> = { researchTier: "deep", updatedAt: new Date() };
    if (gaps.includes("employees") && g.employees && ok(g.employees)) Object.assign(patch, { employeeCount: g.employees.count, employeeMin: g.employees.min, employeeMax: g.employees.max, employeeSourceId: g.employees.sourceId });
    if (gaps.includes("legalForm") && g.legalForm && ok(g.legalForm)) patch.legalForm = normalizeLegalForm(g.legalForm.value) ?? g.legalForm.value.toLowerCase();
    if (!c.kvkNumber && g.kvkNumber && ok(g.kvkNumber)) {
      const clash = await db.select({ id: schema.companies.id }).from(schema.companies).where(and(eq(schema.companies.kvkNumber, g.kvkNumber.value), ne(schema.companies.id, companyId)));
      if (clash.length) throw new StopCandidate("Duplicaat (KvK-nummer al bekend)", "rejected");
      patch.kvkNumber = g.kvkNumber.value;
    }
    if (gaps.includes("phone") && phone && phoneInSource(phone, srcs.get(g.phone!.sourceId)!.excerpt)) Object.assign(patch, { phonePublic: phone, phoneSourceId: g.phone!.sourceId });
    if (gaps.includes("purchasingAuthority") && g.purchasingAuthority !== "unknown" && ok(g.purchasingAuthorityQuote)) patch.purchasingAuthority = g.purchasingAuthority;
    await db.update(schema.companies).set(patch).where(eq(schema.companies.id, companyId));
    await addIdentifiers(companyId, { phones: [patch.phonePublic], kvk: patch.kvkNumber ?? null }, "research");
    await upsertFieldConfidence(companyId, { employees: patch.employeeSourceId ? 0.8 : null, legalForm: patch.legalForm ? 0.75 : null, phone: patch.phonePublic ? 0.8 : null, authority: patch.purchasingAuthority ? 0.7 : null }, settings);
    if (g.purchasingAuthority === "abroad_central" && ok(g.purchasingAuthorityQuote)) throw new StopCandidate("IT-inkoop gecentraliseerd in het buitenland", "rejected");
    c = await getCompany(companyId);
    const est = employeeEstimate(c);
    if (est != null && (est < bounds.min || est > bounds.max)) throw new StopCandidate(`Buiten omvang voor deze run (${est} medewerkers; ${bounds.min}–${bounds.max})`, "rejected");
  }

  // 3. Microsoft specialist only when screening found no strong Microsoft 365 / Exchange Online evidence.
  const m365 = Math.max(CLASS_RANK[techConf.microsoft_365.classification], CLASS_RANK[techConf.exchange_online.classification]);
  if (m365 >= 0 && m365 < 2) {
    const ev = await db.select().from(schema.technologyEvidence).where(eq(schema.technologyEvidence.companyId, companyId));
    const { output } = await runAgent<typeof S.MicrosoftOutput>("microsoft_intelligence_specialist", "assess_microsoft", { companyId, name: c.officialName, domain: c.canonicalDomain, dnsFindings: { evidence: ev.map((e) => ({ technology: e.technology, classification: e.classification, type: e.evidenceType, detail: e.detail })) } }, { runId, companyId, research });
    const srcs = await sourcesById(output.claims.map((x) => x.sourceId));
    for (const claim of output.claims) {
      const src = claim.sourceId ? srcs.get(claim.sourceId) ?? null : null;
      const v = validateAgentClaim({ ...claim, technology: claim.technology as MsTech, classification: claim.classification as EvidenceClass }, src);
      if (!v || v.classification === "unknown") continue;
      await db.insert(schema.technologyEvidence).values({ companyId, technology: v.technology, classification: v.classification, evidenceType: v.evidenceType, detail: v.detail.slice(0, 500), sourceId: v.sourceId ?? null, recordedBy: "microsoft_intelligence_specialist", runId });
    }
  }
}

// ───────────────────────────── stage: signals (dynamic) ─────────────────────────────
async function stageSignals(runId: string, companyId: string, research: ResearchService, settings: Settings) {
  const { cfg } = await activeScoringConfig();
  const { input } = await scoringInputFromDb(companyId);
  const prelim = scoreCompany(input, cfg);
  if (prelim.fitScore < settings.research.signalsMinFit || prelim.hardFailures.length) return; // not worth paying for
  const c = await getCompany(companyId);
  const db = getDb();
  const { output } = await runAgent<typeof S.SignalsOutput>("buying_signal_analyst", "find_signals", { companyId, name: c.officialName, domain: c.canonicalDomain, industry: c.subIndustry }, { runId, companyId, research });
  const srcs = await sourcesById(output.signals.map((s) => s.sourceId));
  for (const s of output.signals) {
    if (!srcs.has(s.sourceId)) continue;
    await db.insert(schema.buyingSignals).values({ companyId, signalType: s.signalType, title: s.title, explanation: s.explanation, relevance: s.relevance, commercialAssessment: s.commercialAssessment, signalDate: s.signalDate, sourceId: s.sourceId, recordedBy: "buying_signal_analyst", runId });
  }
}

// ───────────────────────────── deterministic final score ─────────────────────────────
export async function finalScore(runId: string | null, companyId: string) {
  const db = getDb();
  const { id: cfgId, cfg } = await activeScoringConfig();
  const { input, signalTypes, compliance, msSummary } = await scoringInputFromDb(companyId);
  const score = scoreCompany(input, cfg);
  const rule = recommendService({ msEvidence: msSummary, compliance, signalTypes, employees: input.employees });
  const [row] = await db.insert(schema.qualificationScores).values({
    companyId, scoringConfigId: cfgId, runId, fitScore: score.fitScore, confidenceScore: score.confidenceScore, components: score.components, classification: score.classification,
    recommendedService: rule.service, rationale: templateRationale(score, SERVICE_LABELS[rule.service], rule.reasons),
    missingInformation: score.missingInformation, hardFailures: score.hardFailures, createdBy: "system:scoring",
  }).returning({ id: schema.qualificationScores.id });
  await db.update(schema.companies).set({ latestScoreId: row.id, fitScore: score.fitScore, confidenceScore: score.confidenceScore, classification: score.classification, recommendedService: rule.service, status: "researched", updatedAt: new Date() }).where(eq(schema.companies.id, companyId));
  return score;
}

// ───────────────────────────── stage: QA ─────────────────────────────
export async function deterministicQaChecks(companyId: string) {
  const db = getDb();
  const d = await buildDossier(companyId, true);
  if (!d) throw new Error("Dossier ontbreekt");
  const srcMap = new Map(d.sources.map((s) => [s.id, s]));
  const officialSite = d.sources.some((s) => s.type === "official_site" && d.company.domain && s.url.includes(d.company.domain));
  const [fullPhoneSrc] = d.company.phoneSourceId ? await db.select().from(schema.researchSources).where(eq(schema.researchSources.id, d.company.phoneSourceId)) : [];
  const dup = await findExistingCompany({ name: d.company.officialName, domain: d.company.domain, kvkNumber: d.company.kvkNumber, phone: d.company.phone, groupName: d.group?.name, groupDomain: d.group?.domain, excludeCompanyId: companyId });
  const dupBlocking = Boolean(dup && dup.reason !== "fuzzy_name" && (["qualified", "approved", "exported"].includes(dup.status) || dup.delivered || dup.relationship !== "none"));
  const ex = await checkExclusions({ companyId, name: d.company.officialName, tradingName: d.company.tradingName, domain: d.company.domain, kvkNumber: d.company.kvkNumber, groupName: d.group?.name, groupDomain: d.group?.domain, industryCode: d.company.industry?.code, relationship: d.company.relationship });
  const checks = {
    allReferencedSourcesExist: { pass: d.missingSourceReferences.length === 0, note: d.missingSourceReferences.length ? `${d.missingSourceReferences.length} verwijzingen naar onbekende bronnen` : "ok" },
    officialWebsiteRetrieved: { pass: officialSite, note: officialSite ? "officiële website opgehaald" : "officiële website niet opgehaald" },
    phoneFoundInSource: { pass: d.company.phone ? Boolean(fullPhoneSrc && phoneInSource(d.company.phone, fullPhoneSrc.excerpt)) : null, note: d.company.phone ? "nummer gecontroleerd tegen bron" : "geen nummer" },
    employeeEstimateSourced: { pass: d.company.employees.sourceId ? srcMap.has(d.company.employees.sourceId) : false, note: d.company.employees.sourceId ? "bron aanwezig" : "geen bron voor medewerkers" },
    noDuplicateQualified: { pass: !dupBlocking, note: dup ? `${dup.reason}: ${dup.matchedName}` : "geen duplicaat" },
    exclusionsClear: { pass: !ex.excluded, note: ex.excluded ? ex.reasons.map((r) => r.reason).join("; ") : "geen uitsluitingen" },
  };
  const critical = ["allReferencedSourcesExist", "officialWebsiteRetrieved", "noDuplicateQualified", "exclusionsClear"] as const;
  const hardFail = critical.some((k) => checks[k].pass === false) || checks.phoneFoundInSource.pass === false;
  return { dossier: d, checks, hardFail };
}

async function stageQa(runId: string, companyId: string, research: ResearchService) {
  const db = getDb();
  const det = await deterministicQaChecks(companyId);
  const { output: qa } = await runAgent<typeof S.QaOutput>("quality_assurance_director", "review", { companyId, dossier: det.dossier, deterministicChecks: det.checks }, { runId, companyId, research, capabilities: buildCapabilities() });
  let verdict = qa.verdict;
  let issues = qa.issues;
  if (qa.hallucinationSuspected) verdict = "rejected";
  if (det.hardFail) {
    verdict = det.checks.exclusionsClear.pass === false || det.checks.noDuplicateQualified.pass === false ? "rejected" : verdict === "approved" ? "needs_research" : verdict;
    issues = [...issues, ...Object.entries(det.checks).filter(([, v]) => v.pass === false).map(([k, v]) => `[code] ${k}: ${v.note}`)];
  }
  await db.insert(schema.qaReviews).values({ companyId, runId, verdict, checks: { deterministic: det.checks, agent: qa.checks }, issues, reviewer: "quality_assurance_director" });
  if (verdict === "rejected") throw new StopCandidate(`QA-veto: ${issues.slice(0, 3).join("; ")}`, "rejected");
  if (verdict === "needs_research") throw new StopCandidate(`QA: aanvullend onderzoek nodig — ${issues.slice(0, 3).join("; ")}`, "needs_research");
}

// ───────────────────────────── stage: eligibility ─────────────────────────────
async function stageEligibility(companyId: string, settings: Settings) {
  const db = getDb();
  const c = await getCompany(companyId);
  const ex = await checkExclusions({ companyId, name: c.officialName, domain: c.canonicalDomain, kvkNumber: c.kvkNumber, phone: c.phonePublic });
  const r = evaluateEligibility({ legalForm: c.legalForm, phone: c.phonePublic, suppressed: ex.suppressed }, settings.eligibility);
  await db.update(schema.companies).set({ contactEligibility: r.status, eligibilityReason: r.reasons.join(" | "), eligibilityCheckedAt: new Date(), updatedAt: new Date() }).where(eq(schema.companies.id, companyId));
  if (r.status !== "eligible") throw new StopCandidate(`Contactgeschiktheid: ${r.status} — ${r.reasons[0]}`, r.status === "suppressed" ? "excluded" : "needs_research");
  if (!r.exportablePhone) throw new StopCandidate("Geen exporteerbaar openbaar bedrijfsnummer", "needs_research");
}

// ───────────────────────────── driver ─────────────────────────────
/**
 * Process one candidate through the funnel, checkpointing after each stage. Safe to retry:
 * a resumed job continues from the last completed stage. Once the run has enough qualified
 * prospects, candidates that still need paid research are parked as reserve for a later run.
 */
export async function processCandidate(runId: string, companyId: string): Promise<void> {
  const db = getDb();
  const run = await getRun(runId);
  if (!run || run.status === "cancelled" || run.status === "completed" || run.status === "failed") return;
  if (run.status === "paused") return;
  const [rc] = await db.select().from(schema.runCandidates).where(and(eq(schema.runCandidates.runId, runId), eq(schema.runCandidates.companyId, companyId)));
  if (!rc || ["done", "rejected", "skipped"].includes(rc.status)) return;
  await db.update(schema.runCandidates).set({ status: "in_progress", attempts: rc.attempts + 1, updatedAt: new Date() }).where(eq(schema.runCandidates.id, rc.id));
  const settings = await getSettings();
  const research = await ResearchService.create({ runId, companyId });
  let stageIdx = STAGES.indexOf(rc.stage as Stage);
  if (stageIdx < 0) stageIdx = 0;
  let screen: { pages: ExtractPage[] | null; det: DeterministicProfile | null } = { pages: null, det: null };
  const setStage = (s: Stage) => db.update(schema.runCandidates).set({ stage: s, updatedAt: new Date() }).where(eq(schema.runCandidates.id, rc.id));
  const target = Math.ceil(run.targetProspects * settings.research.targetBufferFactor);
  const bounds = sizeBounds(run.params as { minEmployees?: number; maxEmployees?: number }, settings);
  try {
    for (let i = stageIdx + 1; i < STAGES.length; i++) {
      const stage = STAGES[i];
      const current = await getRun(runId);
      if (!current || current.status !== "running") {
        await db.update(schema.runCandidates).set({ status: "pending" }).where(eq(schema.runCandidates.id, rc.id));
        return;
      }
      await heartbeat(runId);
      if (stage === "deep" && (await qualifiedCount(runId)) >= target) {
        throw new StopCandidate("Reserve: weekdoel bereikt vóór verdiepend onderzoek (wordt in een volgende run hergebruikt)", "candidate");
      }
      if (stage === "screen") {
        screen = await stageScreen(runId, companyId, research, settings, bounds);
      } else if (stage === "extract") {
        if (!(await modelAvailable())) throw new AgentError("AI-uitvoering niet beschikbaar (Paid API Mode zonder goedkeuring of sleutel)", "", false);
        await stageExtract(runId, companyId, research, settings, screen, bounds);
      } else if (stage === "deep") await stageDeep(runId, companyId, research, settings, bounds);
      else if (stage === "signals") {
        await stageSignals(runId, companyId, research, settings);
        const score = await finalScore(runId, companyId);
        if (score.classification === "reject") throw new StopCandidate(`Score ${score.fitScore}: ${score.hardFailures.join("; ") || "onder drempel"}`, "rejected");
        if (score.classification === "requires_research") throw new StopCandidate(`Score ${score.fitScore}/betrouwbaarheid ${score.confidenceScore}: aanvullend onderzoek nodig`, "needs_research");
      } else if (stage === "qa") await stageQa(runId, companyId, research);
      else if (stage === "eligibility") await stageEligibility(companyId, settings);
      else if (stage === "done") {
        await db.update(schema.companies).set({ status: "qualified", updatedAt: new Date() }).where(eq(schema.companies.id, companyId));
        await db.update(schema.runCandidates).set({ status: "done", outcome: "qualified", stage: "done", updatedAt: new Date() }).where(eq(schema.runCandidates.id, rc.id));
        await bumpStat(runId, "qualified");
        break;
      }
      await setStage(stage);
    }
  } catch (err) {
    if (err instanceof StopCandidate) {
      const reserve = err.companyStatus === "candidate";
      await db.update(schema.companies).set({ status: reserve ? "candidate" : err.companyStatus, updatedAt: new Date() }).where(and(eq(schema.companies.id, companyId), isNull(schema.companies.deletedAt)));
      await db.update(schema.runCandidates).set({ status: reserve || err.companyStatus === "needs_research" ? "skipped" : "rejected", outcome: err.outcome.slice(0, 1000), updatedAt: new Date() }).where(eq(schema.runCandidates.id, rc.id));
      await bumpStat(runId, reserve ? "reserve" : err.companyStatus);
    } else if (err instanceof AwaitingExecutor) {
      // Parked for a Claude Code session; the job resumes from this checkpoint once the result is submitted.
      await db.update(schema.runCandidates).set({ status: "pending", lastError: `Wacht op Claude Code: ${err.agentId}/${err.taskType}`, attempts: rc.attempts }).where(eq(schema.runCandidates.id, rc.id));
      return;
    } else if (err instanceof BudgetExceededError) {
      await db.update(schema.runCandidates).set({ status: "pending", lastError: err.message }).where(eq(schema.runCandidates.id, rc.id));
      await pauseRun(runId, "system:budget", err.message);
      return;
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof AgentError ? err.retryable : true;
      if (retryable && rc.attempts + 1 < 3) {
        await db.update(schema.runCandidates).set({ status: "pending", lastError: msg.slice(0, 1000) }).where(eq(schema.runCandidates.id, rc.id));
        throw err;
      }
      await db.update(schema.runCandidates).set({ status: "failed", lastError: msg.slice(0, 1000), updatedAt: new Date() }).where(eq(schema.runCandidates.id, rc.id));
      await bumpStat(runId, "failed");
      await audit({ actorType: "system", action: "candidate.failed", entityType: "company", entityId: companyId, details: { runId, error: msg.slice(0, 500) } });
    }
  }
  const deferred = await db.select({ id: schema.runWork.id }).from(schema.runWork).where(and(eq(schema.runWork.runId, runId), eq(schema.runWork.status, "deferred"))).limit(1);
  if (deferred.length || (await openCandidateCount(runId)) === 0) await (await getQueue()).send(JOBS.finalize, { runId }, { singletonKey: `${runId}:advance` });
}
