import { and, eq, desc, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db/client";
import { getSettings, type Settings } from "@/lib/settings";
import { BudgetExceededError } from "@/lib/budget";
import { audit } from "@/lib/audit";
import { runAgent, AgentError } from "@/agents/runtime";
import * as S from "@/agents/schemas";
import { ResearchService } from "@/research/service";
import { canonicalDomain, normalizeCompanyName, normalizePhoneNL, employeeEstimate } from "@/domain/normalize";
import { classifyDns, summarizeEvidence, validateAgentClaim, type MsTech, type EvidenceClass } from "@/domain/msEvidence";
import { scoreCompany, DEFAULT_SCORING, type ScoringConfig, type ScoringInput } from "@/domain/scoring";
import { recommendService } from "@/domain/services";
import { evaluateEligibility } from "@/domain/eligibility";
import { findDuplicate } from "@/domain/dedup";
import { effectiveIndustryTiers } from "@/lib/analytics";
import { buildDossier } from "./dossier";
import { checkExclusions, loadIdentityIndex, openCandidateCount } from "./candidates";
import { buildCapabilities } from "./capabilities";
import { bumpStat, getRun, heartbeat, pauseRun } from "./runs";
import { getQueue, JOBS } from "./queue";

export const STAGES = ["discovered", "enrich", "microsoft", "signals", "qualify", "qa", "eligibility", "done"] as const;
type Stage = (typeof STAGES)[number];

class StopCandidate extends Error {
  constructor(public outcome: string, public companyStatus: "rejected" | "excluded" | "needs_research" | "qualified") {
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

// ───────────────────────────── stage: enrich ─────────────────────────────
async function stageEnrich(runId: string, companyId: string, research: ResearchService, settings: Settings) {
  const db = getDb();
  const [c] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
  const fresh = c.lastResearchedAt && Date.now() - c.lastResearchedAt.getTime() < settings.research.factReuseDays * 86400000;
  if (fresh && c.industryId && (c.employeeCount || c.employeeMin)) {
    await bumpStat(runId, "reusedResearch");
    return; // research reuse: facts still within reuse window
  }
  const known = await buildDossier(companyId, false);
  const { output: out } = await runAgent<typeof S.EnrichOutput>("company_research_specialist", "enrich_company", {
    companyId, name: c.officialName, website: c.website, knownFacts: known ? { facts: known.facts.slice(0, 20), company: known.company } : null, depth: settings.research.depth,
  }, { runId, companyId, research, capabilities: buildCapabilities() });

  const srcs = await sourcesById([out.employeeSourceId, out.phoneSourceId, out.legalFormSourceId, ...out.facts.map((f) => f.sourceId), ...out.decisionMakerRoles.map((d) => d.sourceId)]);
  const valid = (id: string | null) => (id && srcs.has(id) ? id : null);

  // Phone must be the public number found verbatim in a stored source.
  let phone: string | null = null;
  let phoneSourceId: string | null = null;
  const normPhone = normalizePhoneNL(out.phone);
  if (normPhone && out.phoneSourceId && srcs.has(out.phoneSourceId) && phoneInSource(normPhone, srcs.get(out.phoneSourceId)!.excerpt)) {
    phone = normPhone;
    phoneSourceId = out.phoneSourceId;
  }
  const employeeSourceId = valid(out.employeeSourceId);
  const hasEmployees = employeeSourceId != null;

  const tiers = await effectiveIndustryTiers();
  const industryId = tiers.get(out.industryCode)?.id ?? null;
  let groupId: string | null = c.groupId;
  if (out.groupName && normalizeCompanyName(out.groupName) !== normalizeCompanyName(out.officialName)) {
    const gNorm = normalizeCompanyName(out.groupName);
    const [g] = await db.select().from(schema.companyGroups).where(eq(schema.companyGroups.normalizedName, gNorm));
    groupId = g?.id ?? (await db.insert(schema.companyGroups).values({ name: out.groupName, normalizedName: gNorm, primaryDomain: canonicalDomain(out.groupDomain), hqCountry: out.groupHqCountry, itPurchasingLocation: out.purchasingAuthority === "abroad_central" ? "abroad" : out.purchasingAuthority === "unknown" ? "unknown" : "NL" }).returning({ id: schema.companyGroups.id }))[0].id;
  }
  const website = out.website ?? c.website;
  const domain = canonicalDomain(website) ?? c.canonicalDomain;
  // Domain change may collide with an existing record → duplicate.
  if (domain && domain !== c.canonicalDomain) {
    const [clash] = await db.select({ id: schema.companies.id, name: schema.companies.officialName }).from(schema.companies).where(and(eq(schema.companies.canonicalDomain, domain), ne(schema.companies.id, companyId), isNull(schema.companies.deletedAt)));
    if (clash) throw new StopCandidate(`Duplicaat van ${clash.name} (domein ${domain})`, "rejected");
  }

  await db.update(schema.companies).set({
    officialName: out.officialName || c.officialName, normalizedName: normalizeCompanyName(out.officialName || c.officialName), tradingName: out.tradingName,
    website, canonicalDomain: domain, industryId, subIndustry: out.subIndustry, hqCity: out.hqCity, hqCountry: out.hqCountry, nlOfficeCity: out.nlOfficeCity ?? c.nlOfficeCity,
    employeeCount: hasEmployees ? out.employeeCount : null, employeeMin: hasEmployees ? out.employeeMin : null, employeeMax: hasEmployees ? out.employeeMax : null, employeeSourceId,
    groupId, legalForm: valid(out.legalFormSourceId) ? out.legalForm : null, kvkNumber: out.kvkNumber && valid(out.legalFormSourceId) ? out.kvkNumber : c.kvkNumber,
    phonePublic: phone, phoneSourceId, purchasingAuthority: out.purchasingAuthority, status: "researching", lastResearchedAt: new Date(), updatedAt: new Date(),
  }).where(eq(schema.companies.id, companyId));

  if (out.tradingName && normalizeCompanyName(out.tradingName) !== normalizeCompanyName(out.officialName))
    await db.insert(schema.companyAliases).values({ companyId, alias: out.tradingName, normalizedAlias: normalizeCompanyName(out.tradingName) });
  if (domain) await db.insert(schema.domains).values({ domain, companyId, isPrimary: true }).onConflictDoNothing();

  // Facts with provenance; unsourced facts are stored with confidence 0 and flagged.
  const factRows = out.facts.map((f) => ({ companyId, field: f.field, value: { v: f.value }, sourceId: valid(f.sourceId), confidence: valid(f.sourceId) ? f.confidence : 0, recordedBy: "company_research_specialist", expiresAt: new Date(Date.now() + settings.research.factReuseDays * 86400000) }));
  factRows.push({ companyId, field: "field_confidence", value: { v: JSON.stringify({ ...out.fieldConfidence, phone: phone ? out.fieldConfidence.phone : 0, employees: hasEmployees ? out.fieldConfidence.employees : 0 }) }, sourceId: null, confidence: 1, recordedBy: "system", expiresAt: new Date(Date.now() + settings.research.factReuseDays * 86400000) });
  factRows.push({ companyId, field: "compliance", value: { v: JSON.stringify(out.compliance) }, sourceId: null, confidence: 1, recordedBy: "company_research_specialist", expiresAt: new Date(Date.now() + settings.research.factReuseDays * 86400000) });
  factRows.push({ companyId, field: "business_category", value: { v: out.businessCategory }, sourceId: null, confidence: 1, recordedBy: "company_research_specialist", expiresAt: new Date(Date.now() + settings.research.factReuseDays * 86400000) });
  if (out.injectionAttemptsObserved.length) factRows.push({ companyId, field: "injection_attempts", value: { v: out.injectionAttemptsObserved.join(" | ") }, sourceId: null, confidence: 1, recordedBy: "system", expiresAt: new Date(Date.now() + 365 * 86400000) });
  await db.insert(schema.companyFacts).values(factRows);

  const retention = new Date(Date.now() + settings.retention.contactRetentionDays * 86400000).toISOString().slice(0, 10);
  for (const d of out.decisionMakerRoles) {
    await db.insert(schema.contacts).values({ companyId, roleTitle: d.roleTitle, roleCategory: d.roleCategory, fullName: valid(d.sourceId) ? d.fullName : null, sourceId: valid(d.sourceId), retentionUntil: retention });
  }

  // Re-check exclusions now that category / sector / group are known.
  const [g] = groupId ? await db.select().from(schema.companyGroups).where(eq(schema.companyGroups.id, groupId)) : [];
  const delivered = (await db.select().from(schema.deliveries).where(eq(schema.deliveries.companyId, companyId))).length > 0;
  const [fresh2] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
  const ex = await checkExclusions({
    companyId, name: fresh2.officialName, tradingName: fresh2.tradingName, domain: fresh2.canonicalDomain, kvkNumber: fresh2.kvkNumber, groupName: g?.name, groupDomain: g?.primaryDomain,
    industryCode: out.industryCode, businessCategory: out.businessCategory, phone, relationship: fresh2.relationship, previouslyDelivered: delivered, reactivationApproved: fresh2.reactivationApproved,
  });
  if (ex.excluded) throw new StopCandidate(`Uitgesloten: ${ex.reasons.map((r) => r.reason).join("; ")}`, "excluded");

  // Parent/subsidiary duplication against the rest of the database.
  const idx = await loadIdentityIndex();
  const dup = findDuplicate({ id: companyId, name: fresh2.officialName, domain: fresh2.canonicalDomain, kvkNumber: fresh2.kvkNumber, groupId, groupName: g?.name, groupDomain: g?.primaryDomain }, idx.identities.filter((i) => i.id !== companyId && i.status !== "excluded"));
  if (dup && dup.reason !== "fuzzy_name") throw new StopCandidate(`Duplicaat (${dup.reason}) van ${dup.matchedName}`, "rejected");

  // Early ICP size gate saves research cost.
  const est = employeeEstimate(fresh2);
  if (est != null && (est < settings.icp.minEmployees || est > settings.icp.maxEmployees * 2)) throw new StopCandidate(`Buiten ICP-omvang (${est} medewerkers)`, "rejected");
  if (out.purchasingAuthority === "abroad_central") throw new StopCandidate("IT-inkoop gecentraliseerd in het buitenland", "rejected");
}

// ───────────────────────────── stage: microsoft ─────────────────────────────
async function stageMicrosoft(runId: string, companyId: string, research: ResearchService) {
  const db = getDb();
  const [c] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
  let dnsFindings: unknown = { note: "Geen domein bekend — DNS-analyse niet mogelijk" };
  if (c.canonicalDomain) {
    try {
      const { sourceId, snapshot } = await research.dns(c.canonicalDomain);
      const items = classifyDns(snapshot);
      for (const it of items) await db.insert(schema.technologyEvidence).values({ companyId, technology: it.technology, classification: it.classification, evidenceType: it.evidenceType, detail: it.detail, sourceId, recordedBy: "system:dns-classifier", runId });
      dnsFindings = { mx: snapshot.mx, classifications: items, summary: summarizeEvidence(items) };
    } catch (e) {
      dnsFindings = { error: `DNS-lookup mislukt: ${e instanceof Error ? e.message : e}` };
    }
  }
  const { output } = await runAgent<typeof S.MicrosoftOutput>("microsoft_intelligence_specialist", "assess_microsoft", { companyId, name: c.officialName, domain: c.canonicalDomain, dnsFindings }, { runId, companyId, research });
  const srcs = await sourcesById(output.claims.map((x) => x.sourceId));
  for (const claim of output.claims) {
    const src = claim.sourceId ? srcs.get(claim.sourceId) ?? null : null;
    const v = validateAgentClaim({ ...claim, technology: claim.technology as MsTech, classification: claim.classification as EvidenceClass }, src);
    if (!v || v.classification === "unknown") continue;
    await db.insert(schema.technologyEvidence).values({ companyId, technology: v.technology, classification: v.classification, evidenceType: v.evidenceType, detail: v.detail.slice(0, 500), sourceId: v.sourceId ?? null, recordedBy: "microsoft_intelligence_specialist", runId });
  }
}

// ───────────────────────────── stage: signals ─────────────────────────────
async function stageSignals(runId: string, companyId: string, research: ResearchService) {
  const db = getDb();
  const [c] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
  const { output } = await runAgent<typeof S.SignalsOutput>("buying_signal_analyst", "find_signals", { companyId, name: c.officialName, domain: c.canonicalDomain, industry: c.subIndustry }, { runId, companyId, research });
  const srcs = await sourcesById(output.signals.map((s) => s.sourceId));
  for (const s of output.signals) {
    if (!srcs.has(s.sourceId)) continue; // every signal must have a stored source
    await db.insert(schema.buyingSignals).values({ companyId, signalType: s.signalType, title: s.title, explanation: s.explanation, relevance: s.relevance, commercialAssessment: s.commercialAssessment, signalDate: s.signalDate, sourceId: s.sourceId, recordedBy: "buying_signal_analyst", runId });
  }
}

// ───────────────────────────── scoring input from DB ─────────────────────────────
export async function scoringInputFromDb(companyId: string): Promise<{ input: ScoringInput; signalTypes: string[]; compliance: ScoringInput["compliance"]; msSummary: Record<MsTech, EvidenceClass> }> {
  const db = getDb();
  const [c] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
  const tech = await db.select().from(schema.technologyEvidence).where(eq(schema.technologyEvidence.companyId, companyId));
  const signals = await db.select().from(schema.buyingSignals).where(eq(schema.buyingSignals.companyId, companyId));
  const facts = await db.select().from(schema.companyFacts).where(eq(schema.companyFacts.companyId, companyId)).orderBy(desc(schema.companyFacts.observedAt));
  const sources = await db.select({ id: schema.researchSources.id, type: schema.researchSources.sourceType, url: schema.researchSources.url }).from(schema.researchSources).where(eq(schema.researchSources.companyId, companyId));
  const fact = (f: string) => facts.find((x) => x.field === f)?.value as { v?: string } | undefined;
  const parse = <T>(f: string, fb: T): T => {
    try {
      const v = fact(f)?.v;
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
  const msConfidence = Math.max(0, ...tech.map((t) => ({ confirmed: 1, strongly_indicated: 0.8, weakly_indicated: 0.4, contradicted: 0.8, unknown: 0 })[t.classification]));
  const oldest = facts.filter((f) => f.sourceId).reduce((m, f) => Math.max(m, (Date.now() - f.observedAt.getTime()) / 86400000), 0);
  const distinctHosts = new Set(sources.filter((s) => s.type !== "dns").map((s) => { try { return new URL(s.url).hostname; } catch { return s.url; } })).size;
  const input: ScoringInput = {
    msEvidence: msSummary,
    employees: employeeEstimate(c),
    industryTier: ind ? tiers.get(ind.code)?.tier ?? ind.priorityTier : null,
    compliance: { ...compliance, nis2: compliance.nis2 ?? null, dora: compliance.dora || ind?.doraApplicable || false },
    purchasingAuthority: c.purchasingAuthority,
    signals: signals.map((s) => ({ relevance: s.relevance as "high" | "medium" | "low", signalDate: s.signalDate, hasSource: Boolean(s.sourceId) })),
    fieldConfidence: {
      employees: c.employeeSourceId ? fc.employees ?? 0.6 : 0, industry: fc.industry ?? (ind ? 0.6 : 0), headquarters: fc.headquarters ?? 0,
      microsoft: msConfidence, authority: c.purchasingAuthority !== "unknown" ? fc.authority ?? 0.5 : 0, phone: c.phonePublic ? fc.phone ?? 0.8 : 0, legalForm: c.legalForm ? fc.legalForm ?? 0.7 : 0,
    },
    oldestFactAgeDays: oldest,
    sourceCount: distinctHosts,
    hardExclusion: c.contactEligibility === "suppressed" || c.relationship !== "none",
  };
  return { input, signalTypes: signals.map((s) => s.signalType), compliance: input.compliance, msSummary };
}

// ───────────────────────────── stage: qualify ─────────────────────────────
async function stageQualify(runId: string, companyId: string, research: ResearchService) {
  const db = getDb();
  const { id: cfgId, cfg } = await activeScoringConfig();
  const { input, signalTypes, compliance, msSummary } = await scoringInputFromDb(companyId);
  const score = scoreCompany(input, cfg);
  const rule = recommendService({ msEvidence: msSummary, compliance, signalTypes, employees: input.employees });
  const dossier = await buildDossier(companyId, false);
  const { output: q } = await runAgent<typeof S.QualifyOutput>("lead_qualification_specialist", "qualify", { companyId, dossier, computedScore: score, ruleBasedService: rule.service }, { runId, companyId, research, capabilities: buildCapabilities() });
  const service = q.recommendedService;
  const [row] = await db.insert(schema.qualificationScores).values({
    companyId, scoringConfigId: cfgId, runId, fitScore: score.fitScore, confidenceScore: score.confidenceScore, components: score.components, classification: score.classification,
    recommendedService: service, rationale: `${q.rationale}${service !== rule.service ? `\n[Afwijking van regel-dienst ${rule.service}: ${q.serviceReason}]` : ""}`,
    missingInformation: [...score.missingInformation, ...q.researchGaps].slice(0, 15), hardFailures: score.hardFailures, createdBy: "lead_qualification_specialist",
  }).returning({ id: schema.qualificationScores.id });
  await db.update(schema.companies).set({ latestScoreId: row.id, fitScore: score.fitScore, confidenceScore: score.confidenceScore, classification: score.classification, recommendedService: service, status: "researched", updatedAt: new Date() }).where(eq(schema.companies.id, companyId));
  if (score.classification === "reject") throw new StopCandidate(`Score ${score.fitScore}: ${score.hardFailures.join("; ") || "onder drempel"}`, "rejected");
  if (score.classification === "requires_research") throw new StopCandidate(`Score ${score.fitScore}/betrouwbaarheid ${score.confidenceScore}: aanvullend onderzoek nodig`, "needs_research");
}

// ───────────────────────────── stage: QA ─────────────────────────────
export async function deterministicQaChecks(companyId: string) {
  const db = getDb();
  const d = await buildDossier(companyId, true);
  if (!d) throw new Error("Dossier ontbreekt");
  const srcMap = new Map(d.sources.map((s) => [s.id, s]));
  const officialSite = d.sources.some((s) => s.type === "official_site" && d.company.domain && s.url.includes(d.company.domain));
  const phoneSrc = d.company.phoneSourceId ? srcMap.get(d.company.phoneSourceId) : undefined;
  const [fullPhoneSrc] = d.company.phoneSourceId ? await db.select().from(schema.researchSources).where(eq(schema.researchSources.id, d.company.phoneSourceId)) : [];
  const idx = await loadIdentityIndex();
  const dup = findDuplicate({ id: companyId, name: d.company.officialName, domain: d.company.domain, kvkNumber: d.company.kvkNumber }, idx.identities.filter((i) => i.id !== companyId && ["qualified", "approved", "exported"].includes(i.status)));
  const ex = await checkExclusions({ companyId, name: d.company.officialName, tradingName: d.company.tradingName, domain: d.company.domain, kvkNumber: d.company.kvkNumber, groupName: d.group?.name, groupDomain: d.group?.domain, industryCode: d.company.industry?.code, relationship: d.company.relationship });
  const checks = {
    allReferencedSourcesExist: { pass: d.missingSourceReferences.length === 0, note: d.missingSourceReferences.length ? `${d.missingSourceReferences.length} verwijzingen naar onbekende bronnen` : "ok" },
    officialWebsiteRetrieved: { pass: officialSite, note: officialSite ? "officiële website opgehaald" : "officiële website niet opgehaald" },
    phoneFoundInSource: { pass: d.company.phone ? Boolean(phoneSrc && fullPhoneSrc && phoneInSource(d.company.phone, fullPhoneSrc.excerpt)) : null, note: d.company.phone ? "nummer gecontroleerd tegen bron" : "geen nummer" },
    employeeEstimateSourced: { pass: d.company.employees.sourceId ? srcMap.has(d.company.employees.sourceId) : false, note: d.company.employees.sourceId ? "bron aanwezig" : "geen bron voor medewerkers" },
    noDuplicateQualified: { pass: !dup || dup.reason === "fuzzy_name", note: dup ? `${dup.reason}: ${dup.matchedName}` : "geen duplicaat" },
    exclusionsClear: { pass: !ex.excluded, note: ex.excluded ? ex.reasons.map((r) => r.reason).join("; ") : "geen uitsluitingen" },
  };
  const critical = ["allReferencedSourcesExist", "officialWebsiteRetrieved", "noDuplicateQualified", "exclusionsClear"] as const;
  const hardFail = critical.some((k) => checks[k].pass === false) || checks.phoneFoundInSource.pass === false;
  return { dossier: d, checks, hardFail };
}

async function stageQa(runId: string, companyId: string, research: ResearchService) {
  const db = getDb();
  const det = await deterministicQaChecks(companyId);
  let verdict: "approved" | "rejected" | "needs_research";
  let issues: string[] = [];
  let agentChecks: unknown = null;
  // QA Director runs on its own model tier with a dossier that excludes other agents' sales rationale.
  const { output: qa } = await runAgent<typeof S.QaOutput>("quality_assurance_director", "review", { companyId, dossier: det.dossier, deterministicChecks: det.checks }, { runId, companyId, research, capabilities: buildCapabilities() });
  agentChecks = qa.checks;
  verdict = qa.verdict;
  issues = qa.issues;
  if (qa.hallucinationSuspected) verdict = "rejected";
  if (det.hardFail) {
    verdict = det.checks.exclusionsClear.pass === false || det.checks.noDuplicateQualified.pass === false ? "rejected" : verdict === "approved" ? "needs_research" : verdict;
    issues = [...issues, ...Object.entries(det.checks).filter(([, v]) => v.pass === false).map(([k, v]) => `[code] ${k}: ${v.note}`)];
  }
  await db.insert(schema.qaReviews).values({ companyId, runId, verdict, checks: { deterministic: det.checks, agent: agentChecks }, issues, reviewer: "quality_assurance_director" });
  if (verdict === "rejected") throw new StopCandidate(`QA-veto: ${issues.slice(0, 3).join("; ")}`, "rejected");
  if (verdict === "needs_research") throw new StopCandidate(`QA: aanvullend onderzoek nodig — ${issues.slice(0, 3).join("; ")}`, "needs_research");
}

// ───────────────────────────── stage: eligibility ─────────────────────────────
async function stageEligibility(companyId: string, settings: Settings) {
  const db = getDb();
  const [c] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
  const ex = await checkExclusions({ companyId, name: c.officialName, domain: c.canonicalDomain, kvkNumber: c.kvkNumber, phone: c.phonePublic });
  const r = evaluateEligibility({ legalForm: c.legalForm, phone: c.phonePublic, suppressed: ex.suppressed }, settings.eligibility);
  await db.update(schema.companies).set({ contactEligibility: r.status, eligibilityReason: r.reasons.join(" | "), eligibilityCheckedAt: new Date(), updatedAt: new Date() }).where(eq(schema.companies.id, companyId));
  if (r.status !== "eligible") throw new StopCandidate(`Contactgeschiktheid: ${r.status} — ${r.reasons[0]}`, r.status === "suppressed" ? "excluded" : "needs_research");
  if (!r.exportablePhone) throw new StopCandidate("Geen exporteerbaar openbaar bedrijfsnummer", "needs_research");
}

// ───────────────────────────── driver ─────────────────────────────
/**
 * Process one candidate through all stages, checkpointing after each stage.
 * Safe to call repeatedly (idempotent per stage): a retried or resumed job
 * continues from the last completed stage.
 */
export async function processCandidate(runId: string, companyId: string): Promise<void> {
  const db = getDb();
  const run = await getRun(runId);
  if (!run || run.status === "cancelled" || run.status === "completed" || run.status === "failed") return;
  if (run.status === "paused") return; // stays pending; resume re-enqueues
  const [rc] = await db.select().from(schema.runCandidates).where(and(eq(schema.runCandidates.runId, runId), eq(schema.runCandidates.companyId, companyId)));
  if (!rc || ["done", "rejected", "skipped"].includes(rc.status)) return;
  await db.update(schema.runCandidates).set({ status: "in_progress", attempts: rc.attempts + 1, updatedAt: new Date() }).where(eq(schema.runCandidates.id, rc.id));
  const settings = await getSettings();
  const research = await ResearchService.create({ runId, companyId });
  let stageIdx = STAGES.indexOf(rc.stage as Stage);
  if (stageIdx < 0) stageIdx = 0;

  const setStage = (s: Stage) => db.update(schema.runCandidates).set({ stage: s, updatedAt: new Date() }).where(eq(schema.runCandidates.id, rc.id));
  try {
    for (let i = stageIdx + 1; i < STAGES.length; i++) {
      const stage = STAGES[i];
      const current = await getRun(runId);
      if (!current || current.status !== "running") {
        await db.update(schema.runCandidates).set({ status: "pending" }).where(eq(schema.runCandidates.id, rc.id));
        return;
      }
      await heartbeat(runId);
      if (stage === "enrich") await stageEnrich(runId, companyId, research, settings);
      else if (stage === "microsoft") await stageMicrosoft(runId, companyId, research);
      else if (stage === "signals") await stageSignals(runId, companyId, research);
      else if (stage === "qualify") await stageQualify(runId, companyId, research);
      else if (stage === "qa") await stageQa(runId, companyId, research);
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
      await db.update(schema.companies).set({ status: err.companyStatus, updatedAt: new Date() }).where(eq(schema.companies.id, companyId));
      await db.update(schema.runCandidates).set({ status: err.companyStatus === "needs_research" ? "skipped" : "rejected", outcome: err.outcome.slice(0, 1000), updatedAt: new Date() }).where(eq(schema.runCandidates.id, rc.id));
      await bumpStat(runId, err.companyStatus);
    } else if (err instanceof BudgetExceededError) {
      await db.update(schema.runCandidates).set({ status: "pending", lastError: err.message }).where(eq(schema.runCandidates.id, rc.id));
      await pauseRun(runId, "system:budget", err.message);
      return;
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof AgentError ? err.retryable : true;
      if (retryable && rc.attempts + 1 < 3) {
        await db.update(schema.runCandidates).set({ status: "pending", lastError: msg.slice(0, 1000) }).where(eq(schema.runCandidates.id, rc.id));
        throw err; // pg-boss retries with backoff
      }
      await db.update(schema.runCandidates).set({ status: "failed", lastError: msg.slice(0, 1000), updatedAt: new Date() }).where(eq(schema.runCandidates.id, rc.id));
      await bumpStat(runId, "failed");
      await audit({ actorType: "system", action: "candidate.failed", entityType: "company", entityId: companyId, details: { runId, error: msg.slice(0, 500) } });
    }
  }
  if ((await openCandidateCount(runId)) === 0) await (await getQueue()).send(JOBS.finalize, { runId }, { singletonKey: `${runId}:finalize` });
}
