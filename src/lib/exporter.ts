import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { formatProspectId, employeeEstimate } from "@/domain/normalize";
import { evaluateEligibility } from "@/domain/eligibility";
import { getSettings } from "@/lib/settings";
import { checkExclusions } from "@/pipeline/candidates";
import { audit } from "@/lib/audit";

/** Clean calling-agency columns. Detailed research and rationale stay inside the platform. */
export const EXPORT_COLUMNS = [
  { key: "prospectId", header: "Prospect-ID", width: 14 },
  { key: "company", header: "Bedrijfsnaam", width: 36 },
  { key: "website", header: "Website", width: 30 },
  { key: "industry", header: "Sector", width: 24 },
  { key: "employees", header: "Medewerkers", width: 14 },
  { key: "headquarters", header: "Hoofdkantoor", width: 20 },
  { key: "phone", header: "Telefoonnummer", width: 18 },
  { key: "decisionMakerRole", header: "IT-beslisser (rol)", width: 26 },
  { key: "contactName", header: "Contactpersoon", width: 24 },
  { key: "priority", header: "Prioriteit", width: 10 },
] as const;
export type ExportRow = Record<(typeof EXPORT_COLUMNS)[number]["key"], string>;

export class ExportBlockedError extends Error {}

/** Neutralise spreadsheet formula injection (OWASP CSV injection): values from the web may start with = + - @. */
export function safeCell(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}
/** +31101234567 → 010 1234567 (national format avoids leading "+" and is what Dutch callers expect). */
export function nationalPhone(e164: string): string {
  const d = e164.replace(/^\+31/, "0");
  return /^0[1-9]\d{8}$/.test(d) ? `${d.slice(0, d.startsWith("06") || /^0(10|20|30|40|50|70)/.test(d) ? 3 : 4)} ${d.slice(d.startsWith("06") || /^0(10|20|30|40|50|70)/.test(d) ? 3 : 4)}` : d;
}

/**
 * Build export rows for an approved list. Every row is re-checked at export
 * time: QA approval, human approval, contact eligibility and suppressions.
 * Rejected/unsafe items are never exported.
 */
export async function buildExportRows(listId: string): Promise<{ rows: ExportRow[]; companyIds: string[]; withheld: { company: string; reason: string }[] }> {
  const db = getDb();
  const [list] = await db.select().from(schema.prospectLists).where(eq(schema.prospectLists.id, listId));
  if (!list) throw new ExportBlockedError("Lijst niet gevonden");
  if (list.status !== "approved" && list.status !== "exported") throw new ExportBlockedError("Lijst is nog niet goedgekeurd door een gebruiker");
  const settings = await getSettings();
  const items = await db
    .select({ item: schema.prospectListItems, c: schema.companies, ind: schema.industries })
    .from(schema.prospectListItems)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.prospectListItems.companyId))
    .leftJoin(schema.industries, eq(schema.industries.id, schema.companies.industryId))
    .where(and(eq(schema.prospectListItems.listId, listId), eq(schema.prospectListItems.status, "approved")))
    .orderBy(schema.prospectListItems.rank);

  const companyIds = items.map((i) => i.c.id);
  const qa = companyIds.length ? await db.select().from(schema.qaReviews).where(inArray(schema.qaReviews.companyId, companyIds)) : [];
  const rows: ExportRow[] = [];
  const ok: string[] = [];
  const withheld: { company: string; reason: string }[] = [];
  for (const { item, c, ind } of items) {
    const latestQa = qa.filter((q) => q.companyId === c.id).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const qaOk = latestQa && (latestQa.verdict === "approved" || (latestQa.overriddenBy && latestQa.overrideReason));
    const ex = await checkExclusions({ companyId: c.id, name: c.officialName, domain: c.canonicalDomain, kvkNumber: c.kvkNumber, phone: c.phonePublic, relationship: c.relationship });
    const el = evaluateEligibility({ legalForm: c.legalForm, phone: c.phonePublic, suppressed: ex.suppressed, checkedAt: c.eligibilityCheckedAt }, settings.eligibility);
    const reason = !qaOk ? "Geen QA-goedkeuring" : ex.suppressed ? "Opt-out/suppressie" : ex.excluded && ex.reasons.some((r) => !r.overridable && r.category !== "delivered") ? "Uitgesloten" : el.status !== "eligible" ? `Contactgeschiktheid: ${el.status}` : !el.exportablePhone ? "Geen exporteerbaar nummer" : null;
    if (reason) {
      withheld.push({ company: c.officialName, reason });
      continue;
    }
    const est = employeeEstimate(c);
    rows.push({
      prospectId: formatProspectId(c.prospectNumber),
      company: c.officialName,
      website: c.website ?? "",
      industry: ind?.nameNl ?? "",
      employees: c.employeeCount != null ? String(c.employeeCount) : c.employeeMin != null && c.employeeMax != null ? `${c.employeeMin}–${c.employeeMax}` : est != null ? `±${est}` : "",
      headquarters: c.hqCity ?? c.nlOfficeCity ?? "",
      phone: nationalPhone(el.exportablePhone!),
      decisionMakerRole: item.contactRole ?? "",
      contactName: item.contactName ?? "",
      priority: item.priority,
    });
    const last = rows[rows.length - 1];
    for (const k of Object.keys(last) as (keyof ExportRow)[]) last[k] = safeCell(last[k]);
    ok.push(c.id);
  }
  return { rows, companyIds: ok, withheld };
}

export async function toXlsx(rows: ExportRow[], title: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Cloud Life Sales Army";
  wb.created = new Date();
  const ws = wb.addWorksheet("Belijst", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = EXPORT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  ws.autoFilter = { from: "A1", to: `${String.fromCharCode(64 + EXPORT_COLUMNS.length)}1` };
  const fb = wb.addWorksheet("Feedback-sjabloon");
  fb.columns = [
    { header: "Prospect-ID", key: "id", width: 14 },
    { header: "Bedrijfsnaam", key: "name", width: 36 },
    { header: "Status", key: "status", width: 26 },
    { header: "Datum gebeld", key: "date", width: 14 },
    { header: "Contactrol", key: "role", width: 22 },
    { header: "Notities", key: "notes", width: 50 },
  ];
  fb.getRow(1).font = { bold: true };
  for (const r of rows) fb.addRow({ id: r.prospectId, name: r.company, status: "Nog niet gebeld" });
  wb.title = title;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toCsv(rows: ExportRow[]): Buffer {
  const csv = Papa.unparse({ fields: EXPORT_COLUMNS.map((c) => c.header), data: rows.map((r) => EXPORT_COLUMNS.map((c) => r[c.key])) }, { delimiter: ";" });
  return Buffer.from("﻿" + csv, "utf8"); // BOM for Excel (nl-NL)
}

/** Generate an export file, record delivery history and audit trail. */
export async function exportList(listId: string, format: "xlsx" | "csv", actor: string) {
  const db = getDb();
  const { rows, companyIds, withheld } = await buildExportRows(listId);
  if (!rows.length) throw new ExportBlockedError("Geen exporteerbare prospects (alle items afgewezen of geblokkeerd)");
  const [list] = await db.select().from(schema.prospectLists).where(eq(schema.prospectLists.id, listId));
  const fileName = `cloud-life-belijst-${list.isoWeek}.${format}`;
  const buf = format === "xlsx" ? await toXlsx(rows, `Belijst ${list.isoWeek}`) : toCsv(rows);
  const hash = createHash("sha256").update(buf).digest("hex");
  const [exp] = await db.insert(schema.exportsTable).values({ listId, format, fileName, rowCount: rows.length, contentHash: hash, createdBy: actor }).returning();
  const already = new Set((await db.select({ c: schema.deliveries.companyId }).from(schema.deliveries).where(eq(schema.deliveries.listId, listId))).map((d) => d.c));
  for (const id of companyIds) if (!already.has(id)) await db.insert(schema.deliveries).values({ companyId: id, listId, exportId: exp.id });
  if (companyIds.length) await db.update(schema.companies).set({ status: "exported", reactivationApproved: false, updatedAt: new Date() }).where(inArray(schema.companies.id, companyIds));
  await db.update(schema.prospectLists).set({ status: "exported" }).where(eq(schema.prospectLists.id, listId));
  await audit({ actorType: "user", actorId: actor, action: "list.exported", entityType: "prospect_list", entityId: listId, details: { format, rows: rows.length, withheld, hash } });
  return { fileName, buffer: buf, rows: rows.length, withheld, contentType: format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8" };
}
