/**
 * Cloud Life Sales Army — relational data model.
 * See DATA_MODEL.md for the narrative description of every entity.
 *
 * Conventions:
 *  - UUID primary keys, `created_at` / `updated_at` timestamps (UTC).
 *  - Historical records are never overwritten: superseded rows keep their data
 *    and point at their successor (`superseded_by_id`), or are versioned.
 *  - Soft deletion via `deleted_at` where retention rules apply.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  numeric,
  real,
  index,
  uniqueIndex,
  serial,
  date,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();
const id = () => uuid("id").primaryKey().defaultRandom();

// ───────────────────────────── enums ─────────────────────────────
export const userRole = pgEnum("user_role", ["admin", "analyst", "viewer"]);
export const companyStatus = pgEnum("company_status", [
  "candidate",
  "researching",
  "researched",
  "qualified",
  "needs_research",
  "rejected",
  "approved",
  "exported",
  "excluded",
]);
export const relationshipType = pgEnum("relationship_type", [
  "none",
  "customer",
  "active_opportunity",
  "prior_prospect",
  "rejected",
  "opted_out",
]);
export const contactEligibility = pgEnum("contact_eligibility", ["eligible", "restricted", "unknown", "suppressed"]);
export const evidenceClass = pgEnum("evidence_class", [
  "confirmed",
  "strongly_indicated",
  "weakly_indicated",
  "unknown",
  "contradicted",
]);
export const msTechnology = pgEnum("ms_technology", [
  "microsoft_365",
  "exchange_online",
  "entra_id",
  "azure",
  "intune",
  "defender",
  "purview",
  "copilot",
  "sharepoint_online",
  "teams",
]);
export const runStatus = pgEnum("run_status", [
  "queued",
  "running",
  "paused",
  "cancelled",
  "completed",
  "failed",
]);
export const runKind = pgEnum("run_kind", ["weekly", "manual", "sector", "company", "chat", "pilot"]);
export const taskStatus = pgEnum("task_status", ["queued", "running", "succeeded", "failed", "cancelled", "skipped", "awaiting"]);
export const qaVerdict = pgEnum("qa_verdict", ["approved", "rejected", "needs_research"]);
export const listStatus = pgEnum("list_status", ["draft", "in_review", "approved", "exported"]);
export const listItemStatus = pgEnum("list_item_status", ["pending", "approved", "rejected"]);
export const callOutcome = pgEnum("call_outcome", [
  "not_yet_called",
  "no_answer",
  "gatekeeper",
  "wrong_contact",
  "not_interested",
  "existing_supplier",
  "no_microsoft_environment",
  "no_purchasing_authority",
  "contact_again_later",
  "qualified_opportunity",
  "appointment_scheduled",
  "converted_to_customer",
  "do_not_contact",
]);
export const exclusionScope = pgEnum("exclusion_scope", [
  "company",
  "domain",
  "parent_company",
  "legal_entity",
  "sector",
  "name",
]);
export const recommendationStatus = pgEnum("recommendation_status", ["proposed", "approved", "rejected", "applied"]);

// ───────────────────────────── identity & access ─────────────────────────────
export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name"),
  role: userRole("role").notNull().default("viewer"),
  entraObjectId: text("entra_object_id").unique(),
  active: boolean("active").notNull().default(true),
  lastLoginAt: ts("last_login_at"),
  createdAt: createdAt(),
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    actorType: text("actor_type").notNull(), // user | agent | system
    actorId: text("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_entity_idx").on(t.entityType, t.entityId), index("audit_created_idx").on(t.createdAt)],
);

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: updatedAt(),
});

// ───────────────────────────── market structure ─────────────────────────────
export const industries = pgTable("industries", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  nameNl: text("name_nl").notNull(),
  nameEn: text("name_en").notNull(),
  /** 1 = highest priority, 4 = deprioritised; 0 = excluded sector */
  priorityTier: integer("priority_tier").notNull().default(2),
  nis2Sector: text("nis2_sector"), // essential | important | null
  doraApplicable: boolean("dora_applicable").notNull().default(false),
  active: boolean("active").notNull().default(true),
  /** Estimated number of NL organisations 50–5000 FTE; uncertain estimate. */
  estimatedPoolSize: integer("estimated_pool_size"),
  poolEstimateSource: text("pool_estimate_source"),
  notes: text("notes"),
});

/** Persistent research map maintained by the Market Intelligence Director. */
export const marketSegments = pgTable(
  "market_segments",
  {
    id: id(),
    industryId: integer("industry_id").references(() => industries.id),
    region: text("region"),
    sizeBand: text("size_band"),
    description: text("description"),
    sourcesUsed: jsonb("sources_used").$type<string[]>().default(sql`'[]'::jsonb`),
    queriesUsed: jsonb("queries_used").$type<string[]>().default(sql`'[]'::jsonb`),
    candidatesFound: integer("candidates_found").notNull().default(0),
    qualifiedFound: integer("qualified_found").notNull().default(0),
    exhaustionEstimate: real("exhaustion_estimate"), // 0..1, uncertain
    lastResearchedAt: ts("last_researched_at"),
    createdAt: createdAt(),
  },
  (t) => [index("segment_industry_idx").on(t.industryId)],
);

// ───────────────────────────── companies ─────────────────────────────
export const companyGroups = pgTable("company_groups", {
  id: id(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  primaryDomain: text("primary_domain"),
  hqCountry: text("hq_country"),
  /** Where IT purchasing for Dutch entities is decided (NL | abroad | unknown). */
  itPurchasingLocation: text("it_purchasing_location").default("unknown"),
  notes: text("notes"),
  createdAt: createdAt(),
});

export const companies = pgTable(
  "companies",
  {
    id: id(),
    /** Persistent human-readable prospect identifier, e.g. CLSA-000042. */
    prospectNumber: serial("prospect_number").notNull().unique(),
    officialName: text("official_name").notNull(),
    tradingName: text("trading_name"),
    normalizedName: text("normalized_name").notNull(),
    website: text("website"),
    canonicalDomain: text("canonical_domain"),
    industryId: integer("industry_id").references(() => industries.id),
    subIndustry: text("sub_industry"),
    hqCity: text("hq_city"),
    hqCountry: text("hq_country"),
    nlOfficeCity: text("nl_office_city"),
    province: text("province"),
    employeeCount: integer("employee_count"),
    employeeMin: integer("employee_min"),
    employeeMax: integer("employee_max"),
    employeeSourceId: uuid("employee_source_id"),
    groupId: uuid("group_id").references(() => companyGroups.id),
    legalForm: text("legal_form"),
    kvkNumber: text("kvk_number"),
    phonePublic: text("phone_public"),
    phoneSourceId: uuid("phone_source_id"),
    purchasingAuthority: text("purchasing_authority").default("unknown"), // nl_independent | nl_group_hq | nl_local_it | abroad_central | unknown
    status: companyStatus("status").notNull().default("candidate"),
    relationship: relationshipType("relationship").notNull().default("none"),
    contactEligibility: contactEligibility("contact_eligibility").notNull().default("unknown"),
    eligibilityReason: text("eligibility_reason"),
    eligibilityCheckedAt: ts("eligibility_checked_at"),
    assignedAgent: text("assigned_agent"),
    discoveredBy: text("discovered_by"),
    discoveredRunId: uuid("discovered_run_id"),
    latestScoreId: uuid("latest_score_id"),
    fitScore: integer("fit_score"),
    confidenceScore: integer("confidence_score"),
    classification: text("classification"),
    recommendedService: text("recommended_service"),
    reactivationApproved: boolean("reactivation_approved").notNull().default(false),
    /** Research depth reached: screened (free) → extracted (cheap model) → deep (agent tools). */
    researchTier: text("research_tier"),
    /** Deterministic prescreen potential (0–100), used to prioritise expensive research. */
    screenScore: integer("screen_score"),
    lastResearchedAt: ts("last_researched_at"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("company_norm_name_idx").on(t.normalizedName),
    uniqueIndex("company_domain_uniq").on(t.canonicalDomain).where(sql`${t.canonicalDomain} is not null and ${t.deletedAt} is null`),
    uniqueIndex("company_kvk_uniq").on(t.kvkNumber).where(sql`${t.kvkNumber} is not null and ${t.deletedAt} is null`),
    index("company_status_idx").on(t.status),
    index("company_industry_idx").on(t.industryId),
    index("company_group_idx").on(t.groupId),
    index("company_name_trgm_idx").using("gin", sql`${t.normalizedName} gin_trgm_ops`),
  ],
);

/** Normalised identifiers (domains incl. historical, phones, KvK, name variants) for deduplication. */
export const companyIdentifiers = pgTable(
  "company_identifiers",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // domain | phone | kvk | name
    value: text("value").notNull(),
    source: text("source"), // research | historical_import | feedback | manual
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("identifier_uniq").on(t.companyId, t.type, t.value), index("identifier_lookup_idx").on(t.type, t.value)],
);

// ───────────────────────────── discovery sources ─────────────────────────────
/**
 * Persistent discovery-source database. A source is either a page to harvest
 * (association member list, exhibitor list, ranking, business park, group
 * subsidiaries page…) or a search template (vacancies, partner case studies…).
 * Yield is computed from source_companies, so prioritisation learns over time.
 */
export const discoverySources = pgTable(
  "discovery_sources",
  {
    id: id(),
    kind: text("kind").notNull(), // page | query
    sourceType: text("source_type").notNull(), // association | trade_fair | ranking | directory | business_park | publication | regional_network | group_structure | annual_report | vacancy | ms_customer_reference | partner_reference | procurement | register
    name: text("name").notNull(),
    url: text("url"),
    query: text("query"),
    industryCodes: jsonb("industry_codes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    region: text("region"),
    status: text("status").notNull().default("unverified"), // unverified | active | exhausted | blocked | retired
    statusReason: text("status_reason"),
    origin: text("origin").notNull().default("seed"), // seed | agent | admin | derived
    harvestCount: integer("harvest_count").notNull().default(0),
    pagesHarvested: integer("pages_harvested").notNull().default(0),
    lastHarvestedAt: ts("last_harvested_at"),
    reharvestDays: integer("reharvest_days").notNull().default(90),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("source_url_uniq").on(t.url).where(sql`${t.url} is not null`), uniqueIndex("source_query_uniq").on(t.query).where(sql`${t.query} is not null`)],
);

/** Which source surfaced which company (and whether it was new to us at that moment). */
export const sourceCompanies = pgTable(
  "source_companies",
  {
    id: id(),
    sourceId: uuid("source_id").notNull().references(() => discoverySources.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    wasNew: boolean("was_new").notNull(),
    role: text("role"), // member | exhibitor | customer | employer | subsidiary | ranked | listed
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("source_company_uniq").on(t.sourceId, t.companyId), index("source_company_company_idx").on(t.companyId)],
);

export const companyAliases = pgTable(
  "company_aliases",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("alias_norm_idx").on(t.normalizedAlias)],
);

export const domains = pgTable(
  "domains",
  {
    id: id(),
    domain: text("domain").notNull(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    groupId: uuid("group_id").references(() => companyGroups.id),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("domain_uniq").on(t.domain)],
);

export const legalEntities = pgTable("legal_entities", {
  id: id(),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  kvkNumber: text("kvk_number"),
  legalForm: text("legal_form"),
  sourceId: uuid("source_id"),
  createdAt: createdAt(),
});

/** Minimal professional contact data. No private emails or personal phone numbers. */
export const contacts = pgTable("contacts", {
  id: id(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  fullName: text("full_name"),
  roleTitle: text("role_title").notNull(),
  roleCategory: text("role_category"), // cio | it_manager | ciso | security_officer | cfo | ceo | other
  sourceId: uuid("source_id"),
  lawfulBasis: text("lawful_basis").notNull().default("legitimate_interest_b2b_public_professional_role"),
  retentionUntil: date("retention_until"),
  createdAt: createdAt(),
});

// ───────────────────────────── research evidence ─────────────────────────────
export const researchSources = pgTable(
  "research_sources",
  {
    id: id(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    url: text("url").notNull(),
    title: text("title"),
    sourceType: text("source_type").notNull(), // official_site | vacancy | ms_customer_story | news | directory | registry | annual_report | procurement | dns | association | other
    provider: text("provider").notNull(),
    contentHash: text("content_hash"),
    /** Bounded excerpt (max 12k chars, exactly what agents saw) — never the full page — to minimise stored third-party content. */
    excerpt: text("excerpt"),
    httpStatus: integer("http_status"),
    retrievedAt: ts("retrieved_at").notNull().defaultNow(),
    runId: uuid("run_id"),
  },
  (t) => [index("source_company_idx").on(t.companyId), index("source_url_idx").on(t.url)],
);

/** Atomic facts with provenance, age and reliability. */
export const companyFacts = pgTable(
  "company_facts",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    value: jsonb("value").notNull(),
    sourceId: uuid("source_id").references(() => researchSources.id, { onDelete: "set null" }),
    confidence: real("confidence").notNull(), // 0..1
    observedAt: ts("observed_at").notNull().defaultNow(),
    expiresAt: ts("expires_at"),
    recordedBy: text("recorded_by"),
    supersededById: uuid("superseded_by_id").references((): AnyPgColumn => companyFacts.id),
  },
  (t) => [index("fact_company_field_idx").on(t.companyId, t.field)],
);

export const technologyEvidence = pgTable(
  "technology_evidence",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    technology: msTechnology("technology").notNull(),
    classification: evidenceClass("classification").notNull(),
    evidenceType: text("evidence_type").notNull(), // dns_mx | dns_txt | dns_cname | spf | vacancy | customer_story | website | news | annual_report
    detail: text("detail").notNull(),
    sourceId: uuid("source_id").references(() => researchSources.id, { onDelete: "set null" }),
    recordedBy: text("recorded_by"),
    observedAt: ts("observed_at").notNull().defaultNow(),
    runId: uuid("run_id"),
  },
  (t) => [index("tech_company_idx").on(t.companyId)],
);

export const buyingSignals = pgTable(
  "buying_signals",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    signalType: text("signal_type").notNull(),
    title: text("title").notNull(),
    explanation: text("explanation").notNull(),
    relevance: text("relevance").notNull(), // high | medium | low
    commercialAssessment: text("commercial_assessment").notNull(),
    signalDate: date("signal_date"),
    sourceId: uuid("source_id").references(() => researchSources.id, { onDelete: "set null" }),
    recordedBy: text("recorded_by"),
    runId: uuid("run_id"),
    createdAt: createdAt(),
  },
  (t) => [index("signal_company_idx").on(t.companyId), index("signal_type_idx").on(t.signalType)],
);

// ───────────────────────────── scoring & QA ─────────────────────────────
export const scoringConfigs = pgTable("scoring_configs", {
  id: id(),
  version: integer("version").notNull().unique(),
  weights: jsonb("weights").notNull(),
  thresholds: jsonb("thresholds").notNull(),
  rules: jsonb("rules").notNull(),
  active: boolean("active").notNull().default(false),
  notes: text("notes"),
  createdBy: text("created_by"),
  approvedBy: text("approved_by"),
  createdAt: createdAt(),
});

export const qualificationScores = pgTable(
  "qualification_scores",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    scoringConfigId: uuid("scoring_config_id").references(() => scoringConfigs.id),
    runId: uuid("run_id"),
    fitScore: integer("fit_score").notNull(),
    confidenceScore: integer("confidence_score").notNull(),
    components: jsonb("components").notNull(),
    classification: text("classification").notNull(),
    recommendedService: text("recommended_service").notNull(),
    rationale: text("rationale").notNull(),
    missingInformation: jsonb("missing_information").$type<string[]>().notNull(),
    hardFailures: jsonb("hard_failures").$type<string[]>().notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("score_company_idx").on(t.companyId)],
);

export const qaReviews = pgTable(
  "qa_reviews",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    verdict: qaVerdict("verdict").notNull(),
    checks: jsonb("checks").notNull(),
    issues: jsonb("issues").$type<string[]>().notNull(),
    reviewer: text("reviewer").notNull(),
    overriddenBy: text("overridden_by"),
    overrideReason: text("override_reason"),
    overriddenAt: ts("overridden_at"),
    createdAt: createdAt(),
  },
  (t) => [index("qa_company_idx").on(t.companyId)],
);

// ───────────────────────────── exclusions & suppression ─────────────────────────────
export const exclusions = pgTable(
  "exclusions",
  {
    id: id(),
    scope: exclusionScope("scope").notNull(),
    value: text("value").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    category: text("category").notNull(), // competitor | msp | it_consultancy | agency | customer | opportunity | rejected | delivered | manual | seed
    reason: text("reason").notNull(),
    permanent: boolean("permanent").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("exclusion_lookup_idx").on(t.scope, t.normalizedValue)],
);

/**
 * Permanent opt-out / do-not-contact suppression. Stores the minimum necessary:
 * normalised identifiers only. Cannot be overridden via ordinary approvals.
 */
export const suppressions = pgTable(
  "suppressions",
  {
    id: id(),
    identifierType: text("identifier_type").notNull(), // domain | kvk | name | phone
    identifierValue: text("identifier_value").notNull(),
    reason: text("reason").notNull(), // opt_out | do_not_contact | legal
    source: text("source"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("suppression_uniq").on(t.identifierType, t.identifierValue)],
);

// ───────────────────────────── runs, tasks, agents ─────────────────────────────
export const researchRuns = pgTable(
  "research_runs",
  {
    id: id(),
    kind: runKind("kind").notNull(),
    status: runStatus("status").notNull().default("queued"),
    idempotencyKey: text("idempotency_key").unique(),
    params: jsonb("params").notNull(),
    strategy: jsonb("strategy"),
    stage: text("stage"),
    targetProspects: integer("target_prospects").notNull().default(100),
    budgetEur: numeric("budget_eur", { precision: 10, scale: 2 }),
    costEur: numeric("cost_eur", { precision: 12, scale: 4 }).notNull().default("0"),
    stats: jsonb("stats").$type<Record<string, number>>().default(sql`'{}'::jsonb`),
    error: text("error"),
    pauseReason: text("pause_reason"),
    triggeredBy: text("triggered_by").notNull(),
    managementSummary: text("management_summary"),
    /** api | claude_code */
    executor: text("executor").notNull().default("api"),
    /** Claude Code session URLs that worked on this run (from the scheduled-task fire API or the session itself). */
    executorSessions: jsonb("executor_sessions").$type<{ url: string; at: string; source: string }[]>().default(sql`'[]'::jsonb`),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    heartbeatAt: ts("heartbeat_at"),
    createdAt: createdAt(),
  },
  (t) => [index("run_status_idx").on(t.status)],
);

/** Per-candidate checkpoint inside a run; enables resume after interruption. */
export const runCandidates = pgTable(
  "run_candidates",
  {
    id: id(),
    runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    stage: text("stage").notNull().default("discovered"),
    status: text("status").notNull().default("pending"), // pending | in_progress | done | rejected | failed | skipped
    attempts: integer("attempts").notNull().default(0),
    hunter: text("hunter"),
    discoverySourceId: uuid("discovery_source_id"),
    priority: integer("priority").notNull().default(50),
    lastError: text("last_error"),
    outcome: text("outcome"),
    checkpoint: jsonb("checkpoint").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("run_candidate_uniq").on(t.runId, t.companyId), index("run_candidate_status_idx").on(t.runId, t.status)],
);

/** Discovery work units of a run (harvests, scouting, hunts) — finalisation waits until all are closed. */
export const runWork = pgTable(
  "run_work",
  {
    id: id(),
    runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // harvest | scout | hunt
    sourceId: uuid("source_id"),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("pending"), // pending | done | failed
    found: integer("found").notNull().default(0),
    newCandidates: integer("new_candidates").notNull().default(0),
    error: text("error"),
    round: integer("round").notNull().default(1),
    updatedAt: updatedAt(),
  },
  (t) => [index("run_work_run_idx").on(t.runId, t.status)],
);

/** Encrypted integration secrets managed through the setup wizard (AES-256-GCM). */
export const secrets = pgTable("secrets", {
  key: text("key").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  tag: text("tag").notNull(),
  last4: text("last4"),
  updatedBy: text("updated_by"),
  updatedAt: updatedAt(),
  validatedAt: ts("validated_at"),
  validationStatus: text("validation_status"), // ok | failed
  validationMessage: text("validation_message"),
});

export const agentTasks = pgTable(
  "agent_tasks",
  {
    id: id(),
    runId: uuid("run_id").references(() => researchRuns.id, { onDelete: "set null" }),
    agentId: text("agent_id").notNull(),
    parentTaskId: uuid("parent_task_id").references((): AnyPgColumn => agentTasks.id),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    taskType: text("task_type").notNull(),
    status: taskStatus("status").notNull().default("queued"),
    input: jsonb("input"),
    output: jsonb("output"),
    error: text("error"),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    toolCalls: integer("tool_calls").notNull().default(0),
    costEur: numeric("cost_eur", { precision: 12, scale: 4 }).notNull().default("0"),
    attempts: integer("attempts").notNull().default(0),
    /** api (Messages API, paid) | claude_code (subscription: executed by a native Claude Code session via the bridge) */
    executor: text("executor").notNull().default("api"),
    /** Deterministic key of (agent, task, run, company, input) so a resumed job picks up a submitted result. */
    idempotencyKey: text("idempotency_key"),
    /** Job to re-enqueue when a Claude Code session submits the result. */
    resumeJob: jsonb("resume_job").$type<{ name: string; data: Record<string, unknown> } | null>(),
    claimedAt: ts("claimed_at"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [index("task_agent_idx").on(t.agentId, t.createdAt), index("task_run_idx").on(t.runId), index("task_status_idx").on(t.status), index("task_idem_idx").on(t.idempotencyKey)],
);

/** Inter-agent and user↔agent communication log (Sales Army HQ). */
export const agentMessages = pgTable(
  "agent_messages",
  {
    id: id(),
    threadId: uuid("thread_id").notNull(),
    fromAgent: text("from_agent"), // null when from a user
    toAgent: text("to_agent"),
    userId: text("user_id"),
    role: text("role").notNull(), // user | agent | system | delegation
    content: text("content").notNull(),
    taskId: uuid("task_id"),
    runId: uuid("run_id"),
    createdAt: createdAt(),
  },
  (t) => [index("msg_thread_idx").on(t.threadId, t.createdAt), index("msg_agent_idx").on(t.toAgent)],
);

export const agentPerformanceSnapshots = pgTable("agent_performance_snapshots", {
  id: id(),
  agentId: text("agent_id").notNull(),
  periodStart: date("period_start").notNull(),
  metrics: jsonb("metrics").notNull(),
  createdAt: createdAt(),
});

// ───────────────────────────── delivery & feedback ─────────────────────────────
export const prospectLists = pgTable("prospect_lists", {
  id: id(),
  isoWeek: text("iso_week").notNull(), // 2026-W48
  runId: uuid("run_id").references(() => researchRuns.id),
  status: listStatus("status").notNull().default("draft"),
  target: integer("target").notNull().default(100),
  shortfall: integer("shortfall").notNull().default(0),
  shortfallExplanation: text("shortfall_explanation"),
  qaReport: jsonb("qa_report"),
  managementSummary: text("management_summary"),
  approvedBy: text("approved_by"),
  approvedAt: ts("approved_at"),
  createdAt: createdAt(),
});

export const prospectListItems = pgTable(
  "prospect_list_items",
  {
    id: id(),
    listId: uuid("list_id").notNull().references(() => prospectLists.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    rank: integer("rank").notNull(),
    priority: text("priority").notNull(), // A | B | C
    status: listItemStatus("status").notNull().default("pending"),
    decidedBy: text("decided_by"),
    decisionReason: text("decision_reason"),
    contactRole: text("contact_role"),
    contactName: text("contact_name"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("list_item_uniq").on(t.listId, t.companyId)],
);

export const exportsTable = pgTable("exports", {
  id: id(),
  listId: uuid("list_id").references(() => prospectLists.id),
  format: text("format").notNull(), // xlsx | csv
  fileName: text("file_name").notNull(),
  rowCount: integer("row_count").notNull(),
  contentHash: text("content_hash").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
});

/** Which companies were delivered to the calling agency, and when (dedup memory). */
export const deliveries = pgTable(
  "deliveries",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    listId: uuid("list_id").references(() => prospectLists.id),
    exportId: uuid("export_id").references(() => exportsTable.id),
    deliveredAt: ts("delivered_at").notNull().defaultNow(),
  },
  (t) => [index("delivery_company_idx").on(t.companyId)],
);

export const feedbackImports = pgTable("feedback_imports", {
  id: id(),
  /** feedback | historical_list | customers | opportunities | rejected */
  kind: text("kind").notNull().default("feedback"),
  fileName: text("file_name").notNull(),
  uploadedBy: text("uploaded_by").notNull(),
  status: text("status").notNull().default("preview"), // preview | committed | discarded
  mapping: jsonb("mapping"),
  rowCount: integer("row_count").notNull().default(0),
  validRows: integer("valid_rows").notNull().default(0),
  duplicateRows: integer("duplicate_rows").notNull().default(0),
  errors: jsonb("errors").$type<string[]>().default(sql`'[]'::jsonb`),
  preview: jsonb("preview"),
  createdAt: createdAt(),
  committedAt: ts("committed_at"),
});

/** Calling outcomes. Never updated in place: corrections create a new row and supersede. */
export const callingResults = pgTable(
  "calling_results",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    importId: uuid("import_id").references(() => feedbackImports.id),
    outcome: callOutcome("outcome").notNull(),
    notes: text("notes"),
    calledAt: ts("called_at"),
    contactRole: text("contact_role"),
    raw: jsonb("raw"),
    rowHash: text("row_hash").notNull(),
    supersededById: uuid("superseded_by_id").references((): AnyPgColumn => callingResults.id),
    createdAt: createdAt(),
  },
  (t) => [index("call_company_idx").on(t.companyId), uniqueIndex("call_row_hash_uniq").on(t.rowHash)],
);

export const appointments = pgTable("appointments", {
  id: id(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  callingResultId: uuid("calling_result_id").references(() => callingResults.id),
  scheduledFor: ts("scheduled_for"),
  notes: text("notes"),
  createdAt: createdAt(),
});

export const opportunities = pgTable("opportunities", {
  id: id(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  service: text("service").notNull(),
  stage: text("stage").notNull().default("open"), // open | won | lost
  estimatedMrrEur: numeric("estimated_mrr_eur", { precision: 10, scale: 2 }),
  source: text("source"),
  createdAt: createdAt(),
  closedAt: ts("closed_at"),
});

export const conversions = pgTable("conversions", {
  id: id(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  service: text("service").notNull(),
  contractedMrrEur: numeric("contracted_mrr_eur", { precision: 10, scale: 2 }),
  signedAt: date("signed_at"),
  createdAt: createdAt(),
});

// ───────────────────────────── learning ─────────────────────────────
export const strategies = pgTable("strategies", {
  id: id(),
  version: integer("version").notNull().unique(),
  content: jsonb("content").notNull(),
  createdByAgent: text("created_by_agent"),
  runId: uuid("run_id"),
  approved: boolean("approved").notNull().default(true),
  approvedBy: text("approved_by"),
  createdAt: createdAt(),
});

export const recommendations = pgTable("recommendations", {
  id: id(),
  type: text("type").notNull(), // prioritize_industry | deprioritize_industry | scoring_adjustment | new_criterion | research_source | search_strategy | new_opportunity
  title: text("title").notNull(),
  content: text("content").notNull(),
  evidenceStrength: text("evidence_strength").notNull(), // statistically_meaningful | indicative | speculative
  evidence: jsonb("evidence"),
  proposedChange: jsonb("proposed_change"),
  requiresApproval: boolean("requires_approval").notNull().default(true),
  status: recommendationStatus("status").notNull().default("proposed"),
  decidedBy: text("decided_by"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
});

// ───────────────────────────── cost & providers ─────────────────────────────
export const providerUsage = pgTable(
  "provider_usage",
  {
    id: id(),
    provider: text("provider").notNull(),
    operation: text("operation").notNull(),
    units: real("units").notNull().default(1),
    costEur: numeric("cost_eur", { precision: 12, scale: 4 }).notNull().default("0"),
    cached: boolean("cached").notNull().default(false),
    runId: uuid("run_id"),
    agentTaskId: uuid("agent_task_id"),
    agentId: text("agent_id"),
    companyId: uuid("company_id"),
    createdAt: createdAt(),
  },
  (t) => [index("usage_created_idx").on(t.createdAt), index("usage_run_idx").on(t.runId)],
);

export const researchCache = pgTable(
  "research_cache",
  {
    id: id(),
    provider: text("provider").notNull(),
    cacheKey: text("cache_key").notNull(),
    response: jsonb("response").notNull(),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [uniqueIndex("cache_key_uniq").on(t.provider, t.cacheKey)],
);
