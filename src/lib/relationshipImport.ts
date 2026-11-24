import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { canonicalDomain, normalizeCompanyName } from "@/domain/normalize";
import { findDuplicate } from "@/domain/dedup";
import { loadIdentityIndex } from "@/pipeline/candidates";
import { parseUpload } from "./feedbackImport";

/**
 * Import existing Cloud Life customers, active opportunities, historical prospect
 * lists or rejected companies (CSV/XLSX with columns like Bedrijfsnaam, Website, KvK).
 * These records are excluded from new acquisition lists unless explicitly reactivated.
 */
export async function importRelationships(buf: Buffer, fileName: string, kind: "customer" | "active_opportunity" | "prior_prospect" | "rejected", actor: string) {
  const { headers, rows } = await parseUpload(buf, fileName);
  const h = (re: RegExp) => headers.find((x) => re.test(x.toLowerCase())) ?? null;
  const nameCol = h(/bedrijf|company|naam|organisatie/);
  const webCol = h(/website|domein|domain|url/);
  const kvkCol = h(/kvk/);
  if (!nameCol) throw new Error("Kolom met bedrijfsnaam ontbreekt");
  const db = getDb();
  const idx = await loadIdentityIndex();
  let created = 0;
  let updated = 0;
  for (const r of rows) {
    const name = r[nameCol]?.trim();
    if (!name) continue;
    const domain = webCol ? canonicalDomain(r[webCol]) : null;
    const kvk = kvkCol ? r[kvkCol]?.replace(/\D/g, "") || null : null;
    const dup = findDuplicate({ name, domain, kvkNumber: kvk }, idx.identities);
    if (dup?.matchedId && dup.reason !== "fuzzy_name") {
      await db.update(schema.companies).set({ relationship: kind, updatedAt: new Date() }).where(eq(schema.companies.id, dup.matchedId));
      if (kind === "prior_prospect") await db.insert(schema.deliveries).values({ companyId: dup.matchedId });
      updated++;
      continue;
    }
    const [c] = await db
      .insert(schema.companies)
      .values({ officialName: name, normalizedName: normalizeCompanyName(name), canonicalDomain: domain, website: domain ? `https://${domain}` : null, kvkNumber: kvk, relationship: kind, status: "excluded", discoveredBy: actor })
      .onConflictDoNothing()
      .returning({ id: schema.companies.id });
    if (!c) continue;
    if (kind === "prior_prospect") await db.insert(schema.deliveries).values({ companyId: c.id });
    idx.identities.push({ id: c.id, name, domain, kvkNumber: kvk, status: "excluded", relationship: kind, delivered: kind === "prior_prospect", reactivationApproved: false, aliases: [] });
    created++;
  }
  return { created, updated, rows: rows.length };
}
