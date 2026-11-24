import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq, desc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db/client";
import { requirePageUser } from "@/lib/auth/current";
import { decideItemAction, approveListAction } from "@/app/actions";
import { PageHeader, Section, Badge, Button, Empty, dt } from "@/components/ui";
import { label, tone } from "@/lib/labels";
import { SERVICE_LABELS } from "@/domain/services";
import { formatProspectId, employeeEstimate } from "@/domain/normalize";
import { Markdown } from "@/components/Markdown";

export default async function ListDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const user = await requirePageUser("viewer");
  const db = getDb();
  const [list] = await db.select().from(schema.prospectLists).where(eq(schema.prospectLists.id, id));
  if (!list) notFound();
  const items = await db.select({ i: schema.prospectListItems, c: schema.companies, ind: schema.industries }).from(schema.prospectListItems)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.prospectListItems.companyId)).leftJoin(schema.industries, eq(schema.industries.id, schema.companies.industryId))
    .where(eq(schema.prospectListItems.listId, id)).orderBy(asc(schema.prospectListItems.rank));
  const exports = await db.select().from(schema.exportsTable).where(eq(schema.exportsTable.listId, id)).orderBy(desc(schema.exportsTable.createdAt));
  const qa = list.qaReport as { summary?: { reviewed: number; approved: number; rejected: number; needsResearch: number; topIssues: [string, number][] }; candidateCounts?: Record<string, number> } | null;
  const editable = user.role !== "viewer" && list.status !== "exported";
  return (
    <>
      <PageHeader
        title={`Weeklijst ${list.isoWeek}`}
        subtitle={`${items.length} van ${list.target} prospects${list.shortfall ? ` · tekort ${list.shortfall}` : ""}${list.approvedAt ? ` · goedgekeurd ${dt(list.approvedAt)}` : ""}`}
        actions={
          <>
            <Badge tone={tone(list.status)}>{label(list.status)}</Badge>
            {editable && list.status !== "approved" && <form action={approveListAction.bind(null, id, false)}><Button variant="primary">Lijst goedkeuren</Button></form>}
            {editable && list.status !== "approved" && <form action={approveListAction.bind(null, id, true)}><Button>Alles openstaand goedkeuren</Button></form>}
            {(list.status === "approved" || list.status === "exported") && user.role !== "viewer" && (
              <>
                <a className="rounded-md border border-line-strong px-3 py-1.5 text-[13px]" href={`/api/lists/${id}/export?format=xlsx`}>Export Excel</a>
                <a className="rounded-md border border-line-strong px-3 py-1.5 text-[13px]" href={`/api/lists/${id}/export?format=csv`}>Export CSV</a>
              </>
            )}
            <Link className="rounded-md border border-line-strong px-3 py-1.5 text-[13px]" href="/feedback">Feedback importeren</Link>
          </>
        }
      />
      {list.shortfallExplanation && <div className="mb-5 text-[13px] text-warn border border-warn/30 bg-warn/10 rounded-md px-3 py-2">{list.shortfallExplanation}</div>}
      <div className="grid xl:grid-cols-[1fr_360px] gap-8">
        <Section title="Prospects">
          {items.length === 0 ? <Empty>Geen gekwalificeerde prospects in deze lijst.</Empty> : (
            <table>
              <thead><tr><th>#</th><th>Prio</th><th>Organisatie</th><th>Sector</th><th className="text-right">Mdw.</th><th className="text-right">Fit</th><th className="text-right">Betr.</th><th>Dienst</th><th>Contactrol</th><th>Beslissing</th></tr></thead>
              <tbody>
                {items.map(({ i, c, ind }) => (
                  <tr key={i.id}>
                    <td className="num text-faint">{i.rank}</td>
                    <td><Badge tone={i.priority === "A" ? "ok" : i.priority === "B" ? "accent" : "muted"}>{i.priority}</Badge></td>
                    <td><Link href={`/prospects/${c.id}`} className="hover:text-accent font-medium">{c.officialName}</Link><div className="text-[11px] text-faint">{formatProspectId(c.prospectNumber)} · {c.phonePublic ?? "geen nummer"}</div></td>
                    <td className="text-muted">{ind?.nameNl ?? "—"}</td>
                    <td className="num text-right">{employeeEstimate(c) ?? "—"}</td>
                    <td className="num text-right font-medium">{c.fitScore}</td>
                    <td className="num text-right text-muted">{c.confidenceScore}</td>
                    <td className="text-[12px]">{c.recommendedService ? SERVICE_LABELS[c.recommendedService as keyof typeof SERVICE_LABELS] : "—"}</td>
                    <td className="text-[12px]">{i.contactRole}{i.contactName ? ` — ${i.contactName}` : ""}</td>
                    <td>
                      {editable ? (
                        <div className="flex gap-1 items-center">
                          <Badge tone={tone(i.status)}>{label(i.status)}</Badge>
                          {i.status !== "approved" && <form action={decideItemAction.bind(null, id, i.id, "approved", undefined)}><Button variant="ghost" title="Goedkeuren">✓</Button></form>}
                          {i.status !== "rejected" && <form action={decideItemAction.bind(null, id, i.id, "rejected", "Handmatig afgewezen")}><Button variant="ghost" title="Afwijzen">✕</Button></form>}
                        </div>
                      ) : <Badge tone={tone(i.status)}>{label(i.status)}</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
        <aside>
          <Section title="Managementsamenvatting">
            <div className="border border-line rounded-lg bg-panel p-3">{list.managementSummary ? <Markdown text={list.managementSummary} /> : "—"}</div>
          </Section>
          <Section title="QA-rapport">
            {qa?.summary ? (
              <div className="text-[13px]">
                <div className="num">{qa.summary.reviewed} beoordeeld · <span className="text-ok">{qa.summary.approved} goedgekeurd</span> · <span className="text-bad">{qa.summary.rejected} afgewezen</span> · <span className="text-warn">{qa.summary.needsResearch} aanvullend onderzoek</span></div>
                {qa.summary.topIssues.length > 0 && <ul className="mt-2 list-disc pl-4 text-[12px] text-muted">{qa.summary.topIssues.map(([k, n]) => <li key={k}>{k} ({n}×)</li>)}</ul>}
                {qa.candidateCounts && <div className="mt-2 text-[12px] text-faint">Kandidaten: {Object.entries(qa.candidateCounts).map(([k, v]) => `${label(k)} ${v}`).join(" · ")}</div>}
              </div>
            ) : <div className="text-faint">—</div>}
          </Section>
          <Section title="Exporthistorie">
            {exports.length === 0 ? <div className="text-faint text-[12px]">Nog niet geëxporteerd.</div> : exports.map((e) => <div key={e.id} className="text-[12px]">{dt(e.createdAt)} · {e.format} · {e.rowCount} rijen <span className="text-faint font-mono">{e.contentHash.slice(0, 10)}</span></div>)}
          </Section>
        </aside>
      </div>
    </>
  );
}
