/**
 * Deterministic extraction from retrieved pages — zero model cost.
 * Every finding carries the exact quote and the source it came from, so it can
 * be stored as evidence and re-verified by QA.
 */
import { normalizePhoneNL, isDutchMobile, normalizeLegalForm, canonicalDomain } from "@/domain/normalize";
import type { EvidenceClass, MsTech } from "@/domain/msEvidence";
import type { PageLink } from "./types";

export type PageKind = "home" | "contact" | "about" | "legal" | "careers" | "news" | "other";

export interface ExtractPage {
  sourceId: string;
  url: string;
  kind: PageKind;
  text: string;
}

export interface Finding<T> {
  value: T;
  quote: string;
  sourceId: string;
  pageKind: PageKind;
}

export interface DeterministicProfile {
  phones: Finding<string>[];
  kvk: Finding<string>[];
  legalForms: Finding<string>[];
  employees: Finding<number>[];
  msMentions: (Finding<MsTech> & { classification: EvidenceClass; evidenceType: string })[];
  securityVacancies: Finding<string>[];
  certifications: Finding<string>[];
  bestPhone: Finding<string> | null;
  bestEmployees: Finding<number> | null;
  bestKvk: Finding<string> | null;
  bestLegalForm: Finding<string> | null;
}

const PAGE_KEYWORDS: [PageKind, RegExp][] = [
  ["contact", /\b(contact|neem-contact|contactgegevens|bereikbaarheid|locaties?|vestigingen)\b/i],
  ["about", /\b(over-ons|over ons|about|wie-zijn-wij|organisatie|bedrijfsprofiel|onze-organisatie|het-bedrijf|company|profiel|feiten-en-cijfers|kerncijfers)\b/i],
  ["legal", /\b(colofon|disclaimer|algemene-voorwaarden|voorwaarden|privacy|impressum|juridisch|legal|cookie)\b/i],
  ["careers", /\b(vacatures?|werken-bij|werkenbij|werken bij|careers?|jobs|banen|carriere|carrière)\b/i],
  ["news", /\b(nieuws|news|pers|press|actueel)\b/i],
];

export function classifyLink(l: PageLink): PageKind {
  const hay = `${l.href} ${l.text}`.toLowerCase();
  for (const [kind, re] of PAGE_KEYWORDS) if (re.test(hay)) return kind;
  return "other";
}

/** Pick at most one subpage per useful kind on the company's own site (or its werkenbij-domain). */
export function selectSubpages(home: string, links: PageLink[], max = 5): { url: string; kind: PageKind }[] {
  const domain = canonicalDomain(home);
  const label = domain?.split(".")[0] ?? "";
  const byKind = new Map<PageKind, string>();
  for (const l of links) {
    const d = canonicalDomain(l.href);
    const own = d === domain || (label.length > 3 && d?.includes(label) && /werkenbij|careers|jobs/i.test(l.href));
    if (!own || /\.(pdf|jpg|png|zip|docx?)($|\?)/i.test(l.href)) continue;
    const kind = classifyLink(l);
    if (kind === "other" || byKind.has(kind)) continue;
    byKind.set(kind, l.href);
  }
  const order: PageKind[] = ["contact", "about", "legal", "careers", "news"];
  return order.filter((k) => byKind.has(k)).slice(0, max).map((k) => ({ url: byKind.get(k)!, kind: k }));
}

const quoteAt = (text: string, idx: number, len: number, pad = 80) => text.slice(Math.max(0, idx - pad), Math.min(text.length, idx + len + pad)).replace(/\s+/g, " ").trim();

const PHONE_RE = /(?:\+31|0031|\b0)[\s\-.]?(?:\(0\)[\s\-.]?)?[1-9](?:[\s\-.]?\d){8}\b/g;
const KVK_RE = /(?:kvk|k\.v\.k\.|kamer van koophandel|chamber of commerce|coc|handelsregister)[^0-9]{0,30}(\d{8})\b/gi;
const LEGAL_RE = /\b([A-Z][\w&'.-]*(?:\s+[A-Z&][\w&'.-]*){0,6})\s+(B\.\s?V\.?|BV|N\.\s?V\.?|NV)\b|\b(Stichting|Vereniging|Coöperatie|Cooperatie)\s+([A-Z][\w&'.-]*(?:\s+[A-Za-z&][\w&'.-]*){0,6})/g;
const EMP_RE = /(?:ruim|meer dan|circa|ca\.?|ongeveer|bijna|zo'n|over|more than|approximately|around)?\s*(\d{1,3}(?:[.,]\d{3})+|\d{2,5})\s*\+?\s*(?:medewerkers|werknemers|collega'?s|fte|employees|mensen in dienst|professionals|people)\b/gi;

const MS_PATTERNS: [MsTech, RegExp][] = [
  ["microsoft_365", /\b(Microsoft 365|Office 365|M365|O365)\b/g],
  ["exchange_online", /\bExchange Online\b/g],
  ["entra_id", /\b(Entra ID|Microsoft Entra|Azure AD|Azure Active Directory)\b/g],
  ["azure", /\b(Microsoft Azure|Azure)\b(?!\s*(AD|Active Directory))/g],
  ["intune", /\b(Microsoft Intune|Intune|Endpoint Manager)\b/g],
  ["defender", /\b(Microsoft Defender|Defender for (Endpoint|Office 365|Identity|Cloud)|Microsoft Sentinel)\b/g],
  ["purview", /\b(Microsoft Purview|Purview|sensitivity labels?|Microsoft Information Protection)\b/g],
  ["copilot", /\b(Microsoft 365 Copilot|Copilot)\b/g],
  ["sharepoint_online", /\b(SharePoint)\b/g],
  ["teams", /\b(Microsoft Teams)\b/g],
];
const ADOPTION_RE = /(wij|we|onze organisatie)\s+(werken|werkt|gebruiken|gebruikt|maken gebruik)|migratie naar|overgestapt (op|naar)|geïmplementeerd|uitgerold|in gebruik|we use|we work with|implemented|rolled out|migrated to/i;
const SECURITY_ROLE_RE = /\b(CISO|security officer|informatiebeveiliging(sadviseur|scoördinator|sbeheerder)?|IT[- ]security|cyber ?security (specialist|engineer|officer|consultant)|security engineer|privacy officer|functionaris gegevensbescherming|IT[- ]manager|hoofd ICT|ICT[- ]manager|CIO)\b/gi;
const CERT_RE = /\b(ISO[\s/-]?27001|NEN[\s-]?7510|ISO[\s-]?27701|SOC ?2|BIO\b|NIS2|DORA)\b/g;

function parseNumber(s: string): number {
  return Number(s.replace(/[.,](?=\d{3}\b)/g, ""));
}

export function extractDeterministic(pages: ExtractPage[]): DeterministicProfile {
  const p: DeterministicProfile = { phones: [], kvk: [], legalForms: [], employees: [], msMentions: [], securityVacancies: [], certifications: [], bestPhone: null, bestEmployees: null, bestKvk: null, bestLegalForm: null };
  for (const page of pages) {
    const t = page.text;
    for (const m of t.matchAll(PHONE_RE)) {
      const n = normalizePhoneNL(m[0]);
      if (n && !isDutchMobile(n)) p.phones.push({ value: n, quote: quoteAt(t, m.index!, m[0].length, 40), sourceId: page.sourceId, pageKind: page.kind });
    }
    for (const m of t.matchAll(KVK_RE)) p.kvk.push({ value: m[1], quote: quoteAt(t, m.index!, m[0].length, 30), sourceId: page.sourceId, pageKind: page.kind });
    for (const m of t.matchAll(LEGAL_RE)) {
      const form = normalizeLegalForm(m[2] ?? m[3] ?? "");
      if (form) p.legalForms.push({ value: form, quote: quoteAt(t, m.index!, m[0].length, 20), sourceId: page.sourceId, pageKind: page.kind });
    }
    for (const m of t.matchAll(EMP_RE)) {
      const n = parseNumber(m[1]);
      if (n >= 10 && n <= 200000) p.employees.push({ value: n, quote: quoteAt(t, m.index!, m[0].length, 60), sourceId: page.sourceId, pageKind: page.kind });
    }
    for (const [tech, re] of MS_PATTERNS) {
      for (const m of t.matchAll(re)) {
        const quote = quoteAt(t, m.index!, m[0].length, 100);
        // Vacancy text asking for a product = organisation runs or plans it; own-site adoption phrasing = strong.
        const cls: EvidenceClass = page.kind === "careers" || ADOPTION_RE.test(quote) ? "strongly_indicated" : "weakly_indicated";
        p.msMentions.push({ value: tech, quote, sourceId: page.sourceId, pageKind: page.kind, classification: cls, evidenceType: page.kind === "careers" ? "vacancy" : "website" });
        break; // one mention per tech per page is enough
      }
    }
    if (page.kind === "careers") for (const m of t.matchAll(SECURITY_ROLE_RE)) p.securityVacancies.push({ value: m[0], quote: quoteAt(t, m.index!, m[0].length, 60), sourceId: page.sourceId, pageKind: page.kind });
    for (const m of t.matchAll(CERT_RE)) p.certifications.push({ value: m[0].toUpperCase().replace(/\s/g, ""), quote: quoteAt(t, m.index!, m[0].length, 50), sourceId: page.sourceId, pageKind: page.kind });
  }
  // Best phone: prefer contact page, then most frequent.
  const freq = new Map<string, number>();
  for (const ph of p.phones) freq.set(ph.value, (freq.get(ph.value) ?? 0) + (ph.pageKind === "contact" ? 3 : 1));
  const topPhone = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  p.bestPhone = p.phones.find((x) => x.value === topPhone && x.pageKind === "contact") ?? p.phones.find((x) => x.value === topPhone) ?? null;
  // Best employees: prefer about/home pages and the largest plausible statement (group totals tend to be on about pages).
  p.bestEmployees = [...p.employees].sort((a, b) => (b.pageKind === "about" ? 1 : 0) - (a.pageKind === "about" ? 1 : 0) || b.value - a.value)[0] ?? null;
  p.bestKvk = p.kvk.find((k) => k.pageKind === "legal" || k.pageKind === "contact") ?? p.kvk[0] ?? null;
  p.bestLegalForm = p.legalForms.find((k) => k.pageKind === "legal") ?? p.legalForms[0] ?? null;
  p.msMentions = dedupeBy(p.msMentions, (m) => `${m.value}|${m.sourceId}`);
  p.securityVacancies = dedupeBy(p.securityVacancies, (m) => m.value.toLowerCase());
  p.certifications = dedupeBy(p.certifications, (m) => m.value);
  return p;
}

function dedupeBy<T>(arr: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return arr.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}

/** Does `quote` (normalised whitespace/case) occur in `text`? Used to reject fabricated quotes. */
export function quoteFound(text: string, quote: string | null | undefined): boolean {
  if (!quote) return false;
  const n = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const q = n(quote);
  return q.length >= 3 && n(text).includes(q.slice(0, 160));
}

/** Social/platform domains that are never prospects when harvesting lists. */
export const NON_COMPANY_DOMAINS = new Set([
  "linkedin.com", "facebook.com", "twitter.com", "x.com", "instagram.com", "youtube.com", "google.com", "google.nl", "apple.com",
  "microsoft.com", "wikipedia.org", "kvk.nl", "overheid.nl", "rijksoverheid.nl", "vimeo.com", "tiktok.com", "pinterest.com", "whatsapp.com",
  "goo.gl", "bit.ly", "mailchimp.com", "cookiebot.com", "w3.org", "wordpress.org", "wordpress.com", "github.com", "maps.google.com", "indeed.com",
  "glassdoor.com", "nationalevacaturebank.nl", "werkzoeken.nl", "monsterboard.nl", "youtu.be", "t.co", "spotify.com", "issuu.com",
]);
