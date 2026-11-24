import Link from "next/link";
import { requirePageUser } from "@/lib/auth/current";
import { pilotMetrics, pilotRuns, PILOT_PRESETS } from "@/lib/pilots";
import { PageHeader, Section, Metrics, Badge, Empty, eur, dt } from "@/components/ui";
import { label, tone } from "@/lib/labels";

export default async function Pilots({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  await requirePageUser("viewer");
  const { run } = await searchParams;
  const runs = await pilotRuns();
  const selected = run ?? runs[0]?.id;
  const m = selected ? await pilotMetrics(selected) : null;
  return (
    <>
      <PageHeader title="Live pilots" subtitle="Drie pilots (maakindustrie, logistiek & transport, overige operationele sectoren) van elk 10 gekwalificeerde bedrijven met 300–5.000 medewerkers. Starten via Setup → stap 10, met expliciete budgetgoedkeuring." />
      {runs.length === 0 ? <Empty>Nog geen pilots uitgevoerd. <Link href="/setup#stap-10" className="text-accent">Naar Setup →</Link></Empty> : (
        <>
          <div className="flex gap-2 mb-5 flex-wrap">
            {runs.map((r) => {
              const key = (r.params as { pilot?: keyof typeof PILOT_PRESETS }).pilot;
              return <Link key={r.id} href={`/pilots?run=${r.id}`} className={`rounded-md border px-3 py-1.5 text-[12px] ${r.id === selected ? "border-accent bg-accent/10" : "border-line"}`}>{key ? PILOT_PRESETS[key]?.label : "pilot"} · {dt(r.createdAt)} <Badge tone={tone(r.status)}>{label(r.status)}</Badge></Link>;
            })}
          </div>
          {m && (
            <>
              <Metrics items={[
                { label: "Kandidaten ontdekt", value: m.candidatesDiscovered }, { label: "Afgewezen", value: m.candidatesRejected }, { label: "Gekwalificeerd", value: `${m.qualified}/${m.target}`, tone: m.qualified >= m.target ? "ok" : "warn" },
                { label: "Geverifieerd Microsoft-bewijs", value: m.verifiedMicrosoftEvidence, hint: "M365/Exchange Online ≥ sterk aangewezen" }, { label: "Geverifieerde telefoonnummers", value: m.verifiedPhones, hint: "letterlijk op bron gevonden" }, { label: "Onderbouwde medewerkersaantallen", value: m.verifiedEmployeeCounts },
                { label: "Duur", value: m.durationMinutes != null ? `${m.durationMinutes} min` : "—" }, { label: "Totale kosten", value: eur(m.totalCostEur), hint: `AI ${eur(m.aiCostEur)} · providers ${eur(m.providerCostEur)}` }, { label: "Kosten per gekwalificeerde", value: eur(m.costPerQualifiedEur) },
                { label: "Duplicaten gedetecteerd", value: m.duplicatesDetected }, { label: "Reserve (doel bereikt)", value: m.reserve },
              ]} />
              <div className="grid xl:grid-cols-3 gap-8 mt-6">
                <Section title="Bronkwaliteit">
                  {m.sourceQuality.length === 0 ? <Empty>Geen bronnen.</Empty> : <table><thead><tr><th>Bron</th><th className="text-right">Gevonden</th><th className="text-right">Uniek</th><th className="text-right">Gekwal.</th></tr></thead><tbody>
                    {m.sourceQuality.map((s, i) => <tr key={i}><td>{s.name}<div className="text-[11px] text-faint">{s.type}</div></td><td className="num text-right">{s.found}</td><td className="num text-right">{s.unique}</td><td className="num text-right">{s.qualified}</td></tr>)}
                  </tbody></table>}
                </Section>
                <Section title="Afwijzingsredenen">
                  <table><tbody>{Object.entries(m.rejectionReasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => <tr key={k}><td>{k}</td><td className="num text-right">{v}</td></tr>)}</tbody></table>
                </Section>
                <Section title="QA-afwijzingsredenen">
                  {Object.keys(m.qaRejectionReasons).length === 0 ? <div className="text-faint">Geen.</div> : <table><tbody>{Object.entries(m.qaRejectionReasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => <tr key={k}><td className="text-[12px]">{k}</td><td className="num text-right">{v}</td></tr>)}</tbody></table>}
                </Section>
              </div>
              <Link href={`/research/${m.runId}`} className="text-accent text-[13px]">Volledige run →</Link>
            </>
          )}
        </>
      )}
    </>
  );
}
