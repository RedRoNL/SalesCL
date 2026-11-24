/**
 * Normalisation utilities for company identity resolution.
 * Pure functions — no I/O.
 */

// Token-level legal/generic suffixes (dots already removed: "B.V." → "bv").
const LEGAL_SUFFIXES = [
  "bv", "nv", "vof", "cv", "holding", "holdings", "groep", "group", "nederland", "netherlands", "the netherlands",
  "international", "europe", "benelux", "gmbh", "ltd", "limited", "inc", "plc", "sa", "ag",
  "stichting", "vereniging", "cooperatie", "ua", "wa", "b v", "n v",
];
const STOP_PREFIXES = ["koninklijke", "royal", "de", "het", "the"];

export function stripDiacritics(s: string): string {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Normalise a company name for matching: lower-case, no diacritics, no
 * punctuation, legal suffixes and generic prefixes removed.
 * "Koninklijke Van der Wal Transport B.V." → "van der wal transport"
 */
export function normalizeCompanyName(name: string): string {
  let s = stripDiacritics(name.toLowerCase())
    .replace(/&/g, " en ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\.(?=\S)/g, "") // "b.v." → "bv."
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      if (s.endsWith(" " + suf)) {
        s = s.slice(0, -suf.length - 1).trim();
        changed = true;
        break;
      }
    }
  }
  const tokens = s.split(" ").filter(Boolean);
  while (tokens.length > 1 && STOP_PREFIXES.includes(tokens[0])) tokens.shift();
  return tokens.join(" ");
}

// Multi-label public suffixes we routinely see. Not a full PSL — sufficient for
// registrable-domain extraction for Dutch/European company domains.
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "co.nz", "co.za", "com.br", "co.jp",
  "com.tr", "com.cn", "com.sg", "co.in", "com.mx", "com.ar",
]);

/**
 * Canonical registrable domain from a URL, email or host.
 * "https://www.Example.nl/over-ons?x=1" → "example.nl"
 * Returns null for invalid input or IP addresses.
 */
export function canonicalDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("@") && !s.includes("/")) s = s.split("@").pop()!;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#]/)[0];
  s = s.split(":")[0];
  s = s.replace(/\.+$/, "");
  if (!s || /^\d+\.\d+\.\d+\.\d+$/.test(s) || s.includes("[")) return null;
  try {
    // punycode-normalise IDNs
    s = new URL(`http://${s}`).hostname;
  } catch {
    return null;
  }
  const labels = s.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  if (!labels.every((l) => /^[a-z0-9-]+$/.test(l) && !l.startsWith("-") && !l.endsWith("-"))) return null;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_PART_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join(".");
  return lastTwo;
}

/** True when `domain` equals or is a subdomain of `parent`. */
export function domainMatches(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith("." + parent);
}

const LEGAL_FORM_PATTERNS: [RegExp, string][] = [
  [/\bbesloten vennootschap\b|\bb\.?\s?v\.?\b/, "bv"],
  [/\bnaamloze vennootschap\b|\bn\.?\s?v\.?\b/, "nv"],
  [/\bstichting\b/, "stichting"],
  [/\bvereniging\b/, "vereniging"],
  [/\bco[öo]peratie\b|\bu\.?a\.?\b|\bw\.?a\.?\b/, "cooperatie"],
  [/\bonderlinge waarborgmaatschappij\b|\bowm\b/, "owm"],
  [/\bvennootschap onder firma\b|\bv\.?o\.?f\.?\b/, "vof"],
  [/\bcommanditaire vennootschap\b|\bc\.?v\.?\b/, "cv"],
  [/\beenmanszaak\b/, "eenmanszaak"],
  [/\bmaatschap\b/, "maatschap"],
  [/\bgemeente\b/, "gemeente"],
  [/\bpubliekrechtelijk|\bwaterschap\b|\bprovincie\b|\bministerie\b|\brijksoverheid\b/, "publiekrechtelijk"],
  [/\bsocietas europaea\b|\bs\.?e\.?\b/, "se"],
];

/** Map free-text legal form (from KvK or website) to a normalised code, or null. */
export function normalizeLegalForm(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = stripDiacritics(input.toLowerCase());
  for (const [re, code] of LEGAL_FORM_PATTERNS) if (re.test(s)) return code;
  return null;
}

/**
 * Normalise a Dutch phone number to E.164-ish "+31…" format.
 * Returns null when the input does not look like a valid NL number.
 */
export function normalizePhoneNL(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.replace(/\(0\)/g, "").replace(/[^\d+]/g, "");
  if (s.startsWith("0031")) s = "+31" + s.slice(4);
  else if (s.startsWith("31") && s.length === 11) s = "+" + s;
  else if (s.startsWith("0") && s.length === 10) s = "+31" + s.slice(1);
  if (!/^\+31\d{9}$/.test(s)) {
    // allow 0800/0900 service numbers (8–11 digits after 0)
    if (/^\+3180\d{5,9}$/.test(s) || /^\+3190\d{5,9}$/.test(s)) return s;
    return null;
  }
  return s;
}

export function isDutchMobile(phone: string | null | undefined): boolean {
  return Boolean(phone && /^\+316\d{8}$/.test(phone));
}

/** ISO-8601 week label, e.g. "2026-W48", computed in the given IANA time zone. */
export function isoWeek(date: Date, timeZone = "Europe/Amsterdam"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const [y, m, d] = parts.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (t.getUTCDay() + 6) % 7; // Mon=0
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function formatProspectId(n: number): string {
  return `CLSA-${String(n).padStart(6, "0")}`;
}

export function sizeBand(employees: number | null | undefined): "lt50" | "50-299" | "300-1999" | "2000-5000" | "gt5000" | "unknown" {
  if (employees == null) return "unknown";
  if (employees < 50) return "lt50";
  if (employees < 300) return "50-299";
  if (employees < 2000) return "300-1999";
  if (employees <= 5000) return "2000-5000";
  return "gt5000";
}

/** Best single employee estimate from count or range midpoint. */
/**
 * True only when the sourced size is DEFINITELY outside [min, max]: an exact count outside the band, or a range that
 * does not overlap it. "More than 250" (min only) can still be 300+, so it is not a rejection (live-pilot finding).
 */
export function sizeDefinitelyOutside(c: { employeeCount?: number | null; employeeMin?: number | null; employeeMax?: number | null }, bounds: { min: number; max: number }): boolean {
  if (c.employeeCount != null) return c.employeeCount < bounds.min || c.employeeCount > bounds.max;
  if (c.employeeMax != null && c.employeeMax < bounds.min) return true;
  if (c.employeeMin != null && c.employeeMin > bounds.max) return true;
  return false;
}

export function employeeEstimate(c: { employeeCount?: number | null; employeeMin?: number | null; employeeMax?: number | null }): number | null {
  if (c.employeeCount != null) return c.employeeCount;
  if (c.employeeMin != null && c.employeeMax != null) return Math.round((c.employeeMin + c.employeeMax) / 2);
  return c.employeeMin ?? c.employeeMax ?? null;
}
