import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";

export interface ProspectFilters {
  q?: string;
  industry?: string;
  size?: string;
  location?: string;
  minFit?: string;
  minConfidence?: string;
  tech?: string;
  techClass?: string;
  signal?: string;
  service?: string;
  calling?: string;
  status?: string;
  researchedSince?: string;
  exported?: string;
  parent?: string;
  agent?: string;
  page?: string;
}

const SIZE_SQL: Record<string, SQL> = {
  "50-299": sql`coalesce(c.employee_count, (c.employee_min + c.employee_max)/2) between 50 and 299`,
  "300-1999": sql`coalesce(c.employee_count, (c.employee_min + c.employee_max)/2) between 300 and 1999`,
  "2000-5000": sql`coalesce(c.employee_count, (c.employee_min + c.employee_max)/2) between 2000 and 5000`,
  unknown: sql`coalesce(c.employee_count, c.employee_min, c.employee_max) is null`,
};

/** Parameterised prospect search — all filters are bound parameters (no SQL injection). */
export async function searchProspects(f: ProspectFilters, pageSize = 50) {
  const where: SQL[] = [sql`c.deleted_at is null`];
  if (f.q) where.push(sql`(c.official_name ilike ${"%" + f.q + "%"} or c.trading_name ilike ${"%" + f.q + "%"} or c.canonical_domain ilike ${"%" + f.q + "%"} or ('CLSA-' || lpad(c.prospect_number::text, 6, '0')) = ${f.q.toUpperCase()})`);
  if (f.industry) where.push(sql`i.code = ${f.industry}`);
  if (f.size && SIZE_SQL[f.size]) where.push(SIZE_SQL[f.size]);
  if (f.location) where.push(sql`(c.hq_city ilike ${"%" + f.location + "%"} or c.nl_office_city ilike ${"%" + f.location + "%"} or c.province ilike ${"%" + f.location + "%"})`);
  if (f.minFit) where.push(sql`c.fit_score >= ${Number(f.minFit)}`);
  if (f.minConfidence) where.push(sql`c.confidence_score >= ${Number(f.minConfidence)}`);
  if (f.tech) where.push(sql`exists (select 1 from technology_evidence te where te.company_id = c.id and te.technology::text = ${f.tech} ${f.techClass ? sql`and te.classification::text = ${f.techClass}` : sql``})`);
  if (f.signal) where.push(sql`exists (select 1 from buying_signals bs where bs.company_id = c.id and bs.signal_type = ${f.signal})`);
  if (f.service) where.push(sql`c.recommended_service = ${f.service}`);
  if (f.calling) where.push(sql`(select cr.outcome::text from calling_results cr where cr.company_id = c.id and cr.superseded_by_id is null order by cr.created_at desc limit 1) = ${f.calling}`);
  if (f.status) where.push(sql`c.status::text = ${f.status}`);
  if (f.researchedSince) where.push(sql`c.last_researched_at >= ${f.researchedSince}::date`);
  if (f.exported === "yes") where.push(sql`exists (select 1 from deliveries d where d.company_id = c.id)`);
  if (f.exported === "no") where.push(sql`not exists (select 1 from deliveries d where d.company_id = c.id)`);
  if (f.parent) where.push(sql`g.name ilike ${"%" + f.parent + "%"}`);
  if (f.agent) where.push(sql`c.assigned_agent = ${f.agent}`);
  const page = Math.max(1, Number(f.page ?? 1));
  const whereSql = sql.join(where, sql` and `);
  const rows = (await getDb().execute(sql`
    select c.id, c.prospect_number as "prospectNumber", c.official_name as name, c.canonical_domain as domain, i.name_nl as industry,
      coalesce(c.employee_count::text, case when c.employee_min is not null then c.employee_min || '–' || c.employee_max end) as employees,
      coalesce(c.hq_city, c.nl_office_city) as city, c.fit_score as fit, c.confidence_score as confidence, c.classification, c.status::text as status,
      c.recommended_service as service, c.contact_eligibility::text as eligibility, g.name as "group", c.last_researched_at as "researchedAt",
      (select cr.outcome::text from calling_results cr where cr.company_id = c.id and cr.superseded_by_id is null order by cr.created_at desc limit 1) as calling,
      (select max(case classification when 'confirmed' then 3 when 'strongly_indicated' then 2 when 'weakly_indicated' then 1 when 'contradicted' then -1 else 0 end) from technology_evidence te where te.company_id = c.id and te.technology in ('microsoft_365','exchange_online')) as "msLevel",
      (select count(*) from buying_signals bs where bs.company_id = c.id)::int as signals
    from companies c left join industries i on i.id = c.industry_id left join company_groups g on g.id = c.group_id
    where ${whereSql}
    order by c.fit_score desc nulls last, c.updated_at desc
    limit ${pageSize} offset ${(page - 1) * pageSize}`)) as unknown as Record<string, unknown>[];
  const [count] = (await getDb().execute(sql`select count(*)::int as n from companies c left join industries i on i.id = c.industry_id left join company_groups g on g.id = c.group_id where ${whereSql}`)) as unknown as { n: number }[];
  return { rows, total: count.n, page, pageSize };
}
