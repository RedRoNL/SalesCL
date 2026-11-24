import { MODEL_PRICING_USD, WEB_SEARCH_USD_PER_SEARCH } from "./costs";

/**
 * Operating-cost model for delivering N qualified prospects per week with the v2 funnel.
 * Every assumption is explicit and editable; scenarios differ in yield and research depth.
 * Token figures are per task and include adaptive-thinking overhead. Prompt caching is
 * ignored (it only lowers costs), so the estimates are deliberately on the high side.
 */
export interface CostAssumptions {
  label: string;
  qualifiedPerWeek: number;
  candidatesPerQualified: number; // funnel yield
  shareWithoutWebsite: number; // need a website search
  shareRejectedAtScreen: number; // free rejection (no model call)
  shareDeepResearch: number; // of extracted
  shareMsSpecialist: number; // of extracted
  shareSignals: number; // of extracted
  shareQa: number; // QA calls per qualified prospect (QA also sees some that fail)
  newCandidatesPerHarvest: number;
  queryHarvestShare: number; // harvests that are search templates (paid search)
  llmListExtractionsPerHarvest: number;
  scoutsPerWeek: number;
  huntsPerWeek: number;
  kvkLookupsPerExtracted: number; // 0 when KvK API not used
  models: { fast: string; standard: string; strong: string; qa: string };
  usdToEur: number;
}

const BASE = { models: { fast: "claude-haiku-5-5", standard: "claude-sonnet-5-5", strong: "claude-opus-5-5", qa: "claude-opus-5-5" }, usdToEur: 0.92, kvkLookupsPerExtracted: 0.6 };

export const SCENARIOS: Record<"conservative" | "realistic" | "high_volume", CostAssumptions> = {
  conservative: { ...BASE, label: "Conservatief (lage opbrengst, veel verdieping)", qualifiedPerWeek: 100, candidatesPerQualified: 4.5, shareWithoutWebsite: 0.4, shareRejectedAtScreen: 0.25, shareDeepResearch: 0.55, shareMsSpecialist: 0.4, shareSignals: 0.45, shareQa: 1.5, newCandidatesPerHarvest: 8, queryHarvestShare: 0.5, llmListExtractionsPerHarvest: 4, scoutsPerWeek: 8, huntsPerWeek: 6 },
  realistic: { ...BASE, label: "Realistisch", qualifiedPerWeek: 100, candidatesPerQualified: 3, shareWithoutWebsite: 0.3, shareRejectedAtScreen: 0.3, shareDeepResearch: 0.35, shareMsSpecialist: 0.25, shareSignals: 0.4, shareQa: 1.25, newCandidatesPerHarvest: 12, queryHarvestShare: 0.4, llmListExtractionsPerHarvest: 3, scoutsPerWeek: 5, huntsPerWeek: 3 },
  high_volume: { ...BASE, label: "Hoog volume (200 per week)", qualifiedPerWeek: 200, candidatesPerQualified: 3.2, shareWithoutWebsite: 0.3, shareRejectedAtScreen: 0.3, shareDeepResearch: 0.35, shareMsSpecialist: 0.25, shareSignals: 0.4, shareQa: 1.25, newCandidatesPerHarvest: 12, queryHarvestShare: 0.45, llmListExtractionsPerHarvest: 3, scoutsPerWeek: 8, huntsPerWeek: 5 },
};

/** Per-task token profiles (input incl. tool results across turns; output incl. thinking). */
const TASKS = {
  listExtraction: { tier: "fast", input: 7000, output: 2500 },
  extractProfile: { tier: "fast", input: 14000, output: 3000 },
  msSpecialist: { tier: "fast", input: 40000, output: 5000, searches: 2 },
  signals: { tier: "fast", input: 30000, output: 4000, searches: 2 },
  deepResearch: { tier: "standard", input: 70000, output: 7000, searches: 2 },
  qa: { tier: "qa", input: 45000, output: 8000 },
  scout: { tier: "standard", input: 90000, output: 9000, searches: 4 },
  hunt: { tier: "standard", input: 110000, output: 10000, searches: 5 },
  csoPlan: { tier: "strong", input: 30000, output: 8000 },
  csoApprove: { tier: "strong", input: 20000, output: 6000 },
  rationaleBatch: { tier: "standard", input: 25000, output: 9000 },
  feedback: { tier: "standard", input: 20000, output: 5000 },
  searchCall: { tier: "fast", input: 3000, output: 400 }, // Claude web search wrapper call
} as const;

function taskUsd(t: { tier: string; input: number; output: number; searches?: number }, a: CostAssumptions) {
  const model = a.models[t.tier as keyof CostAssumptions["models"]];
  const p = MODEL_PRICING_USD[model] ?? MODEL_PRICING_USD["claude-opus-5-5"];
  const searchCost = (t.searches ?? 0) * (WEB_SEARCH_USD_PER_SEARCH + searchCallUsd(a));
  return (t.input * p.input + t.output * p.output) / 1_000_000 + searchCost;
}
function searchCallUsd(a: CostAssumptions) {
  const p = MODEL_PRICING_USD[a.models.fast];
  return (TASKS.searchCall.input * p.input + TASKS.searchCall.output * p.output) / 1_000_000;
}

export interface CostLine {
  item: string;
  count: number;
  eurPerUnit: number;
  eurPerWeek: number;
}

export function estimateWeeklyCost(a: CostAssumptions, opts: { kvk: boolean; firecrawlSubscription: boolean } = { kvk: true, firecrawlSubscription: false }) {
  const eur = (usd: number) => usd * a.usdToEur;
  const candidates = a.qualifiedPerWeek * a.candidatesPerQualified;
  const extracted = candidates * (1 - a.shareRejectedAtScreen);
  const harvests = candidates / a.newCandidatesPerHarvest;
  const lines: CostLine[] = [];
  const add = (item: string, count: number, usdPerUnit: number) => lines.push({ item, count: Math.round(count), eurPerUnit: eur(usdPerUnit), eurPerWeek: eur(usdPerUnit) * count });
  const searchUsd = WEB_SEARCH_USD_PER_SEARCH + searchCallUsd(a);
  add("Bronnen oogsten: zoekopdrachten (zoeksjablonen)", harvests * a.queryHarvestShare, searchUsd);
  add("Bronnen oogsten: lijstextractie (snel model)", harvests * a.llmListExtractionsPerHarvest, taskUsd(TASKS.listExtraction, a));
  add("Website opzoeken voor kandidaten zonder URL", candidates * a.shareWithoutWebsite, searchUsd);
  add("Screening (eigen site, DNS, regex) — gratis", candidates, 0);
  add("Profielextractie (snel model, 1 call)", extracted, taskUsd(TASKS.extractProfile, a));
  add("Gatenvulling (standaardmodel, tools)", extracted * a.shareDeepResearch, taskUsd(TASKS.deepResearch, a));
  add("Microsoft-specialist (alleen bij zwak bewijs)", extracted * a.shareMsSpecialist, taskUsd(TASKS.msSpecialist, a));
  add("Koopsignalen (alleen hoge fit)", extracted * a.shareSignals, taskUsd(TASKS.signals, a));
  add("QA Director (sterk model)", a.qualifiedPerWeek * a.shareQa, taskUsd(TASKS.qa, a));
  add("Bronnen scouten (Market Intelligence)", a.scoutsPerWeek, taskUsd(TASKS.scout, a));
  add("Gerichte jacht (hunters)", a.huntsPerWeek, taskUsd(TASKS.hunt, a));
  add("CSO strategie + lijstbeoordeling", 1, taskUsd(TASKS.csoPlan, a) + taskUsd(TASKS.csoApprove, a));
  add("Onderbouwing in batches (20 per call)", Math.ceil(a.qualifiedPerWeek / 20), taskUsd(TASKS.rationaleBatch, a));
  add("Wekelijkse feedbackanalyse", 1, taskUsd(TASKS.feedback, a));
  if (opts.kvk) lines.push({ item: "KvK Basisprofiel (€0,02 per bevraging)", count: Math.round(extracted * a.kvkLookupsPerExtracted), eurPerUnit: 0.02, eurPerWeek: extracted * a.kvkLookupsPerExtracted * 0.02 });
  const variable = lines.reduce((s, l) => s + l.eurPerWeek, 0);
  const fixedMonthly = (opts.kvk ? 6.2 : 0) + (opts.firecrawlSubscription ? 19 * a.usdToEur : 0);
  return {
    assumptions: a, candidates: Math.round(candidates), lines,
    weeklyEur: variable + fixedMonthly / 4.33,
    monthlyEur: variable * 4.33 + fixedMonthly,
    perQualifiedEur: (variable + fixedMonthly / 4.33) / a.qualifiedPerWeek,
    fixedMonthlyEur: fixedMonthly,
  };
}
