import { canonicalDomain, domainMatches, normalizeCompanyName } from "./normalize";
import { nameSimilarity } from "./dedup";

export type ExclusionScope = "company" | "domain" | "parent_company" | "legal_entity" | "sector" | "name";

export interface ExclusionRule {
  id?: string;
  scope: ExclusionScope;
  value: string;
  normalizedValue: string;
  category: string;
  reason: string;
  active: boolean;
}

export interface SuppressionRecord {
  identifierType: "domain" | "kvk" | "name" | "phone";
  identifierValue: string;
  reason: string;
}

export interface ExclusionSubject {
  companyId?: string | null;
  name: string;
  tradingName?: string | null;
  domain?: string | null;
  kvkNumber?: string | null;
  groupName?: string | null;
  groupDomain?: string | null;
  legalEntityNames?: string[];
  industryCode?: string | null;
  /** Business category assigned by research, e.g. "msp", "manufacturer". */
  businessCategory?: string | null;
  phone?: string | null;
  relationship?: string | null;
  previouslyDelivered?: boolean;
  reactivationApproved?: boolean;
}

export interface ExclusionResult {
  excluded: boolean;
  /** Suppression = legal/opt-out block; cannot be overridden by ordinary approval. */
  suppressed: boolean;
  reasons: { category: string; reason: string; ruleId?: string; overridable: boolean }[];
}

/** Normalise an exclusion value according to its scope. */
export function normalizeExclusionValue(scope: ExclusionScope, value: string): string {
  switch (scope) {
    case "domain":
      return canonicalDomain(value) ?? value.trim().toLowerCase();
    case "sector":
      return value.trim().toLowerCase();
    case "company":
      return value.trim();
    default:
      return normalizeCompanyName(value);
  }
}

const NAME_MATCH = 0.92;

function nameHit(rule: string, ...names: (string | null | undefined)[]): boolean {
  return names.some((n) => {
    if (!n) return false;
    const nn = normalizeCompanyName(n);
    if (!nn || !rule) return false;
    if (nn === rule) return true;
    // A rule like "visma" also covers "visma proactive", but only on token boundary.
    if ((" " + nn + " ").includes(" " + rule + " ") && rule.length >= 4) return true;
    return rule.length > 4 && nameSimilarity(nn, rule) >= NAME_MATCH;
  });
}

/**
 * Evaluate all hard exclusions and suppressions for a subject. Hard exclusions
 * always take precedence over scoring.
 */
export function evaluateExclusions(
  s: ExclusionSubject,
  rules: ExclusionRule[],
  suppressions: SuppressionRecord[],
  excludedCategories: string[] = [],
): ExclusionResult {
  const reasons: ExclusionResult["reasons"] = [];
  const domain = canonicalDomain(s.domain ?? null);
  const groupDomain = canonicalDomain(s.groupDomain ?? null);
  const kvk = s.kvkNumber?.replace(/\D/g, "") || null;

  // 1. Suppressions (opt-out / do-not-contact) — never overridable.
  let suppressed = false;
  for (const sup of suppressions) {
    const v = sup.identifierValue;
    const hit =
      (sup.identifierType === "domain" && domain && (domainMatches(domain, v) || (groupDomain != null && domainMatches(groupDomain, v)))) ||
      (sup.identifierType === "kvk" && kvk && kvk === v.replace(/\D/g, "")) ||
      (sup.identifierType === "name" && nameHit(v, s.name, s.tradingName)) ||
      (sup.identifierType === "phone" && s.phone && s.phone === v);
    if (hit) {
      suppressed = true;
      reasons.push({ category: "suppression", reason: `Opt-out/suppressie (${sup.reason})`, overridable: false });
    }
  }

  // 2. Relationship-based exclusions.
  if (s.relationship === "customer") reasons.push({ category: "customer", reason: "Bestaande Cloud Life klant", overridable: false });
  if (s.relationship === "active_opportunity") reasons.push({ category: "opportunity", reason: "Actieve Cloud Life sales-opportunity", overridable: false });
  if (s.relationship === "opted_out") {
    suppressed = true;
    reasons.push({ category: "suppression", reason: "Opt-out geregistreerd", overridable: false });
  }
  if (s.relationship === "rejected") reasons.push({ category: "rejected", reason: "Eerder afgewezen", overridable: true });
  if (s.previouslyDelivered && !s.reactivationApproved) {
    reasons.push({ category: "delivered", reason: "Eerder geleverd aan belbureau (geen reactivatie goedgekeurd)", overridable: true });
  }

  // 3. Business-category exclusions (competitors, MSPs, agencies…).
  if (s.businessCategory && excludedCategories.includes(s.businessCategory)) {
    reasons.push({ category: s.businessCategory, reason: `Uitgesloten categorie: ${s.businessCategory}`, overridable: false });
  }

  // 4. Explicit rules.
  for (const r of rules) {
    if (!r.active) continue;
    let hit = false;
    switch (r.scope) {
      case "company":
        hit = Boolean(s.companyId && s.companyId === r.normalizedValue);
        break;
      case "domain":
        hit = Boolean((domain && domainMatches(domain, r.normalizedValue)) || (groupDomain && domainMatches(groupDomain, r.normalizedValue)));
        break;
      case "name":
        hit = nameHit(r.normalizedValue, s.name, s.tradingName);
        break;
      case "parent_company":
        hit = nameHit(r.normalizedValue, s.groupName, s.name);
        break;
      case "legal_entity":
        hit = nameHit(r.normalizedValue, ...(s.legalEntityNames ?? []), s.name) || (kvk != null && r.value.replace(/\D/g, "") === kvk);
        break;
      case "sector":
        hit = Boolean(
          (s.industryCode && s.industryCode.toLowerCase() === r.normalizedValue) ||
            (s.businessCategory && s.businessCategory.toLowerCase() === r.normalizedValue),
        );
        break;
    }
    if (hit) reasons.push({ category: r.category, reason: r.reason, ruleId: r.id, overridable: r.category !== "seed" && r.category !== "competitor" });
  }

  return { excluded: reasons.length > 0, suppressed, reasons };
}
