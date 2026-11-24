import Link from "next/link";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { PageHeader, Badge, Empty, pct, dt } from "@/components/ui";
import { label, tone } from "@/lib/labels";

export default async function Lists() {
  const rows = (await getDb().execute(sql`
    select l.id, l.iso_week as week, l.status::text as status, l.target, l.shortfall, l.created_at as "createdAt", l.approved_at as "approvedAt",
      count(i.id)::int as items, count(i.id) filter (where i.status='approved')::int as approved,
      (select count(distinct cr.company_id)::int from calling_results cr join prospect_list_items li on li.company_id = cr.company_id and li.list_id = l.id where cr.outcome <> 'not_yet_called') as called,
      (select count(distinct a.company_id)::int from appointments a join prospect_list_items li on li.company_id = a.company_id and li.list_id = l.id) as appointments
    from prospect_lists l left join prospect_list_items i on i.list_id = l.id group by l.id order by l.created_at desc limit 60`)) as unknown as Record<string, number | string | null>[];
  return (
    <>
      <PageHeader title="Weeklijsten" subtitle="Elke lijst moet door een mens worden goedgekeurd vóór export. Prestaties worden zichtbaar zodra belbureau-feedback is geïmporteerd." />
      {rows.length === 0 ? <Empty>Nog geen lijsten.</Empty> : (
        <table>
          <thead><tr><th>Week</th><th>Status</th><th className="text-right">Prospects</th><th className="text-right">Goedgekeurd</th><th className="text-right">Tekort</th><th className="text-right">Gebeld</th><th className="text-right">Afspraken</th><th className="text-right">Ratio</th><th>Aangemaakt</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td><Link href={`/lists/${r.id}`} className="text-accent font-medium">{String(r.week)}</Link></td>
                <td><Badge tone={tone(String(r.status))}>{label(String(r.status))}</Badge></td>
                <td className="num text-right">{r.items}/{r.target}</td>
                <td className="num text-right">{r.approved}</td>
                <td className="num text-right">{Number(r.shortfall) ? <span className="text-warn">{r.shortfall}</span> : 0}</td>
                <td className="num text-right">{r.called}</td>
                <td className="num text-right">{r.appointments}</td>
                <td className="num text-right">{Number(r.called) ? pct(Number(r.appointments) / Number(r.called)) : "—"}</td>
                <td className="text-[12px] text-muted">{dt(r.createdAt as string)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
