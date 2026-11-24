import { z } from "zod";
import { CLASS_RANK, type EvidenceClass, type MsTech } from "./msEvidence";

/**
 * Transparent, configurable lead scoring. See SCORING_MODEL.md.
 * Commercial fit (0–100) is computed separately from evidence confidence (0–100).
 * The initial model is a hypothesis to be validated against commercial results.
 */
export const ScoringWeightsSchema = z.object({
  microsoftFit: z.number().nonnegative(),
  organizationSize: z.number().nonnegative(),
  industryFit: z.number().nonnegative(),
  securityCompliance: z.number().nonnegative(),
  purchasingAuthority: z.number().nonnegative(),
  buyingSignals: z.number().nonnegative(),
});
export const ScoringThresholdsSchema = z.object({
  exceptional: z.number(),
  strong: z.number(),
  research: z.number(),
  /** Minimum evidence confidence for exceptional/strong classifications. */
  minConfidenceForQualified: z.number(),
});
export const ScoringRulesSchema = z.object({
  sizeBands: z.array(z.object({ min: z.number(), max: z.number(), points: z.number().min(0).max(1) })),
  industryTierPoints: z.record(z.string(), z.number().min(0).max(1)),
  authorityPoints: z.record(z.string(), z.number().min(0).max(1)),
  signalMaxAgeDays: z.number().int(),
});
export type ScoringWeights = z.infer<typeof ScoringWeightsSchema>;
export type ScoringThresholds = z.infer<typeof ScoringThresholdsSchema>;
export type ScoringRules = z.infer<typeof ScoringRulesSchema>;
export interface ScoringConfig {
  weights: ScoringWeights;
  thresholds: ScoringThresholds;
  rules: ScoringRules;
}

export const DEFAULT_SCORING: ScoringConfig = {
  weights: { microsoftFit: 30, organizationSize: 25, industryFit: 15, securityCompliance: 15, purchasingAuthority: 10, buyingSignals: 5 },
  thresholds: { exceptional: 85, strong: 70, research: 55, minConfidenceForQualified: 60 },
  rules: {
    sizeBands: [
      { min: 300, max: 1999, points: 1 },
      { min: 2000, max: 5000, points: 0.88 },
      { min: 200, max: 299, points: 0.56 },
      { min: 50, max: 199, points: 0.4 },
      { min: 5001, max: 20000, points: 0.4 },
    ],
    industryTierPoints: { "1": 1, "2": 0.75, "3": 0.45, "4": 0.2, "0": 0 },
    authorityPoints: { nl_independent: 1, nl_group_hq: 1, nl_local_it: 0.7, unknown: 0.3, abroad_central: 0 },
    signalMaxAgeDays: 365,
  },
};

export interface ComplianceFactors {
  nis2?: "essential" | "important" | null;
  dora?: boolean;
  sensitiveData?: boolean;
  operationalTechnology?: boolean;
  certificationsOrRegulator?: boolean;
}

export interface SignalInput {
  relevance: "high" | "medium" | "low";
  signalDate?: string | Date | null;
  hasSource: boolean;
}

export interface FieldConfidence {
  /** 0..1 confidence per key field; omit = unknown */
  employees?: number;
  industry?: number;
  headquarters?: number;
  microsoft?: number;
  authority?: number;
  phone?: number;
  legalForm?: number;
}

export interface ScoringInput {
  msEvidence: Partial<Record<MsTech, EvidenceClass>>;
  employees: number | null;
  industryTier: number | null; // 1..4, 0 excluded
  compliance: ComplianceFactors;
  purchasingAuthority: string | null;
  signals: SignalInput[];
  fieldConfidence: FieldConfidence;
  /** Age in days of the oldest key fact used. */
  oldestFactAgeDays?: number;
  sourceCount: number;
  hardExclusion?: boolean;
}

export interface ScoreComponent {
  key: keyof ScoringWeights;
  label: string;
  points: number;
  max: number;
  explanation: string;
}

export type Classification = "exceptional" | "strong" | "requires_research" | "reject";

export interface ScoreResult {
  fitScore: number;
  confidenceScore: number;
  components: ScoreComponent[];
  classification: Classification;
  hardFailures: string[];
  missingInformation: string[];
  downgradedForConfidence: boolean;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function msFitRatio(ev: ScoringInput["msEvidence"]): { ratio: number; explanation: string } {
  const val = (c?: EvidenceClass) => (c ? Math.max(0, CLASS_RANK[c]) / 3 : 0);
  const mail = Math.max(val(ev.microsoft_365), val(ev.exchange_online));
  const contradicted = ev.microsoft_365 === "contradicted" || (ev.exchange_online === "contradicted" && !ev.microsoft_365);
  const stackTechs: MsTech[] = ["entra_id", "intune", "defender", "purview", "copilot", "azure", "sharepoint_online", "teams"];
  const stack = stackTechs.map((t) => val(ev[t])).sort((a, b) => b - a);
  const stackScore = Math.min(1, (stack[0] ?? 0) * 0.5 + (stack[1] ?? 0) * 0.3 + (stack[2] ?? 0) * 0.2);
  if (contradicted && mail === 0) return { ratio: 0, explanation: "Microsoft 365-gebruik tegengesproken (bijv. Google Workspace)" };
  const ratio = mail * 0.55 + stackScore * 0.45;
  const parts = Object.entries(ev)
    .filter(([, c]) => c && c !== "unknown")
    .map(([t, c]) => `${t}: ${c}`);
  return { ratio, explanation: parts.length ? parts.join(", ") : "Geen Microsoft-bewijs gevonden" };
}

function sizeRatio(employees: number | null, rules: ScoringRules): { ratio: number; explanation: string } {
  if (employees == null) return { ratio: 0, explanation: "Medewerkersaantal onbekend" };
  const band = rules.sizeBands.find((b) => employees >= b.min && employees <= b.max);
  return { ratio: band?.points ?? 0, explanation: `${employees} medewerkers` };
}

function complianceRatio(c: ComplianceFactors): { ratio: number; explanation: string } {
  let p = 0;
  const why: string[] = [];
  if (c.nis2 === "essential") (p += 0.4), why.push("NIS2 essentiële entiteit");
  else if (c.nis2 === "important") (p += 0.3), why.push("NIS2 belangrijke entiteit");
  if (c.dora) (p += 0.3), why.push("DORA van toepassing");
  if (c.sensitiveData) (p += 0.2), why.push("gevoelige gegevens");
  if (c.operationalTechnology) (p += 0.2), why.push("operationele/OT-afhankelijkheid");
  if (c.certificationsOrRegulator) (p += 0.1), why.push("toezichthouder/certificering");
  return { ratio: Math.min(1, p), explanation: why.length ? why.join(", ") : "Geen specifieke compliance-factoren vastgesteld" };
}

function signalRatio(signals: SignalInput[], rules: ScoringRules, now: Date): { ratio: number; explanation: string } {
  const pts = { high: 0.6, medium: 0.4, low: 0.2 };
  let total = 0;
  let counted = 0;
  for (const s of signals) {
    if (!s.hasSource) continue; // unsourced signals never count
    const d = s.signalDate ? new Date(s.signalDate) : null;
    if (d && (now.getTime() - d.getTime()) / 86400000 > rules.signalMaxAgeDays) continue;
    total += d ? pts[s.relevance] : pts[s.relevance] * 0.5; // undated signals count half
    counted++;
  }
  return { ratio: Math.min(1, total), explanation: counted ? `${counted} actuele, onderbouwde signalen` : "Geen actuele onderbouwde koopsignalen" };
}

/** Evidence confidence: how well the key facts are supported, independent of attractiveness. */
export function computeConfidence(fc: FieldConfidence, sourceCount: number, oldestFactAgeDays = 0): number {
  const weights: [keyof FieldConfidence, number][] = [
    ["employees", 0.2], ["industry", 0.1], ["headquarters", 0.1], ["microsoft", 0.25], ["authority", 0.15], ["phone", 0.1], ["legalForm", 0.1],
  ];
  let c = 0;
  for (const [k, w] of weights) c += (fc[k] ?? 0) * w;
  // Diversity of sources: <2 sources caps confidence.
  const diversity = sourceCount >= 3 ? 1 : sourceCount === 2 ? 0.9 : sourceCount === 1 ? 0.7 : 0.4;
  const freshness = oldestFactAgeDays > 365 ? 0.75 : oldestFactAgeDays > 180 ? 0.9 : 1;
  return Math.round(Math.max(0, Math.min(1, c * diversity * freshness)) * 100);
}

export function scoreCompany(input: ScoringInput, cfg: ScoringConfig = DEFAULT_SCORING, now = new Date()): ScoreResult {
  const { weights: w, rules } = cfg;
  const ms = msFitRatio(input.msEvidence);
  const size = sizeRatio(input.employees, rules);
  const tier = input.industryTier == null ? null : String(input.industryTier);
  const industryRatio = tier == null ? 0.3 : rules.industryTierPoints[tier] ?? 0.3;
  const comp = complianceRatio(input.compliance);
  const auth = input.purchasingAuthority ?? "unknown";
  const authRatio = rules.authorityPoints[auth] ?? rules.authorityPoints.unknown ?? 0.3;
  const sig = signalRatio(input.signals, rules, now);

  const components: ScoreComponent[] = [
    { key: "microsoftFit", label: "Microsoft-technologie fit", max: w.microsoftFit, points: round1(ms.ratio * w.microsoftFit), explanation: ms.explanation },
    { key: "organizationSize", label: "Organisatieomvang", max: w.organizationSize, points: round1(size.ratio * w.organizationSize), explanation: size.explanation },
    { key: "industryFit", label: "Sector- en operationele fit", max: w.industryFit, points: round1(industryRatio * w.industryFit), explanation: tier == null ? "Sector onbekend" : `Prioriteitstier ${tier}` },
    { key: "securityCompliance", label: "Security- en compliance-relevantie", max: w.securityCompliance, points: round1(comp.ratio * w.securityCompliance), explanation: comp.explanation },
    { key: "purchasingAuthority", label: "Nederlandse inkoopbevoegdheid", max: w.purchasingAuthority, points: round1(authRatio * w.purchasingAuthority), explanation: auth },
    { key: "buyingSignals", label: "Actuele koopsignalen", max: w.buyingSignals, points: round1(sig.ratio * w.buyingSignals), explanation: sig.explanation },
  ];
  const maxTotal = components.reduce((s, c) => s + c.max, 0) || 1;
  const fitScore = Math.round((components.reduce((s, c) => s + c.points, 0) / maxTotal) * 100);
  const confidenceScore = computeConfidence(input.fieldConfidence, input.sourceCount, input.oldestFactAgeDays);

  const hardFailures: string[] = [];
  if (input.hardExclusion) hardFailures.push("Harde uitsluiting of contactbeperking");
  if (input.employees != null && input.employees < 50) hardFailures.push("Minder dan 50 medewerkers");
  if (input.employees != null && input.employees > 5000 * 4) hardFailures.push("Ver boven ICP-maximum");
  if (auth === "abroad_central") hardFailures.push("IT-inkoop gecentraliseerd in het buitenland");
  if (input.industryTier === 0) hardFailures.push("Uitgesloten sector");
  if (ms.ratio === 0 && input.msEvidence.microsoft_365 === "contradicted") hardFailures.push("Geen Microsoft-omgeving (tegengesproken)");

  const missing: string[] = [];
  if (input.employees == null) missing.push("Medewerkersaantal");
  if (!input.fieldConfidence.microsoft) missing.push("Microsoft-technologiebewijs");
  if (auth === "unknown") missing.push("Locatie IT-inkoopbeslissing");
  if (!input.fieldConfidence.phone) missing.push("Openbaar bedrijfstelefoonnummer");
  if (!input.fieldConfidence.legalForm) missing.push("Rechtsvorm (contactgeschiktheid)");
  if (tier == null) missing.push("Sector");

  const t = cfg.thresholds;
  let classification: Classification =
    fitScore >= t.exceptional ? "exceptional" : fitScore >= t.strong ? "strong" : fitScore >= t.research ? "requires_research" : "reject";
  let downgraded = false;
  if ((classification === "exceptional" || classification === "strong") && confidenceScore < t.minConfidenceForQualified) {
    classification = "requires_research";
    downgraded = true;
  }
  if (hardFailures.length) classification = "reject";

  return { fitScore, confidenceScore, components, classification, hardFailures, missingInformation: missing, downgradedForConfidence: downgraded };
}

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  exceptional: "Uitzonderlijke kans",
  strong: "Sterke kans",
  requires_research: "Aanvullend onderzoek nodig",
  reject: "Afwijzen",
};

/**
 * Prescreen potential: what this company could plausibly score once unknown fields are
 * researched. Unknown size, authority and Microsoft evidence get a bounded "expected" value;
 * known negatives (contradicted Microsoft, abroad authority, tiny size) are not forgiven.
 * Used only to decide whether further (paid) research is worth it — never for delivery.
 */
export function potentialScore(input: ScoringInput, cfg: ScoringConfig = DEFAULT_SCORING): number {
  const r = scoreCompany(input, cfg);
  if (r.hardFailures.length) return 0;
  const w = cfg.weights;
  const total = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  let upside = 0;
  const comp = (k: keyof ScoringWeights) => r.components.find((c) => c.key === k)!;
  if (input.employees == null) upside += w.organizationSize * 0.6 - comp("organizationSize").points;
  if (!input.purchasingAuthority || input.purchasingAuthority === "unknown") upside += w.purchasingAuthority * 0.75 - comp("purchasingAuthority").points;
  const ms = comp("microsoftFit");
  if (ms.points < w.microsoftFit * 0.4 && !Object.values(input.msEvidence).includes("contradicted")) upside += w.microsoftFit * 0.45 - ms.points;
  if (input.industryTier == null) upside += w.industryFit * 0.6 - comp("industryFit").points;
  return Math.max(0, Math.min(100, Math.round(r.fitScore + (Math.max(0, upside) / total) * 100)));
}

/** Plain-language rationale generated from the score components (no model call). */
export function templateRationale(r: ScoreResult, serviceLabel: string, serviceReasons: string[]): string {
  const top = [...r.components].sort((a, b) => b.points / (b.max || 1) - a.points / (a.max || 1)).slice(0, 3);
  const weak = r.components.filter((c) => c.max && c.points / c.max < 0.35).map((c) => c.label.toLowerCase());
  return `Fit ${r.fitScore}/100 bij bewijsbetrouwbaarheid ${r.confidenceScore}/100. Sterkst: ${top.map((c) => `${c.label.toLowerCase()} (${c.explanation})`).join("; ")}.` +
    `${weak.length ? ` Zwakker: ${weak.join(", ")}.` : ""} Aanbevolen instap: ${serviceLabel} — ${serviceReasons.join("; ")}.`;
}
