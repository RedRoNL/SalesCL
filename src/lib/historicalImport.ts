import { createHash } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { canonicalDomain, normalizeCompanyName, normalizePhoneNL, stripDiacritics } from "@/domain/normalize";
import { normalizeExclusionValue } from "@/domain/exclusion";
import { findExistingCompany, addIdentifiers } from "@/pipeline/identity";
import { invalidateExclusionCache } from "@/pipeline/candidates";
import { audit } from "@/lib/audit";
import { parseUpload, normalizeOutcome } from "./feedbackImport";

/**
 * Historical commercial data import: previous calling lists, existing customers, active
 * opportunities, previously rejected companies and opt-out lists. Built for messy data:
 * inconsistent names, outdated websites, missing fields. Every variant is remembered as an
 * identifier so future discovery recognises the company.
 */
export const HISTORICAL_KINDS = ["historical_list", "customers", "opportunities", "rejected", "optouts"] as const;
export type HistoricalKind = (typeof HISTORICAL_KINDS)[number];
export const KIND_LABELS: Record<HistoricalKind, string> = {
  historical_list: "Eerdere bellijsten (geleverd)", customers: "Bestaande klanten", opportunities: "Actieve sales-opportunities", rejected: "Eerder afgewezen", optouts: "Opt-outs / niet benaderen",
};

export const HistoricalMappingSchema = z.object({
  name: z.string(),
  website: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  kvk: z.string().nullable(),
  city: z.string().nullable(),
  date: z.string().nullable(),
  outcome: z.string().nullable(),
  notes: z.string().nullable(),
});
export type HistoricalMapping = z.infer<typeof HistoricalMappingSchema>;

export function suggestHistoricalMapping(headers: string[]): HistoricalMapping {
  const find = (...pats: RegExp[]) => headers.find((h) => pats.some((p) => p.test(stripDiacritics(h.toLowerCase())))) ?? null;
  return {
    name: find(/bedrijfs?naam/, /^bedrijf$/, /company/, /organisatie/, /klant/, /naam/) ?? headers[0] ?? "naam",
    website: find(/website/, /url/, /domein/, /domain/, /^www/),
    email: find(/e-?mail/),
    phone: find(/telefoon/, /phone/, /^tel/, /nummer/),
    kvk: find(/kvk/, /coc/, /chamber/),
    city: find(/plaats/, /stad/, /city/, /vestiging/, /woonplaats/),
    date: find(/datum/, /date/, /geleverd/, /week/),
    outcome: find(/status/, /resultaat/, /uitkomst/, /outcome/),
    notes: find(/notitie/, /opmerking/, /notes?/),
  };
}

export interface HistoricalPreviewRow {
  line: number;
  name: string;
  domain: string | null;
  phone: string | null;
  kvk: string | null;
  city: string | null;
  date: string | null;
  outcome: string | null;
  notes: string | null;
  matchId: string | null;
  matchName: string | null;
  matchMethod: string | null;
  confidence: "certain" | "probable" | "new";
  errors: string[];
}

function parseDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export async function previewHistorical(rows: Record<string, string>[], map: HistoricalMapping): Promise<HistoricalPreviewRow[]> {
  const out: HistoricalPreviewRow[] = [];
  const seen = new Map<string, number>();
  for (const [i, r] of rows.entries()) {
    const get = (k: keyof HistoricalMapping) => (map[k] ? (r[map[k]!] ?? "").trim() : "");
    const name = get("name");
    const errors: string[] = [];
    if (!name) errors.push("Geen bedrijfsnaam");
    const email = get("email");
    const domain = canonicalDomain(get("website")) ?? (email.includes("@") ? canonicalDomain(email.split("@").pop()) : null);
    const phone = normalizePhoneNL(get("phone"));
    const kvk = get("kvk").replace(/\D/g, "") || null;
    const city = get("city") || null;
    // Generic mailbox providers are not company domains.
    const cleanDomain = domain && /^(gmail|hotmail|outlook|live|ziggo|kpnmail|kpnplanet|xs4all|planet|yahoo|icloud|home)\./.test(domain) ? null : domain;
    let match = null;
    if (name) match = await findExistingCompany({ name, domain: cleanDomain, kvkNumber: kvk, phone, city });
    const key = cleanDomain ?? kvk ?? normalizeCompanyName(name);
    const dupLine = seen.get(key);
    if (dupLine) errors.push(`Zelfde bedrijf als regel ${dupLine} (wordt samengevoegd)`);
    seen.set(key, i + 2);
    out.push({
      line: i + 2, name, domain: cleanDomain, phone, kvk: kvk && kvk.length === 8 ? kvk : null, city, date: parseDate(get("date")), outcome: get("outcome") || null, notes: get("notes") || null,
      matchId: match?.matchedId ?? null, matchName: match?.matchedName ?? null, matchMethod: match?.reason ?? null,
      confidence: !match ? "new" : match.reason === "fuzzy_name" ? "probable" : "certain",
      errors,
    });
  }
  return out;
}

export async function createHistoricalPreview(kind: HistoricalKind, fileName: string, buf: Buffer, uploadedBy: string, mapping?: HistoricalMapping) {
  const { headers, rows } = await parseUpload(buf, fileName);
  const map = mapping ?? suggestHistoricalMapping(headers);
  const preview = await previewHistorical(rows, map);
  const [imp] = await getDb().insert(schema.feedbackImports).values({
    kind, fileName: fileName.slice(0, 200), uploadedBy, mapping: map, rowCount: rows.length,
    validRows: preview.filter((p) => !p.errors.some((e) => e === "Geen bedrijfsnaam")).length, duplicateRows: preview.filter((p) => p.matchId).length,
    errors: preview.filter((p) => p.errors.length).slice(0, 50).map((p) => `Regel ${p.line}: ${p.errors.join(", ")}`),
    preview: { headers, rows: preview, raw: rows },
  }).returning();
  return { importId: imp.id, headers, mapping: map, preview };
}

export async function remapHistorical(importId: string, mapping: HistoricalMapping) {
  const db = getDb();
  const [imp] = await db.select().from(schema.feedbackImports).where(eq(schema.feedbackImports.id, importId));
  if (!imp || imp.status !== "preview" || imp.kind === "feedback") throw new Error("Import niet in previewstatus");
  const raw = (imp.preview as { raw: Record<string, string>[]; headers: string[] }).raw;
  const preview = await previewHistorical(raw, mapping);
  await db.update(schema.feedbackImports).set({ mapping, preview: { headers: (imp.preview as { headers: string[] }).headers, rows: preview, raw }, duplicateRows: preview.filter((p) => p.matchId).length }).where(eq(schema.feedbackImports.id, importId));
  return preview;
}

const RELATION: Record<HistoricalKind, "prior_prospect" | "customer" | "active_opportunity" | "rejected" | "opted_out"> = {
  historical_list: "prior_prospect", customers: "customer", opportunities: "active_opportunity", rejected: "rejected", optouts: "opted_out",
};
// More restrictive relationships are never downgraded by an import.
const STRENGTH: Record<string, number> = { none: 0, prior_prospect: 1, rejected: 2, active_opportunity: 3, customer: 4, opted_out: 5 };

/** Commit: link or create companies, remember all identifiers, record deliveries/relationships/suppressions. */
export async function commitHistorical(importId: string, actor: string, opts: { acceptProbable?: boolean } = {}) {
  const db = getDb();
  const [imp] = await db.select().from(schema.feedbackImports).where(eq(schema.feedbackImports.id, importId));
  if (!imp || imp.status !== "preview" || imp.kind === "feedback") throw new Error("Import niet in previewstatus");
  const kind = imp.kind as HistoricalKind;
  const rel = RELATION[kind];
  const rows = (imp.preview as { rows: HistoricalPreviewRow[] }).rows.filter((r) => r.name);
  let linked = 0;
  let created = 0;
  const byKey = new Map<string, string>(); // merge duplicates within the file
  for (const r of rows) {
    const key = r.domain ?? r.kvk ?? normalizeCompanyName(r.name);
    let companyId = r.matchId && (r.confidence === "certain" || opts.acceptProbable !== false) ? r.matchId : byKey.get(key) ?? null;
    if (companyId) {
      const [c] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
      if ((STRENGTH[rel] ?? 0) > (STRENGTH[c.relationship] ?? 0)) await db.update(schema.companies).set({ relationship: rel, contactEligibility: rel === "opted_out" ? "suppressed" : c.contactEligibility, updatedAt: new Date() }).where(eq(schema.companies.id, companyId));
      linked++;
    } else {
      const [c] = await db.insert(schema.companies).values({
        officialName: r.name.slice(0, 200), normalizedName: normalizeCompanyName(r.name), canonicalDomain: r.domain, website: r.domain ? `https://${r.domain}` : null,
        kvkNumber: r.kvk, phonePublic: r.phone, nlOfficeCity: r.city, relationship: rel, status: kind === "historical_list" ? "exported" : "excluded",
        contactEligibility: rel === "opted_out" ? "suppressed" : "unknown", discoveredBy: `import:${kind}`,
      }).onConflictDoNothing().returning({ id: schema.companies.id });
      if (!c) {
        const m = await findExistingCompany({ name: r.name, domain: r.domain, kvkNumber: r.kvk, phone: r.phone });
        if (!m?.matchedId) continue;
        companyId = m.matchedId;
        linked++;
      } else {
        companyId = c.id;
        created++;
      }
    }
    byKey.set(key, companyId);
    await addIdentifiers(companyId, { names: [r.name], domains: [r.domain], phones: [r.phone], kvk: r.kvk }, `historical_import:${kind}`);
    if (kind === "historical_list") {
      await db.insert(schema.deliveries).values({ companyId, deliveredAt: r.date ? new Date(`${r.date}T12:00:00Z`) : new Date(imp.createdAt) });
      const outcome = normalizeOutcome(r.outcome);
      if (outcome) {
        const rowHash = createHash("sha256").update(JSON.stringify(["hist", companyId, outcome, r.date, r.notes])).digest("hex");
        await db.insert(schema.callingResults).values({ companyId, importId, outcome, notes: r.notes, calledAt: r.date ? new Date(`${r.date}T12:00:00Z`) : null, raw: { line: r.line, historical: true }, rowHash }).onConflictDoNothing();
        if (outcome === "do_not_contact") await suppress(companyId, r, importId);
      }
    }
    if (kind === "optouts") await suppress(companyId, r, importId);
  }
  invalidateExclusionCache();
  await db.update(schema.feedbackImports).set({ status: "committed", committedAt: new Date() }).where(eq(schema.feedbackImports.id, importId));
  await audit({ actorType: "user", actorId: actor, action: "historical.imported", entityType: "feedback_import", entityId: importId, details: { kind, linked, created } });
  return { linked, created };
}

async function suppress(companyId: string, r: HistoricalPreviewRow, importId: string) {
  const db = getDb();
  const vals = [
    r.domain && { identifierType: "domain", identifierValue: r.domain },
    r.kvk && { identifierType: "kvk", identifierValue: r.kvk },
    r.phone && { identifierType: "phone", identifierValue: r.phone },
    { identifierType: "name", identifierValue: normalizeExclusionValue("name", r.name) },
  ].filter(Boolean) as { identifierType: string; identifierValue: string }[];
  for (const v of vals) await db.insert(schema.suppressions).values({ ...v, reason: "opt_out", source: `import:${importId}` }).onConflictDoNothing();
  await db.update(schema.companies).set({ relationship: "opted_out", contactEligibility: "suppressed" }).where(eq(schema.companies.id, companyId));
}
