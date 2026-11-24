import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { z } from "zod";
import { and, eq, isNull, desc } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { normalizeCompanyName, stripDiacritics } from "@/domain/normalize";
import { normalizeExclusionValue } from "@/domain/exclusion";
import { audit } from "@/lib/audit";

export const OUTCOMES = [
  "not_yet_called", "no_answer", "gatekeeper", "wrong_contact", "not_interested", "existing_supplier", "no_microsoft_environment",
  "no_purchasing_authority", "contact_again_later", "qualified_opportunity", "appointment_scheduled", "converted_to_customer", "do_not_contact",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const OUTCOME_LABELS: Record<Outcome, string> = {
  not_yet_called: "Nog niet gebeld", no_answer: "Geen gehoor", gatekeeper: "Gatekeeper", wrong_contact: "Verkeerde contactpersoon",
  not_interested: "Geen interesse", existing_supplier: "Bestaande leverancier", no_microsoft_environment: "Geen Microsoft-omgeving",
  no_purchasing_authority: "Geen inkoopbevoegdheid", contact_again_later: "Later opnieuw contact", qualified_opportunity: "Gekwalificeerde kans",
  appointment_scheduled: "Afspraak gepland", converted_to_customer: "Klant geworden", do_not_contact: "Niet benaderen",
};

const SYNONYMS: [RegExp, Outcome][] = [
  [/niet (meer )?(bellen|benaderen)|do not (call|contact)|opt.?out|bel.?me.?niet/, "do_not_contact"],
  [/klant geworden|converted|gewonnen|won\b|customer/, "converted_to_customer"],
  [/afspraak|appointment|meeting gepland|demo gepland/, "appointment_scheduled"],
  [/gekwalificeerd|qualified|kans|opportunity|lead/, "qualified_opportunity"],
  [/terugbellen|later|call ?back|opnieuw contact/, "contact_again_later"],
  [/geen inkoop|no purchasing|niet bevoegd|beslist (in het )?buitenland|hoofdkantoor beslist/, "no_purchasing_authority"],
  [/geen microsoft|no microsoft|google workspace/, "no_microsoft_environment"],
  [/bestaande leverancier|existing supplier|al (een )?partij|heeft (al )?een leverancier/, "existing_supplier"],
  [/geen interesse|not interested|niet geinteresseerd/, "not_interested"],
  [/verkeerde (contact|persoon)|wrong contact/, "wrong_contact"],
  [/gatekeeper|receptie|secretariaat|doorverbonden niet/, "gatekeeper"],
  [/geen gehoor|no answer|voicemail|niet opgenomen/, "no_answer"],
  [/nog niet gebeld|not yet called|open/, "not_yet_called"],
];

export function normalizeOutcome(raw: string | null | undefined): Outcome | null {
  if (!raw) return null;
  const s = stripDiacritics(raw.toLowerCase()).trim().replace(/[_-]/g, " ");
  if ((OUTCOMES as readonly string[]).includes(s.replace(/ /g, "_"))) return s.replace(/ /g, "_") as Outcome;
  for (const [label, key] of Object.entries(OUTCOME_LABELS)) if (stripDiacritics(key.toLowerCase()) === s) return label as Outcome;
  for (const [re, o] of SYNONYMS) if (re.test(s)) return o;
  return null;
}

export const MappingSchema = z.object({
  prospectId: z.string().nullable(),
  companyName: z.string().nullable(),
  outcome: z.string(),
  date: z.string().nullable(),
  notes: z.string().nullable(),
  contactRole: z.string().nullable(),
});
export type Mapping = z.infer<typeof MappingSchema>;

export function suggestMapping(headers: string[]): Mapping {
  const find = (...pats: RegExp[]) => headers.find((h) => pats.some((p) => p.test(stripDiacritics(h.toLowerCase())))) ?? null;
  return {
    prospectId: find(/prospect.?id/, /^id$/, /referentie/),
    companyName: find(/bedrijf/, /company/, /organisatie/),
    outcome: find(/status/, /resultaat/, /outcome/, /uitkomst/) ?? headers[0] ?? "status",
    date: find(/datum/, /date/, /gebeld op/),
    notes: find(/notitie/, /opmerking/, /notes?/, /toelichting/, /feedback/),
    contactRole: find(/rol/, /functie/, /contact/),
  };
}

export async function parseUpload(buf: Buffer, fileName: string): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  if (buf.length > 10 * 1024 * 1024) throw new Error("Bestand te groot (max 10 MB)");
  if (/\.xlsx$/i.test(fileName)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets.find((w) => /feedback/i.test(w.name)) ?? wb.worksheets[0];
    if (!ws) return { headers: [], rows: [] };
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => (headers[col - 1] = String(cell.text ?? "").trim()));
    const rows: Record<string, string>[] = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const r: Record<string, string> = {};
      headers.forEach((h, i) => (r[h] = String(row.getCell(i + 1).text ?? "").trim()));
      if (Object.values(r).some(Boolean)) rows.push(r);
    });
    return { headers: headers.filter(Boolean), rows: rows.slice(0, 5000) };
  }
  if (/\.csv$/i.test(fileName)) {
    const text = buf.toString("utf8").replace(/^﻿/, "");
    const p = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
    return { headers: p.meta.fields ?? [], rows: p.data.slice(0, 5000) };
  }
  throw new Error("Alleen .xlsx of .csv toegestaan");
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  const d = m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 12)) : new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export interface PreviewRow {
  line: number;
  companyId: string | null;
  companyName: string | null;
  prospectId: string | null;
  outcome: Outcome | null;
  rawOutcome: string;
  calledAt: string | null;
  notes: string | null;
  contactRole: string | null;
  rowHash: string;
  errors: string[];
  duplicate: boolean;
}

/** Validate and match rows; nothing is written to calling history yet. */
export async function previewImport(rows: Record<string, string>[], mapping: Mapping): Promise<PreviewRow[]> {
  const db = getDb();
  const companies = await db.select({ id: schema.companies.id, n: schema.companies.prospectNumber, name: schema.companies.officialName, norm: schema.companies.normalizedName }).from(schema.companies).where(isNull(schema.companies.deletedAt));
  const byNum = new Map(companies.map((c) => [c.n, c]));
  const seen = new Set<string>();
  const out: PreviewRow[] = [];
  for (const [i, r] of rows.entries()) {
    const errors: string[] = [];
    const pid = mapping.prospectId ? r[mapping.prospectId]?.trim() || null : null;
    const name = mapping.companyName ? r[mapping.companyName]?.trim() || null : null;
    let company = pid ? byNum.get(Number(pid.replace(/\D/g, ""))) : undefined;
    if (!company && name) {
      const matches = companies.filter((c) => c.norm === normalizeCompanyName(name));
      if (matches.length === 1) company = matches[0];
      else if (matches.length > 1) errors.push("Bedrijfsnaam niet eenduidig — gebruik Prospect-ID");
    }
    if (!company) errors.push("Bedrijf niet gevonden");
    const rawOutcome = r[mapping.outcome] ?? "";
    const outcome = normalizeOutcome(rawOutcome);
    if (!outcome) errors.push(`Onbekende status: "${rawOutcome}"`);
    const calledAt = mapping.date ? parseDate(r[mapping.date]) : null;
    const notes = mapping.notes ? (r[mapping.notes] ?? "").slice(0, 2000) || null : null;
    const contactRole = mapping.contactRole ? (r[mapping.contactRole] ?? "").slice(0, 120) || null : null;
    const rowHash = createHash("sha256").update(JSON.stringify([company?.id, outcome, calledAt?.toISOString().slice(0, 10), notes])).digest("hex");
    let duplicate = seen.has(rowHash);
    seen.add(rowHash);
    if (!duplicate && company) {
      const [exists] = await db.select({ id: schema.callingResults.id }).from(schema.callingResults).where(eq(schema.callingResults.rowHash, rowHash));
      duplicate = Boolean(exists);
    }
    out.push({ line: i + 2, companyId: company?.id ?? null, companyName: company?.name ?? name, prospectId: pid, outcome, rawOutcome, calledAt: calledAt?.toISOString() ?? null, notes, contactRole, rowHash, errors, duplicate });
  }
  return out;
}

export async function createImportPreview(fileName: string, buf: Buffer, uploadedBy: string, mapping?: Mapping) {
  const { headers, rows } = await parseUpload(buf, fileName);
  const map = mapping ?? suggestMapping(headers);
  const preview = await previewImport(rows, map);
  const [imp] = await getDb().insert(schema.feedbackImports).values({
    fileName: fileName.slice(0, 200), uploadedBy, mapping: map, rowCount: rows.length,
    validRows: preview.filter((p) => !p.errors.length && !p.duplicate).length, duplicateRows: preview.filter((p) => p.duplicate).length,
    errors: preview.filter((p) => p.errors.length).slice(0, 50).map((p) => `Regel ${p.line}: ${p.errors.join(", ")}`),
    preview: { headers, rows: preview, raw: rows.slice(0, 5000) },
  }).returning();
  return { importId: imp.id, headers, mapping: map, preview };
}

export async function remapImport(importId: string, mapping: Mapping) {
  const db = getDb();
  const [imp] = await db.select().from(schema.feedbackImports).where(eq(schema.feedbackImports.id, importId));
  if (!imp || imp.status !== "preview") throw new Error("Import niet in previewstatus");
  const raw = (imp.preview as { raw: Record<string, string>[]; headers: string[] }).raw;
  const preview = await previewImport(raw, mapping);
  await db.update(schema.feedbackImports).set({
    mapping, preview: { headers: (imp.preview as { headers: string[] }).headers, rows: preview, raw },
    validRows: preview.filter((p) => !p.errors.length && !p.duplicate).length, duplicateRows: preview.filter((p) => p.duplicate).length,
    errors: preview.filter((p) => p.errors.length).slice(0, 50).map((p) => `Regel ${p.line}: ${p.errors.join(", ")}`),
  }).where(eq(schema.feedbackImports.id, importId));
  return preview;
}

const ESTIMATED_MRR_EUR = 3500; // midpoint of typical €2.000–€5.000 contracts; an estimate, not contracted revenue.

/**
 * Commit valid, non-duplicate rows. History is append-only: the previous
 * latest result for a company is marked superseded, never overwritten.
 */
export async function commitImport(importId: string, actor: string) {
  const db = getDb();
  const [imp] = await db.select().from(schema.feedbackImports).where(eq(schema.feedbackImports.id, importId));
  if (!imp || imp.status !== "preview") throw new Error("Import niet in previewstatus");
  const rows = (imp.preview as { rows: PreviewRow[] }).rows.filter((r) => !r.errors.length && !r.duplicate && r.companyId && r.outcome);
  let committed = 0;
  for (const r of rows) {
    const companyId = r.companyId!;
    const [prev] = await db.select().from(schema.callingResults).where(and(eq(schema.callingResults.companyId, companyId), isNull(schema.callingResults.supersededById))).orderBy(desc(schema.callingResults.createdAt)).limit(1);
    const [cr] = await db
      .insert(schema.callingResults)
      .values({ companyId, importId, outcome: r.outcome!, notes: r.notes, calledAt: r.calledAt ? new Date(r.calledAt) : null, contactRole: r.contactRole, raw: { line: r.line, rawOutcome: r.rawOutcome }, rowHash: r.rowHash })
      .onConflictDoNothing()
      .returning();
    if (!cr) continue;
    committed++;
    if (prev) await db.update(schema.callingResults).set({ supersededById: cr.id }).where(eq(schema.callingResults.id, prev.id));
    const [c] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
    if (r.outcome === "appointment_scheduled") {
      await db.insert(schema.appointments).values({ companyId, callingResultId: cr.id, scheduledFor: r.calledAt ? new Date(r.calledAt) : null, notes: r.notes });
      await db.insert(schema.opportunities).values({ companyId, service: c.recommendedService ?? "ms_security_assessment", estimatedMrrEur: String(ESTIMATED_MRR_EUR), source: "calling_agency" });
    } else if (r.outcome === "qualified_opportunity") {
      await db.insert(schema.opportunities).values({ companyId, service: c.recommendedService ?? "ms_security_assessment", estimatedMrrEur: String(ESTIMATED_MRR_EUR), source: "calling_agency" });
    } else if (r.outcome === "converted_to_customer") {
      await db.insert(schema.conversions).values({ companyId, service: c.recommendedService ?? "protect_365", signedAt: (r.calledAt ?? new Date().toISOString()).slice(0, 10) });
      await db.update(schema.companies).set({ relationship: "customer" }).where(eq(schema.companies.id, companyId));
      await db.update(schema.opportunities).set({ stage: "won", closedAt: new Date() }).where(and(eq(schema.opportunities.companyId, companyId), eq(schema.opportunities.stage, "open")));
    } else if (r.outcome === "do_not_contact") {
      // Permanent suppression with minimum data: normalised identifiers only.
      if (c.canonicalDomain) await db.insert(schema.suppressions).values({ identifierType: "domain", identifierValue: c.canonicalDomain, reason: "do_not_contact", source: `feedback:${importId}` }).onConflictDoNothing();
      if (c.kvkNumber) await db.insert(schema.suppressions).values({ identifierType: "kvk", identifierValue: c.kvkNumber, reason: "do_not_contact", source: `feedback:${importId}` }).onConflictDoNothing();
      await db.insert(schema.suppressions).values({ identifierType: "name", identifierValue: normalizeExclusionValue("name", c.officialName), reason: "do_not_contact", source: `feedback:${importId}` }).onConflictDoNothing();
      await db.update(schema.companies).set({ relationship: "opted_out", contactEligibility: "suppressed" }).where(eq(schema.companies.id, companyId));
    } else if (r.outcome === "not_interested" || r.outcome === "no_microsoft_environment" || r.outcome === "no_purchasing_authority") {
      if (c.relationship === "none") await db.update(schema.companies).set({ relationship: "rejected" }).where(eq(schema.companies.id, companyId));
    }
  }
  await db.update(schema.feedbackImports).set({ status: "committed", committedAt: new Date() }).where(eq(schema.feedbackImports.id, importId));
  await audit({ actorType: "user", actorId: actor, action: "feedback.imported", entityType: "feedback_import", entityId: importId, details: { committed } });
  return { committed };
}
