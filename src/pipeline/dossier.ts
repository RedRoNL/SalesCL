import { desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { formatProspectId } from "@/domain/normalize";

/**
 * Assemble a company dossier from stored facts and sources. With forQa=true,
 * other agents' commercial rationale and recommendations are withheld so the
 * QA Director judges facts and evidence independently.
 */
export async function buildDossier(companyId: string, forQa = false) {
  const db = getDb();
  const [c] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
  if (!c) return null;
  const [group] = c.groupId ? await db.select().from(schema.companyGroups).where(eq(schema.companyGroups.id, c.groupId)) : [];
  const [industry] = c.industryId ? await db.select().from(schema.industries).where(eq(schema.industries.id, c.industryId)) : [];
  const facts = await db.select().from(schema.companyFacts).where(eq(schema.companyFacts.companyId, companyId)).orderBy(desc(schema.companyFacts.observedAt)).limit(80);
  const tech = await db.select().from(schema.technologyEvidence).where(eq(schema.technologyEvidence.companyId, companyId));
  const signals = await db.select().from(schema.buyingSignals).where(eq(schema.buyingSignals.companyId, companyId));
  const contacts = await db.select().from(schema.contacts).where(eq(schema.contacts.companyId, companyId));
  const sources = await db.select().from(schema.researchSources).where(eq(schema.researchSources.companyId, companyId)).orderBy(desc(schema.researchSources.retrievedAt)).limit(60);
  const aliases = await db.select().from(schema.companyAliases).where(eq(schema.companyAliases.companyId, companyId));
  const [score] = await db.select().from(schema.qualificationScores).where(eq(schema.qualificationScores.companyId, companyId)).orderBy(desc(schema.qualificationScores.createdAt)).limit(1);
  const referencedIds = [...new Set([c.employeeSourceId, c.phoneSourceId, ...facts.map((f) => f.sourceId), ...tech.map((t) => t.sourceId), ...signals.map((s) => s.sourceId)].filter(Boolean) as string[])];
  const missingSources = referencedIds.filter((id) => !sources.some((s) => s.id === id));
  const extra = missingSources.length ? await db.select().from(schema.researchSources).where(inArray(schema.researchSources.id, missingSources)) : [];

  return {
    prospectId: formatProspectId(c.prospectNumber),
    company: {
      id: c.id, officialName: c.officialName, tradingName: c.tradingName, website: c.website, domain: c.canonicalDomain,
      industry: industry ? { code: industry.code, name: industry.nameNl, nis2Sector: industry.nis2Sector, dora: industry.doraApplicable } : null,
      subIndustry: c.subIndustry, hqCity: c.hqCity, hqCountry: c.hqCountry, nlOfficeCity: c.nlOfficeCity,
      employees: { count: c.employeeCount, min: c.employeeMin, max: c.employeeMax, sourceId: c.employeeSourceId },
      legalForm: c.legalForm, kvkNumber: c.kvkNumber, phone: c.phonePublic, phoneSourceId: c.phoneSourceId,
      purchasingAuthority: c.purchasingAuthority, status: c.status, relationship: c.relationship, contactEligibility: c.contactEligibility,
      lastResearchedAt: c.lastResearchedAt,
    },
    group: group ? { name: group.name, domain: group.primaryDomain, hqCountry: group.hqCountry, itPurchasingLocation: group.itPurchasingLocation } : null,
    aliases: aliases.map((a) => a.alias),
    facts: facts.filter((f) => !f.supersededById).map((f) => ({ field: f.field, value: f.value, sourceId: f.sourceId, confidence: f.confidence, observedAt: f.observedAt })),
    technologyEvidence: tech.map((t) => ({ technology: t.technology, classification: t.classification, evidenceType: t.evidenceType, detail: t.detail, sourceId: t.sourceId })),
    buyingSignals: signals.map((s) => ({ type: s.signalType, title: s.title, date: s.signalDate, relevance: s.relevance, sourceId: s.sourceId, ...(forQa ? {} : { explanation: s.explanation, commercialAssessment: s.commercialAssessment }) })),
    contacts: contacts.map((ct) => ({ role: ct.roleTitle, category: ct.roleCategory, name: ct.fullName, sourceId: ct.sourceId })),
    sources: [...sources, ...extra].map((s) => ({ id: s.id, url: s.url, type: s.sourceType, title: s.title, retrievedAt: s.retrievedAt, excerpt: (s.excerpt ?? "").slice(0, forQa ? 1500 : 600) })),
    missingSourceReferences: referencedIds.filter((id) => ![...sources, ...extra].some((s) => s.id === id)),
    score: score && !forQa ? { fit: score.fitScore, confidence: score.confidenceScore, classification: score.classification, components: score.components, service: score.recommendedService, rationale: score.rationale, missing: score.missingInformation } : undefined,
  };
}
export type Dossier = NonNullable<Awaited<ReturnType<typeof buildDossier>>>;
