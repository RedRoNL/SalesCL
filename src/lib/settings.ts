import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";

/** Model tiers: cheap for high-volume extraction, strong for reasoning/QA. */
export const ModelConfigSchema = z.object({
  fast: z.string().default("claude-haiku-5-5"),
  standard: z.string().default("claude-sonnet-5-5"),
  strong: z.string().default("claude-opus-5-5"),
  /** Optional per-agent override: agentId -> model id */
  perAgent: z.record(z.string(), z.string()).default({}),
  effort: z.enum(["low", "medium", "high"]).default("medium"),
  usdToEur: z.number().positive().default(0.92),
});

export const BudgetSchema = z.object({
  weeklyEur: z.number().nonnegative().default(150),
  monthlyEur: z.number().nonnegative().default(500),
  perRunDefaultEur: z.number().nonnegative().default(120),
  /** Paid third-party subscriptions must be explicitly approved here. */
  approvedPaidProviders: z.array(z.string()).default([]),
  firecrawlEurPerCredit: z.number().nonnegative().default(0.0035),
  braveEurPerQuery: z.number().nonnegative().default(0.0047),
  kvkEurPerCall: z.number().nonnegative().default(0.02),
});

export const IcpSchema = z.object({
  country: z.string().default("NL"),
  minEmployees: z.number().int().default(50),
  maxEmployees: z.number().int().default(5000),
  primaryBand: z.tuple([z.number(), z.number()]).default([300, 2000]),
  enterpriseBand: z.tuple([z.number(), z.number()]).default([2000, 5000]),
  growthBand: z.tuple([z.number(), z.number()]).default([50, 300]),
  /** Max share of the weekly list allowed from the 50–300 band unless shortfall. */
  growthMaxShare: z.number().min(0).max(1).default(0.15),
  excludedCategories: z
    .array(z.string())
    .default(["cybersecurity_provider", "msp", "it_consultancy", "ms_security_consultancy", "sales_agency", "marketing_agency", "recruitment_agency", "software_startup"]),
});

export const ScheduleSchema = z.object({
  enabled: z.boolean().default(true),
  cron: z.string().default("0 8 * * 1"),
  timezone: z.string().default("Europe/Amsterdam"),
  weeklyTarget: z.number().int().min(1).max(500).default(100),
  candidateMultiplier: z.number().min(1).max(5).default(2.5),
  maxCandidatesPerRun: z.number().int().default(300),
});

export const ResearchSchema = z.object({
  /** Default needs no extra subscription (uses the Anthropic account). Brave is the cheapest high-volume option. */
  searchProvider: z.enum(["anthropic_web_search", "brave", "firecrawl", "none"]).default("none"),
  fetchProvider: z.enum(["firecrawl", "http"]).default("http"),
  /** Use Firecrawl only to render JavaScript-only pages (never to get past 401/403/CAPTCHA). */
  firecrawlRenderFallback: z.boolean().default(false),
  /** Pages fetched per company during the free screening stage (home + subpages). */
  screenPages: z.number().int().min(1).max(8).default(5),
  /** Minimum prescreen potential to spend money on deeper research. */
  minScreenScoreForExtraction: z.number().int().min(0).max(100).default(45),
  /** Minimum preliminary fit to activate the Buying Signal Analyst. */
  signalsMinFit: z.number().int().min(0).max(100).default(68),
  /** Stop expensive research once qualified ≥ target × this factor (remaining candidates are kept as reserve). */
  targetBufferFactor: z.number().min(1).max(2).default(1.15),
  /** Share of harvest capacity reserved for new/unproven discovery sources (exploration). */
  explorationShare: z.number().min(0).max(1).default(0.25),
  maxPagesPerSource: z.number().int().min(1).max(20).default(6),
  dnsProvider: z.enum(["system", "doh"]).default("doh"),
  registryProvider: z.enum(["none", "kvk"]).default("none"),
  /** Reuse facts younger than this many days instead of paying for re-research. */
  factReuseDays: z.number().int().default(90),
  cacheTtlDays: z.number().int().default(30),
  maxPagesPerCompany: z.number().int().default(6),
  requestDelayMs: z.number().int().default(1500),
  depth: z.enum(["light", "standard", "deep"]).default("standard"),
});

export const RetentionSchema = z.object({
  contactRetentionDays: z.number().int().default(730),
  sourceExcerptRetentionDays: z.number().int().default(730),
  rejectedCompanyRetentionDays: z.number().int().default(1095),
  auditLogRetentionDays: z.number().int().default(2555),
});

export const LearningSchema = z.object({
  /** Allow the system to adjust industry priorities by ±1 tier without approval. */
  autoAdjustIndustryPriority: z.boolean().default(true),
  minSampleForIndicative: z.number().int().default(10),
  minSampleForSignificant: z.number().int().default(30),
});

export const EligibilitySchema = z.object({
  /** Legal forms (normalised) that may be called B2B without prior consent. */
  eligibleLegalForms: z
    .array(z.string())
    .default(["bv", "nv", "stichting", "vereniging", "cooperatie", "owm", "publiekrechtelijk", "gemeente", "overheid", "se"]),
  /** Natural-person / partnership forms: consent required since 1 July 2026 (Telecommunicatiewet). */
  restrictedLegalForms: z.array(z.string()).default(["eenmanszaak", "vof", "cv", "maatschap"]),
  blockMobileNumbers: z.boolean().default(true),
  reverifyAfterDays: z.number().int().default(180),
});

export const IntegrationsSchema = z.object({
  entraTenantId: z.string().default(""),
  entraClientId: z.string().default(""),
  entraAdminGroupId: z.string().default(""),
  entraAnalystGroupId: z.string().default(""),
  /** Optional, off by default: query Microsoft's public OpenID metadata to see whether a domain belongs to an Entra tenant (no traffic to the prospect). */
  tenantDiscovery: z.boolean().default(false),
  /** Public URL used to validate outbound web access in the wizard. */
  connectivityTestUrl: z.string().default("https://www.kvk.nl/"),
});

/**
 * AI execution mode. "subscription" (default): model work is done by native Claude Code sessions
 * (cloud scheduled tasks) billed to the existing Claude subscription — no Anthropic API key. "api":
 * the Messages API (separately billed) — only usable after explicit approval.
 */
export const ExecutionSchema = z.object({
  mode: z.enum(["subscription", "api"]).default("subscription"),
  paidApiApproved: z.boolean().default(false),
  paidApiApprovedBy: z.string().default(""),
  /** Scheduled-task id (trig_…) for the official fire endpoint; its token is stored as secret ROUTINE_FIRE_TOKEN. */
  routineId: z.string().default(""),
  /** Public HTTPS URL of this dashboard as reached by Claude Code sessions (bridge base URL). */
  publicUrl: z.string().default(""),
  /** SHA-256 of the bridge token (the token itself is shown once and stored as a network secret in the Claude Code environment). */
  bridgeTokenHash: z.string().default(""),
  /** Claude Code subagent model per tier (subscription mode). */
  subscriptionModels: z.object({ fast: z.string().default("sonnet"), standard: z.string().default("sonnet"), strong: z.string().default("opus") }).default({ fast: "sonnet", standard: "sonnet", strong: "opus" }),
  /** A task not picked up for this long is re-offered (claim expiry). */
  claimTimeoutMinutes: z.number().int().min(5).max(240).default(45),
});

export const SettingsSchema = z.object({
  models: ModelConfigSchema.default(ModelConfigSchema.parse({})),
  budget: BudgetSchema.default(BudgetSchema.parse({})),
  icp: IcpSchema.default(IcpSchema.parse({})),
  schedule: ScheduleSchema.default(ScheduleSchema.parse({})),
  research: ResearchSchema.default(ResearchSchema.parse({})),
  retention: RetentionSchema.default(RetentionSchema.parse({})),
  learning: LearningSchema.default(LearningSchema.parse({})),
  eligibility: EligibilitySchema.default(EligibilitySchema.parse({})),
  /** agentId -> list of enabled skill names */
  agentSkills: z.record(z.string(), z.array(z.string())).default({}),
  integrations: IntegrationsSchema.default(IntegrationsSchema.parse({})),
  execution: ExecutionSchema.default(ExecutionSchema.parse({})),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

export async function getSettings(): Promise<Settings> {
  const rows = await getDb().select().from(schema.systemSettings);
  const raw: Record<string, unknown> = {};
  for (const r of rows) raw[r.key] = r.value;
  const parsed = SettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function updateSetting<K extends SettingsKey>(key: K, value: unknown, actor: string): Promise<Settings[K]> {
  const shape = SettingsSchema.shape[key];
  const parsed = shape.parse(value) as Settings[K];
  const db = getDb();
  await db
    .insert(schema.systemSettings)
    .values({ key, value: parsed as object, updatedBy: actor })
    .onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: parsed as object, updatedBy: actor, updatedAt: new Date() } });
  return parsed;
}

export async function getSettingRow(key: SettingsKey) {
  const [row] = await getDb().select().from(schema.systemSettings).where(eq(schema.systemSettings.key, key));
  return row;
}
