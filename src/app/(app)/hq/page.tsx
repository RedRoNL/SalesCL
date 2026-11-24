import Link from "next/link";
import { randomUUID } from "node:crypto";
import { sql, desc, eq, like } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { AGENT_LIST, getAgent } from "@/agents/definitions";
import { getSettings } from "@/lib/settings";
import { requirePageUser } from "@/lib/auth/current";
import { modelAvailable } from "@/agents/model";
import { resolveModel } from "@/agents/runtime";
import { AgentChat } from "@/components/AgentChat";
import { PageHeader, Section, Badge, Empty, eur, pct, dt } from "@/components/ui";
import { label, tone } from "@/lib/labels";

const EXAMPLES: Record<string, string[]> = {
  chief_sales_officer: [
    "Vind 100 geschikte Nederlandse maakbedrijven.",
    "Onderzoek waarom de vorige prospectlijst slecht presteerde.",
    "Vind 20 nieuwe enterprise-kansen.",
    "Analyseer welke sectoren we hierna moeten targeten.",
  ],
  microsoft_intelligence_specialist: ["Onderzoek bedrijven die Microsoft Purview gebruiken."],
  midmarket_hunter: ["Vind Nederlandse logistieke bedrijven met meer dan 500 medewerkers."],
  lead_qualification_specialist: ["Onderzoek of een specifiek bedrijf een goede Protect 365-klant zou zijn."],
};

export default async function HQ({ searchParams }: { searchParams: Promise<{ agent?: string; thread?: string }> }) {
  const sp = await searchParams;
  const user = await requirePageUser("viewer");
  const settings = await getSettings();
  const db = getDb();
  const selected = getAgent(sp.agent ?? "chief_sales_officer");
  const threadId = sp.thread && /^[0-9a-f-]{36}$/.test(sp.thread) ? sp.thread : randomUUID();

  const stats = (await db.execute(sql`
    select agent_id as "agentId", count(*)::int as total,
      count(*) filter (where status='succeeded')::int as ok, count(*) filter (where status='failed')::int as failed,
      count(*) filter (where status='running')::int as running, coalesce(avg(cost_eur) filter (where status='succeeded'),0)::float as "avgCost",
      coalesce(sum(cost_eur),0)::float as cost, coalesce(sum(tool_calls),0)::int as tools, max(created_at) as last
    from agent_tasks group by agent_id`)) as unknown as { agentId: string; total: number; ok: number; failed: number; running: number; avgCost: number; cost: number; tools: number; last: string }[];
  const byId = new Map(stats.map((s) => [s.agentId, s]));
  const current = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.agentId, selected.id)).orderBy(desc(schema.agentTasks.createdAt)).limit(8);
  const qa = (await db.execute(sql`select verdict::text, count(*)::int as n from qa_reviews group by verdict`)) as unknown as { verdict: string; n: number }[];
  const qaTotal = qa.reduce((a, b) => a + b.n, 0);
  const comms = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.role, "delegation")).orderBy(desc(schema.agentMessages.createdAt)).limit(6);
  const recs = await db.select().from(schema.recommendations).where(like(schema.recommendations.createdBy, `agent:${selected.id}%`)).orderBy(desc(schema.recommendations.createdAt)).limit(5);
  const threads = (await db.execute(sql`select thread_id as "threadId", min(content) filter (where role='user') as first, max(created_at) as last from agent_messages where user_id = ${user.sub} and to_agent = ${selected.id} group by thread_id order by max(created_at) desc limit 6`)) as unknown as { threadId: string; first: string; last: string }[];
  const names = Object.fromEntries(AGENT_LIST.map((a) => [a.id, a.nameNl]));
  const s = byId.get(selected.id);

  return (
    <>
      <PageHeader title="Sales Army HQ" subtitle="Elf gespecialiseerde agents. Status, taken en kosten komen uit echte uitvoeringen in de agent-runtime — niets is gesimuleerd." />
      <div className="grid grid-cols-[260px_1fr_320px] gap-6">
        <div>
          <Link href={`/hq?agent=chief_sales_officer`} className={`block mb-3 rounded-md border px-3 py-2 ${selected.id === "chief_sales_officer" ? "border-accent bg-accent/10" : "border-line hover:bg-panel-2"}`}>
            <div className="text-[13px] font-medium">Hele Sales Army</div>
            <div className="text-[11px] text-muted">via de Chief Sales Officer, die delegeert</div>
          </Link>
          <div className="flex flex-col gap-1">
            {AGENT_LIST.map((a) => {
              const st = byId.get(a.id);
              return (
                <Link key={a.id} href={`/hq?agent=${a.id}`} className={`rounded-md px-3 py-1.5 border ${a.id === selected.id ? "border-line-strong bg-panel-2" : "border-transparent hover:bg-panel-2"}`}>
                  <div className="flex items-center gap-2 text-[13px]">
                    <span className="text-faint num w-5">{String(a.number).padStart(2, "0")}</span>
                    <span className="truncate">{a.nameNl}</span>
                    {st?.running ? <span className="ml-auto h-2 w-2 rounded-full bg-info" title="Actief" /> : null}
                  </div>
                  <div className="pl-7 text-[11px] text-faint num">{st ? `${st.total} taken · ${eur(st.cost)}` : "nog geen taken"}</div>
                </Link>
              );
            })}
          </div>
        </div>

        <div>
          {!(await modelAvailable()) && <div className="mb-3 text-[12px] text-warn border border-warn/30 bg-warn/10 rounded-md px-3 py-2">ANTHROPIC_API_KEY ontbreekt: berichten worden in de wachtrij gezet maar agents kunnen niet antwoorden.</div>}
          <AgentChat key={`${selected.id}:${threadId}`} agentId={selected.id} agentName={selected.id === "chief_sales_officer" ? "Chief Sales Officer (Sales Army)" : selected.nameNl} threadId={threadId} examples={EXAMPLES[selected.id] ?? ["Wat zijn je belangrijkste bevindingen van deze week?"]} names={names} canWrite={user.role !== "viewer"} />
          {threads.length > 0 && (
            <div className="mt-3 text-[12px] text-muted">
              Eerdere gesprekken:{" "}
              {threads.map((t) => (
                <Link key={t.threadId} href={`/hq?agent=${selected.id}&thread=${t.threadId}`} className="mr-3 text-accent">{(t.first ?? "gesprek").slice(0, 40)}</Link>
              ))}
              <Link href={`/hq?agent=${selected.id}`} className="text-accent">+ nieuw</Link>
            </div>
          )}
        </div>

        <aside className="text-[13px]">
          <Section title={`${String(selected.number).padStart(2, "0")} · ${selected.nameNl}`}>
            <p className="text-muted mb-3">{selected.mission}</p>
            <div className="text-[11px] uppercase tracking-wider text-faint mb-1">Verantwoordelijkheden</div>
            <ul className="list-disc pl-4 text-muted mb-3 space-y-0.5">{selected.responsibilities.map((r) => <li key={r}>{r}</li>)}</ul>
            <div className="text-[11px] uppercase tracking-wider text-faint mb-1">Skills</div>
            <div className="flex flex-wrap gap-1 mb-3">{(settings.agentSkills[selected.id] ?? selected.skills).map((k) => <Badge key={k} tone="accent">{k}</Badge>)}</div>
            <div className="text-[11px] uppercase tracking-wider text-faint mb-1">Tools (least privilege)</div>
            <div className="flex flex-wrap gap-1 mb-3">{selected.tools.map((k) => <Badge key={k}>{k}</Badge>)}</div>
            <div className="text-[11px] uppercase tracking-wider text-faint mb-1">Model</div>
            <div className="mb-3 font-mono text-[12px]">{resolveModel(settings, selected.id, selected.modelTier)} <span className="text-faint">({selected.modelTier})</span></div>
            <div className="text-[11px] uppercase tracking-wider text-faint mb-1">Prestaties</div>
            <div className="text-muted num mb-1">{s ? `${s.ok}/${s.total} geslaagd (${pct(s.total ? s.ok / s.total : null)}) · ${s.failed} mislukt · gem. ${eur(s.avgCost, 3)} per taak · ${s.tools} toolcalls` : "Nog geen uitvoeringen"}</div>
            {selected.id === "quality_assurance_director" && qaTotal > 0 && <div className="text-muted num mb-1">Afwijzingspercentage: {pct((qa.find((q) => q.verdict === "rejected")?.n ?? 0) / qaTotal)} (n={qaTotal})</div>}
            <div className="text-[11px] text-faint mb-3">KPI's: {selected.kpis.map((k) => k.label).join(" · ")}</div>
          </Section>
          <Section title="Recente taken">
            {current.length === 0 ? <Empty>Geen taken</Empty> : (
              <ul className="space-y-1.5">
                {current.map((t) => (
                  <li key={t.id} className="flex items-center gap-2">
                    <Badge tone={tone(t.status)}>{label(t.status)}</Badge>
                    <span className="truncate">{t.taskType}</span>
                    <span className="ml-auto text-faint text-[11px] num">{eur(Number(t.costEur), 3)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Agentcommunicatie">
            {comms.length === 0 ? <div className="text-faint">Nog geen delegaties.</div> : comms.map((c) => (
              <div key={c.id} className="mb-2 text-[12px]"><span className="text-muted">{names[c.fromAgent ?? ""]} → {names[c.toAgent ?? ""]}:</span> {c.content.slice(0, 140)} <span className="text-faint">{dt(c.createdAt)}</span></div>
            ))}
          </Section>
          {recs.length > 0 && (
            <Section title="Aanbevelingen">
              {recs.map((r) => <div key={r.id} className="mb-2 text-[12px]"><Badge tone={tone(r.status)}>{label(r.status)}</Badge> {r.title}</div>)}
            </Section>
          )}
        </aside>
      </div>
    </>
  );
}
