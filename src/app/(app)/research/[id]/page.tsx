import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db/client";
import { getRun } from "@/pipeline/runs";
import { requirePageUser } from "@/lib/auth/current";
import { runControlAction } from "@/app/actions";
import { AGENTS } from "@/agents/definitions";
import type { AgentId } from "@/agents/types";
import { PageHeader, Section, Badge, Metrics, Button, Empty, eur, dt } from "@/components/ui";
import { label, tone } from "@/lib/labels";
import { formatProspectId } from "@/domain/normalize";
import { Markdown } from "@/components/Markdown";

export default async function RunDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const user = await requirePageUser("viewer");
  const run = await getRun(id);
  if (!run) notFound();
  const db = getDb();
  const cands = await db.select({ rc: schema.runCandidates, c: schema.companies }).from(schema.runCandidates).innerJoin(schema.companies, eq(schema.companies.id, schema.runCandidates.companyId)).where(eq(schema.runCandidates.runId, id)).orderBy(desc(schema.companies.fitScore));
  const tasks = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.runId, id)).orderBy(desc(schema.agentTasks.createdAt)).limit(60);
  const [list] = await db.select().from(schema.prospectLists).where(eq(schema.prospectLists.runId, id));
  const strategy = run.strategy as { strategySummary?: string; industries?: { code: string; quota: number; sizeFocus: string; rationale: string }[]; risks?: string[] } | null;
  const count = (s: string) => cands.filter((x) => x.rc.status === s).length;
  const canCtl = user.role !== "viewer";
  const ctl = (a: "pause" | "resume" | "cancel" | "retry") => runControlAction.bind(null, id, a);
  return (
    <>
      <PageHeader
        title={`Onderzoeksrun · ${run.kind}`}
        subtitle={<span>Gestart {dt(run.startedAt ?? run.createdAt)} door {run.triggeredBy} · fase <b>{run.stage ?? "—"}</b>{run.pauseReason ? <span className="text-warn"> · {run.pauseReason}</span> : null}{run.error ? <span className="text-bad"> · {run.error}</span> : null}</span>}
        actions={
          <>
            <Badge tone={tone(run.status)}>{label(run.status)}</Badge>
            {canCtl && run.status === "running" && <form action={ctl("pause")}><Button>Pauzeer</Button></form>}
            {canCtl && run.status === "paused" && <form action={ctl("resume")}><Button variant="primary">Hervat</Button></form>}
            {canCtl && ["running", "paused", "queued"].includes(run.status) && <form action={ctl("cancel")}><Button variant="danger">Annuleer</Button></form>}
            {canCtl && count("failed") > 0 && <form action={ctl("retry")}><Button>Mislukte taken opnieuw</Button></form>}
            {list && <Link className="rounded-md border border-line-strong px-3 py-1.5 text-[13px]" href={`/lists/${list.id}`}>Weeklijst →</Link>}
          </>
        }
      />
      <Metrics items={[
        { label: "Kandidaten", value: cands.length }, { label: "Open", value: count("pending") + count("in_progress") }, { label: "Gekwalificeerd", value: count("done"), tone: "ok" },
        { label: "Afgewezen", value: count("rejected") }, { label: "Aanvullend onderzoek", value: count("skipped") }, { label: "Mislukt", value: count("failed"), tone: count("failed") ? "bad" : undefined },
        { label: "Kosten", value: eur(Number(run.costEur)), hint: `budget ${eur(Number(run.budgetEur), 0)}` },
      ]} />
      {run.managementSummary && <Section title="Managementsamenvatting" className="mt-6"><div className="border border-line rounded-lg bg-panel p-4"><Markdown text={run.managementSummary} /></div></Section>}
      {strategy && (
        <Section title="Strategie (Chief Sales Officer)" className="mt-6">
          <p className="mb-2">{strategy.strategySummary}</p>
          <table><thead><tr><th>Sector</th><th>Focus</th><th className="text-right">Quotum</th><th>Onderbouwing</th></tr></thead><tbody>
            {strategy.industries?.map((i) => <tr key={i.code + i.sizeFocus}><td>{i.code}</td><td>{i.sizeFocus}</td><td className="num text-right">{i.quota}</td><td className="text-[12px] text-muted">{i.rationale}</td></tr>)}
          </tbody></table>
        </Section>
      )}
      <div className="grid xl:grid-cols-[1.4fr_1fr] gap-8 mt-6">
        <Section title="Kandidaten (checkpoint per bedrijf)">
          {cands.length === 0 ? <Empty>Nog geen kandidaten.</Empty> : (
            <table><thead><tr><th>Bedrijf</th><th>Fase</th><th>Status</th><th className="text-right">Fit</th><th>Uitkomst</th></tr></thead><tbody>
              {cands.map(({ rc, c }) => (
                <tr key={rc.id}>
                  <td><Link href={`/prospects/${c.id}`} className="hover:text-accent">{c.officialName}</Link><div className="text-[11px] text-faint">{formatProspectId(c.prospectNumber)} · {AGENTS[rc.hunter as AgentId]?.nameNl ?? rc.hunter}</div></td>
                  <td className="text-muted">{rc.stage}</td>
                  <td><Badge tone={tone(rc.status)}>{label(rc.status)}</Badge>{rc.attempts > 1 && <span className="text-faint text-[11px]"> ×{rc.attempts}</span>}</td>
                  <td className="num text-right">{c.fitScore ?? "—"}</td>
                  <td className="text-[12px] text-muted max-w-80">{rc.outcome ?? rc.lastError ?? ""}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </Section>
        <Section title="Agenttaken (live log)">
          {tasks.length === 0 ? <Empty>Nog geen taken.</Empty> : (
            <ul className="space-y-1 text-[12px]">
              {tasks.map((t) => (
                <li key={t.id} className="flex gap-2 items-center">
                  <Badge tone={tone(t.status)}>{label(t.status)}</Badge>
                  <span className="truncate">{AGENTS[t.agentId as AgentId]?.nameNl}: {t.taskType}</span>
                  <span className="ml-auto text-faint num whitespace-nowrap">{t.toolCalls} tools · {eur(Number(t.costEur), 3)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
