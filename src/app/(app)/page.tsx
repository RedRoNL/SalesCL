import Link from "next/link";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { dashboardStats, marketMap } from "@/lib/analytics";
import { AGENTS } from "@/agents/definitions";
import { PageHeader, Section, Metrics, Badge, Bar, Empty, eur, pct, nf, dt } from "@/components/ui";
import { label, tone } from "@/lib/labels";
import type { AgentId } from "@/agents/types";

export default async function Dashboard() {
  const [s, map] = await Promise.all([dashboardStats(), marketMap()]);
  const researchedTotal = (await getDb().execute(sql`select count(*)::int as n from companies where last_researched_at is not null and deleted_at is null`)) as unknown as { n: number }[];
  const run = s.activeRun;
  const industries = map.industries.filter((i) => i.baseTier > 0);
  const maxDisc = Math.max(1, ...industries.map((i) => i.discovered));
  return (
    <>
      <PageHeader title="Dashboard" subtitle="Operationele stand van het Sales Army. Alle cijfers komen uit de database; geschatte waarden zijn als zodanig gemarkeerd." />
      <Metrics
        items={[
          { label: "Bedrijven in database", value: nf(s.companies.total) },
          { label: "Gekwalificeerd deze week", value: nf(s.companies.qualifiedThisWeek) },
          { label: "Onderzocht deze week", value: nf(s.companies.researchedThisWeek), hint: `${nf(researchedTotal[0].n)} totaal` },
          { label: "Afgewezen deze week", value: nf(s.companies.rejectedThisWeek) },
          { label: "Geleverd (totaal)", value: nf(s.companies.exported) },
          { label: "Afspraken", value: nf(s.appointments) },
          { label: "Conversie (afspraak/gebeld)", value: pct(s.conversion.called ? s.conversion.rate : null), hint: s.conversion.called ? `n=${s.conversion.called}, 95%-CI ${pct(s.conversion.ci.low)}–${pct(s.conversion.ci.high)}` : "nog geen feedback" },
          { label: "Gem. fitscore gekwalificeerd", value: s.companies.avgFit ?? "—" },
          { label: "Geschatte pijplijn (MRR)", value: eur(s.revenue.estimatedOpenMrrEur, 0), hint: "schatting — niet gecontracteerd" },
          { label: "Gecontracteerd (MRR)", value: eur(s.revenue.contractedMrrEur, 0), hint: `${s.revenue.conversions} klanten` },
          { label: "Onderzoekskosten deze week", value: eur(s.costs.week) },
          { label: "Kosten per gekwalificeerde", value: eur(s.costs.perQualified), hint: s.costs.perAppointment != null ? `${eur(s.costs.perAppointment)} per afspraak` : undefined },
        ]}
      />

      <div className="grid xl:grid-cols-[1.2fr_1fr] gap-8 mt-7">
        <div>
          <Section title="Huidige onderzoeksrun" aside={<Link className="text-[12px] text-accent" href="/research">Onderzoekscentrum →</Link>}>
            {run ? (
              <Link href={`/research/${run.id}`} className="block border border-line rounded-lg bg-panel px-4 py-3 hover:border-line-strong">
                <div className="flex items-center gap-2">
                  <Badge tone={tone(run.status)}>{label(run.status)}</Badge>
                  <span className="text-muted">{run.kind}</span>
                  <span className="text-faint">· fase: {run.stage ?? "—"}</span>
                  <span className="ml-auto num">{eur(Number(run.costEur))} / {eur(Number(run.budgetEur))}</span>
                </div>
                <div className="mt-2 text-[12px] text-muted num">
                  {Object.entries((run.stats as Record<string, unknown>) ?? {}).filter(([, v]) => typeof v === "number").map(([k, v]) => `${k}: ${v}`).join(" · ") || "Nog geen voortgang"}
                </div>
                {run.pauseReason && <div className="mt-1 text-[12px] text-warn">{run.pauseReason}</div>}
              </Link>
            ) : (
              <Empty>Geen actieve run. De volgende wekelijkse run start automatisch op maandag 08:00 (Europe/Amsterdam).</Empty>
            )}
          </Section>

          <Section title="Onderzoeksdekking per sector" aside={<Link className="text-[12px] text-accent" href="/market">Marktinformatie →</Link>}>
            <table>
              <thead><tr><th>Sector</th><th className="w-[30%]">Ontdekt</th><th className="text-right">Gekwal.</th><th className="text-right">Afspraken</th><th className="text-right">Dekking</th></tr></thead>
              <tbody>
                {industries.map((i) => (
                  <tr key={i.code}>
                    <td>{i.nameNl} <span className="text-faint text-[11px]">T{i.effectiveTier}</span></td>
                    <td><div className="flex items-center gap-2"><Bar value={i.discovered} max={maxDisc} /><span className="num text-[12px] text-muted w-8 text-right">{i.discovered}</span></div></td>
                    <td className="num text-right">{i.qualified}</td>
                    <td className="num text-right">{i.appointments}</td>
                    <td className="num text-right text-muted" title="Alleen bekend als poolgrootte is vastgelegd">{i.coverage != null ? pct(i.coverage, 0) : "onbekend"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </div>

        <Section title="Agentactiviteit (7 dagen)" aside={<Link className="text-[12px] text-accent" href="/hq">HQ →</Link>}>
          {s.agentActivity.length === 0 ? (
            <Empty>Nog geen agenttaken uitgevoerd.</Empty>
          ) : (
            <table>
              <thead><tr><th>Agent</th><th className="text-right">Taken</th><th className="text-right">Actief</th><th className="text-right">Mislukt</th><th className="text-right">Kosten</th><th>Laatst</th></tr></thead>
              <tbody>
                {s.agentActivity.sort((a, b) => AGENTS[a.agentId as AgentId].number - AGENTS[b.agentId as AgentId].number).map((a) => (
                  <tr key={a.agentId}>
                    <td>{AGENTS[a.agentId as AgentId]?.nameNl ?? a.agentId}</td>
                    <td className="num text-right">{a.tasks}</td>
                    <td className="num text-right">{a.running ? <span className="text-info">{a.running}</span> : 0}</td>
                    <td className="num text-right">{a.failed ? <span className="text-bad">{a.failed}</span> : 0}</td>
                    <td className="num text-right">{eur(a.cost)}</td>
                    <td className="text-muted text-[12px] whitespace-nowrap">{dt(a.lastActive)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="mt-3 text-[12px] text-faint num">AI {eur(s.costs.aiTotal)} · providers {eur(s.costs.providersTotal)} · totaal {eur(s.costs.total)}</div>
        </Section>
      </div>
    </>
  );
}
