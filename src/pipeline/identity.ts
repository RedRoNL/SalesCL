import { sql, and, eq, isNull, inArray, or } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { canonicalDomain, normalizeCompanyName, normalizePhoneNL } from "@/domain/normalize";
import { findDuplicate, type CompanyIdentity, type DuplicateMatch } from "@/domain/dedup";

export interface ExistingMatch extends DuplicateMatch {
  status: string;
  relationship: string;
  delivered: boolean;
  reactivationApproved: boolean;
}

export interface IdentityQuery {
  name: string;
  domain?: string | null;
  kvkNumber?: string | null;
  phone?: string | null;
  groupName?: string | null;
  groupDomain?: string | null;
  excludeCompanyId?: string;
  city?: string | null;
}

/**
 * Database-side duplicate search. Scales with indexes instead of loading every
 * company: exact keys (KvK, domain incl. historical domains, phone, identifiers)
 * plus pg_trgm name similarity narrow the field; the deterministic matcher then
 * decides on a small candidate set.
 */
export async function findExistingCompany(q: IdentityQuery): Promise<ExistingMatch | null> {
  const db = getDb();
  const domain = canonicalDomain(q.domain ?? null);
  const kvk = q.kvkNumber?.replace(/\D/g, "") || null;
  const phone = normalizePhoneNL(q.phone ?? null);
  const norm = normalizeCompanyName(q.name);
  const ids = new Set<string>();

  const idents: { type: string; value: string }[] = [];
  if (domain) idents.push({ type: "domain", value: domain });
  if (kvk) idents.push({ type: "kvk", value: kvk });
  if (phone) idents.push({ type: "phone", value: phone });
  if (norm) idents.push({ type: "name", value: norm });
  if (idents.length) {
    const rows = await db
      .select({ c: schema.companyIdentifiers.companyId })
      .from(schema.companyIdentifiers)
      .where(or(...idents.map((i) => and(eq(schema.companyIdentifiers.type, i.type), eq(schema.companyIdentifiers.value, i.value)))));
    rows.forEach((r) => ids.add(r.c));
  }
  const keyConds = [];
  if (domain) keyConds.push(eq(schema.companies.canonicalDomain, domain));
  if (kvk) keyConds.push(eq(schema.companies.kvkNumber, kvk));
  if (phone) keyConds.push(eq(schema.companies.phonePublic, phone));
  if (keyConds.length) (await db.select({ id: schema.companies.id }).from(schema.companies).where(or(...keyConds))).forEach((r) => ids.add(r.id));
  if (domain) (await db.select({ c: schema.domains.companyId }).from(schema.domains).where(eq(schema.domains.domain, domain))).forEach((r) => r.c && ids.add(r.c));
  if (norm.length >= 3) {
    const sim = (await db.execute(sql`
      select id from companies where deleted_at is null and (normalized_name = ${norm} or similarity(normalized_name, ${norm}) > 0.45)
      order by similarity(normalized_name, ${norm}) desc limit 15`)) as unknown as { id: string }[];
    sim.forEach((r) => ids.add(r.id));
    const al = (await db.execute(sql`select company_id as id from company_aliases where normalized_alias = ${norm} or similarity(normalized_alias, ${norm}) > 0.6 limit 10`)) as unknown as { id: string }[];
    al.forEach((r) => ids.add(r.id));
  }
  // Parent group: companies in a group with that domain/name.
  const gName = q.groupName ? normalizeCompanyName(q.groupName) : null;
  const gDomain = canonicalDomain(q.groupDomain ?? null);
  if (gName || gDomain || domain) {
    const groups = await db.select({ id: schema.companyGroups.id }).from(schema.companyGroups).where(or(...[gName ? eq(schema.companyGroups.normalizedName, gName) : undefined, gDomain ? eq(schema.companyGroups.primaryDomain, gDomain) : undefined, domain ? eq(schema.companyGroups.primaryDomain, domain) : undefined].filter(Boolean) as ReturnType<typeof eq>[]));
    if (groups.length) (await db.select({ id: schema.companies.id }).from(schema.companies).where(inArray(schema.companies.groupId, groups.map((g) => g.id)))).forEach((r) => ids.add(r.id));
  }
  if (q.excludeCompanyId) ids.delete(q.excludeCompanyId);
  if (!ids.size) return null;

  const list = [...ids].slice(0, 60);
  const companies = await db.select().from(schema.companies).where(and(inArray(schema.companies.id, list), isNull(schema.companies.deletedAt)));
  if (!companies.length) return null;
  const allIdents = await db.select().from(schema.companyIdentifiers).where(inArray(schema.companyIdentifiers.companyId, companies.map((c) => c.id)));
  const aliases = await db.select().from(schema.companyAliases).where(inArray(schema.companyAliases.companyId, companies.map((c) => c.id)));
  const groupIds = [...new Set(companies.map((c) => c.groupId).filter(Boolean) as string[])];
  const groups = groupIds.length ? await db.select().from(schema.companyGroups).where(inArray(schema.companyGroups.id, groupIds)) : [];
  const delivered = new Set((await db.select({ c: schema.deliveries.companyId }).from(schema.deliveries).where(inArray(schema.deliveries.companyId, companies.map((c) => c.id)))).map((d) => d.c));

  const identities: CompanyIdentity[] = companies.map((c) => {
    const g = groups.find((x) => x.id === c.groupId);
    const mine = allIdents.filter((i) => i.companyId === c.id);
    return {
      id: c.id, name: c.officialName, domain: c.canonicalDomain, kvkNumber: c.kvkNumber, groupId: c.groupId, groupName: g?.name ?? null, groupDomain: g?.primaryDomain ?? null,
      aliases: [...aliases.filter((a) => a.companyId === c.id).map((a) => a.alias), ...(c.tradingName ? [c.tradingName] : []), ...mine.filter((i) => i.type === "name").map((i) => i.value)],
      domains: mine.filter((i) => i.type === "domain").map((i) => i.value),
      phones: [...mine.filter((i) => i.type === "phone").map((i) => i.value), ...(c.phonePublic ? [c.phonePublic] : [])],
    };
  });
  const match = findDuplicate({ name: q.name, domain, kvkNumber: kvk, phones: phone ? [phone] : [], groupName: q.groupName, groupDomain: q.groupDomain }, identities);
  if (!match) return null;
  const c = companies.find((x) => x.id === match.matchedId)!;
  return { ...match, status: c.status, relationship: c.relationship, delivered: delivered.has(c.id), reactivationApproved: c.reactivationApproved };
}

/** Remember identifiers (incl. historical names/domains/phones) so future matches succeed. */
export async function addIdentifiers(companyId: string, ids: { domains?: (string | null | undefined)[]; phones?: (string | null | undefined)[]; kvk?: string | null; names?: (string | null | undefined)[] }, source: string) {
  const rows: { companyId: string; type: string; value: string; source: string }[] = [];
  for (const d of ids.domains ?? []) {
    const v = canonicalDomain(d ?? null);
    if (v) rows.push({ companyId, type: "domain", value: v, source });
  }
  for (const p of ids.phones ?? []) {
    const v = normalizePhoneNL(p ?? null);
    if (v) rows.push({ companyId, type: "phone", value: v, source });
  }
  if (ids.kvk && /^\d{8}$/.test(ids.kvk.replace(/\D/g, ""))) rows.push({ companyId, type: "kvk", value: ids.kvk.replace(/\D/g, ""), source });
  for (const n of ids.names ?? []) {
    const v = n ? normalizeCompanyName(n) : "";
    if (v.length >= 3) rows.push({ companyId, type: "name", value: v, source });
  }
  if (rows.length) await getDb().insert(schema.companyIdentifiers).values(rows).onConflictDoNothing();
}
