import { z } from "zod";
import { SERVICES } from "@/domain/services";
import { MS_TECHNOLOGIES } from "@/domain/msEvidence";

/** Structured agent input/output contracts. Every model output is validated against these before persisting. */

const nullableStr = z.string().nullable();
const sourceRef = z.string().uuid().nullable().describe("source_id uit een tool-resultaat, of null");

export const INDUSTRY_CODES = [
  "manufacturing", "industrial_engineering", "food_production", "logistics", "healthcare", "financial_services", "insurance",
  "energy", "utilities", "transportation", "maritime", "construction", "infrastructure", "wholesale", "distribution",
  "housing_associations", "retail_hq", "education", "municipalities", "government", "professional_services",
  "it_services", "cybersecurity", "marketing_agency", "recruitment", "sales_agency", "software_startup", "other",
] as const;

export const BUSINESS_CATEGORIES = [
  "operating_company", "public_body", "non_profit", "cybersecurity_provider", "msp", "it_consultancy",
  "ms_security_consultancy", "sales_agency", "marketing_agency", "recruitment_agency", "software_startup", "holding_only", "unknown",
] as const;

export const SIGNAL_TYPES = [
  "copilot_adoption", "m365_migration", "digital_transformation", "new_it_leadership", "security_vacancy", "acquisition_merger",
  "expansion", "regulatory_pressure", "nis2", "dora", "data_governance", "security_project", "it_modernization",
  "security_strategy_change", "public_incident", "agentic_ai",
] as const;

// ── Chief Sales Officer ──
export const WeeklyPlanInput = z.object({
  isoWeek: z.string(),
  target: z.number().int(),
  performance: z.unknown(),
  marketMap: z.unknown(),
  previousRuns: z.unknown(),
  constraints: z.object({ industries: z.array(z.string()).optional(), sizeBand: z.tuple([z.number(), z.number()]).optional() }).optional(),
});
export const WeeklyPlanOutput = z.object({
  strategySummary: z.string().min(20).max(3000),
  industries: z
    .array(z.object({ code: z.enum(INDUSTRY_CODES), quota: z.number().int().min(1).max(150), rationale: z.string().max(600), sizeFocus: z.enum(["enterprise", "midmarket", "growth"]) }))
    .min(1)
    .max(12),
  hunterAllocation: z.object({ enterprise: z.number().int().min(0), midmarket: z.number().int().min(0), growth: z.number().int().min(0) }),
  searchThemes: z.array(z.string().max(200)).max(20),
  underexploredIndustries: z.array(z.string()).max(12),
  risks: z.array(z.string().max(400)).max(10),
});

export const ListApprovalInput = z.object({ isoWeek: z.string(), stats: z.unknown(), qaSummary: z.unknown(), shortfall: z.number().int(), topCompanies: z.unknown() });
export const ListApprovalOutput = z.object({
  approveForReview: z.boolean(),
  decisionRationale: z.string().max(2000),
  concerns: z.array(z.string().max(500)).max(15),
  managementSummary: z.string().min(50).max(6000).describe("Markdown managementsamenvatting in het Nederlands"),
});

// ── Market Intelligence & Hunters ──
export const DiscoveryInput = z.object({
  industry: z.string(),
  industryName: z.string(),
  sizeBand: z.tuple([z.number(), z.number()]),
  quota: z.number().int(),
  searchThemes: z.array(z.string()),
  previousQueries: z.array(z.string()),
  knownCompanyNames: z.array(z.string()).describe("Reeds bekend — niet opnieuw aandragen"),
});
const CandidateSchema = z.object({
  name: z.string().min(2).max(200),
  website: nullableStr,
  city: nullableStr,
  estimatedEmployees: z.number().int().nullable(),
  sourceId: sourceRef,
  sourceUrl: nullableStr,
  rationale: z.string().max(500),
});
export const DiscoveryOutput = z.object({
  candidates: z.array(CandidateSchema).max(80),
  poolsUsed: z.array(z.object({ name: z.string(), url: nullableStr, sourceType: z.string(), usefulness: z.enum(["high", "medium", "low"]) })).max(20),
  queriesUsed: z.array(z.string()).max(40),
  exhaustionEstimate: z.number().min(0).max(1).nullable().describe("Geschatte uitputting van deze pool (0–1), onzeker"),
  notes: z.string().max(1500),
});

// ── Company Research Specialist ──
export const EnrichInput = z.object({
  companyId: z.string().uuid(),
  name: z.string(),
  website: nullableStr,
  knownFacts: z.unknown(),
  depth: z.enum(["light", "standard", "deep"]),
});
const FieldConf = z.number().min(0).max(1).nullable();
export const EnrichOutput = z.object({
  officialName: z.string(),
  tradingName: nullableStr,
  website: nullableStr,
  industryCode: z.enum(INDUSTRY_CODES),
  businessCategory: z.enum(BUSINESS_CATEGORIES),
  subIndustry: nullableStr,
  hqCity: nullableStr,
  hqCountry: nullableStr,
  nlOfficeCity: nullableStr,
  employeeCount: z.number().int().positive().nullable(),
  employeeMin: z.number().int().positive().nullable(),
  employeeMax: z.number().int().positive().nullable(),
  employeeSourceId: sourceRef,
  groupName: nullableStr,
  groupDomain: nullableStr,
  groupHqCountry: nullableStr,
  purchasingAuthority: z.enum(["nl_independent", "nl_group_hq", "nl_local_it", "abroad_central", "unknown"]),
  purchasingAuthorityRationale: z.string().max(800),
  legalForm: nullableStr,
  legalFormSourceId: sourceRef,
  kvkNumber: z.string().regex(/^\d{8}$/).nullable(),
  phone: nullableStr,
  phoneSourceId: sourceRef,
  decisionMakerRoles: z
    .array(z.object({ roleTitle: z.string().max(120), roleCategory: z.enum(["cio", "it_manager", "ciso", "security_officer", "cto", "cfo", "ceo", "other"]), fullName: nullableStr, sourceId: sourceRef }))
    .max(6),
  itSecurityNotes: z.string().max(1500),
  compliance: z.object({
    nis2: z.enum(["essential", "important"]).nullable(),
    dora: z.boolean(),
    sensitiveData: z.boolean(),
    operationalTechnology: z.boolean(),
    certificationsOrRegulator: z.boolean(),
    rationale: z.string().max(1000),
  }),
  fieldConfidence: z.object({ employees: FieldConf, industry: FieldConf, headquarters: FieldConf, authority: FieldConf, phone: FieldConf, legalForm: FieldConf }),
  facts: z.array(z.object({ field: z.string().max(60), value: z.string().max(500), sourceId: sourceRef, confidence: z.number().min(0).max(1) })).max(40),
  unknowns: z.array(z.string().max(200)).max(20),
  injectionAttemptsObserved: z.array(z.string().max(300)).max(10),
});

// ── Microsoft Intelligence ──
export const MicrosoftInput = z.object({ companyId: z.string().uuid(), name: z.string(), domain: nullableStr, dnsFindings: z.unknown() });
export const MicrosoftOutput = z.object({
  claims: z
    .array(z.object({
      technology: z.enum(MS_TECHNOLOGIES as [string, ...string[]]),
      classification: z.enum(["confirmed", "strongly_indicated", "weakly_indicated", "unknown", "contradicted"]),
      evidenceType: z.enum(["vacancy", "customer_story", "website", "news", "annual_report", "procurement", "other"]),
      detail: z.string().max(500),
      sourceId: sourceRef,
      quote: nullableStr.describe("Letterlijk citaat uit de bron dat de claim onderbouwt"),
    }))
    .max(30),
  summary: z.string().max(1500),
});

// ── Buying Signal Analyst ──
export const SignalsInput = z.object({ companyId: z.string().uuid(), name: z.string(), domain: nullableStr, industry: nullableStr });
export const SignalsOutput = z.object({
  signals: z
    .array(z.object({
      signalType: z.enum(SIGNAL_TYPES),
      title: z.string().max(200),
      explanation: z.string().max(800),
      relevance: z.enum(["high", "medium", "low"]),
      commercialAssessment: z.string().max(600),
      signalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
      sourceId: z.string().uuid(),
    }))
    .max(15),
  notes: z.string().max(1000),
});

// ── Lead Qualification ──
export const QualifyInput = z.object({ companyId: z.string().uuid(), dossier: z.unknown(), computedScore: z.unknown(), ruleBasedService: z.string() });
export const QualifyOutput = z.object({
  recommendedService: z.enum(SERVICES),
  serviceReason: z.string().max(600),
  rationale: z.string().min(20).max(1200).describe("Beknopte, op bewijs gebaseerde commerciële onderbouwing"),
  recurringPotential: z.enum(["high", "medium", "low", "unknown"]),
  risks: z.array(z.string().max(300)).max(8),
  researchGaps: z.array(z.string().max(200)).max(8),
});

// ── QA Director ──
const Check = z.object({ pass: z.boolean().nullable(), note: z.string().max(400) });
export const QaInput = z.object({ companyId: z.string().uuid(), dossier: z.unknown(), deterministicChecks: z.unknown() });
export const QaOutput = z.object({
  verdict: z.enum(["approved", "rejected", "needs_research"]),
  checks: z.object({
    companyExists: Check,
    websiteVerified: Check,
    phoneVerified: Check,
    employeeEstimateSupported: Check,
    technologyClaimsSupported: Check,
    relevantProspect: Check,
    noDuplicate: Check,
    exclusionsReviewed: Check,
    contactEligibility: Check,
    evidenceSufficient: Check,
  }),
  hallucinationSuspected: z.boolean(),
  issues: z.array(z.string().max(400)).max(20),
});

// ── Sales Operations ──
export const FeedbackAnalysisInput = z.object({ performance: z.unknown(), recentImports: z.unknown() });
export const FeedbackAnalysisOutput = z.object({
  summary: z.string().max(4000),
  recommendations: z
    .array(z.object({
      type: z.enum(["prioritize_industry", "deprioritize_industry", "scoring_adjustment", "new_criterion", "research_source", "search_strategy", "new_opportunity"]),
      title: z.string().max(200),
      content: z.string().max(1500),
      evidenceStrength: z.enum(["statistically_meaningful", "indicative", "speculative"]),
    }))
    .max(12),
});

// ── Generic conversational task (Sales Army HQ) ──
export const ChatInput = z.object({ message: z.string().min(1).max(8000), history: z.array(z.object({ role: z.string(), content: z.string() })).max(30), userRole: z.string() });
export const ChatOutput = z.object({
  reply: z.string().min(1).max(12000).describe("Antwoord in het Nederlands (markdown toegestaan)"),
  findings: z.array(z.object({ statement: z.string().max(600), sourceId: sourceRef })).max(30),
  recommendations: z.array(z.string().max(600)).max(10),
});
