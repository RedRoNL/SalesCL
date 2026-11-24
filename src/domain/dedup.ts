import { distance } from "fastest-levenshtein";
import { canonicalDomain, domainMatches, normalizeCompanyName } from "./normalize";

/** Minimal identity of a company used for duplicate detection. */
export interface CompanyIdentity {
  id?: string;
  name: string;
  aliases?: string[];
  domain?: string | null;
  kvkNumber?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  groupDomain?: string | null;
}

export interface DuplicateMatch {
  matchedId?: string;
  matchedName: string;
  reason: "kvk" | "domain" | "exact_name" | "fuzzy_name" | "parent_group" | "alias";
  similarity: number;
}

/** Normalised Levenshtein similarity in [0,1]. */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeCompanyName(a);
  const y = normalizeCompanyName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const lev = 1 - distance(x, y) / Math.max(x.length, y.length);
  // Token-set similarity catches word re-ordering ("Transport Jansen" vs "Jansen Transport").
  const tx = new Set(x.split(" "));
  const ty = new Set(y.split(" "));
  const inter = [...tx].filter((t) => ty.has(t)).length;
  const tokenSet = inter / Math.max(tx.size, ty.size);
  return Math.max(lev, tokenSet === 1 ? 0.97 : tokenSet * 0.9);
}

export const FUZZY_THRESHOLD = 0.9;

/**
 * Find whether `candidate` duplicates any `existing` company. Checks in order of
 * reliability: KvK number, canonical domain, parent-group relation, exact
 * normalised name/alias, fuzzy name.
 *
 * Short names (≤4 chars normalised) only match exactly, to avoid "ABB" ≈ "ABN".
 */
export function findDuplicate(candidate: CompanyIdentity, existing: CompanyIdentity[]): DuplicateMatch | null {
  const cDomain = canonicalDomain(candidate.domain ?? null);
  const cName = normalizeCompanyName(candidate.name);
  const cKvk = candidate.kvkNumber?.replace(/\D/g, "") || null;
  let best: DuplicateMatch | null = null;

  for (const e of existing) {
    if (candidate.id && e.id === candidate.id) continue;
    const eKvk = e.kvkNumber?.replace(/\D/g, "") || null;
    if (cKvk && eKvk && cKvk === eKvk) return { matchedId: e.id, matchedName: e.name, reason: "kvk", similarity: 1 };

    const eDomain = canonicalDomain(e.domain ?? null);
    if (cDomain && eDomain && cDomain === eDomain) return { matchedId: e.id, matchedName: e.name, reason: "domain", similarity: 1 };

    // Parent / subsidiary duplication: same group, or candidate's domain is the group's domain.
    if (candidate.groupId && e.groupId && candidate.groupId === e.groupId) {
      best = pick(best, { matchedId: e.id, matchedName: e.name, reason: "parent_group", similarity: 0.95 });
    }
    const eGroupDomain = canonicalDomain(e.groupDomain ?? null);
    if (cDomain && eGroupDomain && domainMatches(cDomain, eGroupDomain)) {
      best = pick(best, { matchedId: e.id, matchedName: e.name, reason: "parent_group", similarity: 0.95 });
    }
    if (candidate.groupName && normalizeCompanyName(candidate.groupName) === normalizeCompanyName(e.name)) {
      best = pick(best, { matchedId: e.id, matchedName: e.name, reason: "parent_group", similarity: 0.93 });
    }

    const eName = normalizeCompanyName(e.name);
    if (cName && cName === eName) {
      best = pick(best, { matchedId: e.id, matchedName: e.name, reason: "exact_name", similarity: 1 });
      continue;
    }
    for (const alias of e.aliases ?? []) {
      if (normalizeCompanyName(alias) === cName) best = pick(best, { matchedId: e.id, matchedName: e.name, reason: "alias", similarity: 1 });
    }
    if (cName.length > 4 && eName.length > 4) {
      const sim = nameSimilarity(candidate.name, e.name);
      // Fuzzy matches with *different* known domains are distinct companies.
      if (sim >= FUZZY_THRESHOLD && !(cDomain && eDomain && cDomain !== eDomain)) {
        best = pick(best, { matchedId: e.id, matchedName: e.name, reason: "fuzzy_name", similarity: sim });
      }
    }
  }
  return best;
}

function pick(a: DuplicateMatch | null, b: DuplicateMatch): DuplicateMatch {
  if (!a) return b;
  return b.similarity > a.similarity ? b : a;
}

/** Deduplicate a batch of candidates against each other and against existing records. */
export function dedupeBatch<T extends CompanyIdentity>(
  batch: T[],
  existing: CompanyIdentity[],
): { unique: T[]; duplicates: { candidate: T; match: DuplicateMatch }[] } {
  const unique: T[] = [];
  const duplicates: { candidate: T; match: DuplicateMatch }[] = [];
  for (const c of batch) {
    const m = findDuplicate(c, existing) ?? findDuplicate(c, unique);
    if (m) duplicates.push({ candidate: c, match: m });
    else unique.push(c);
  }
  return { unique, duplicates };
}
