import { sql, desc } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { marketMap, commercialPerformance, type GroupStat } from "@/lib/analytics";
import { requirePageUser } from "@/lib/auth/current";
import { setIndustryPoolAction, decideRecommendationAction } from "@/app/actions";
import { PageHeader, Section, Badge, Bar, Empty, Button, pct, nf, dd } from "@/components/ui";
import { SIGNAL_LABELS, label, tone } from "@/lib/labels";

function StatTable({ rows, title }: { rows: GroupStat[]; title: string }) {
  return (
    <Section title={title}>
      {rows.length === 0 ? <div className="text-faint text-[12px]">Nog geen belresultaten.</div> : (
        <table><thead><tr><th>Groep</th><th className="text-right">n</th><th className="text-right">Afspraakratio</th><th>95%-interval</th><th>Bewijskracht</th></tr></thead><tbody>
          {rows.map((r) => <tr key={r.key}><td>{r.key}</td><td className="num text-right">{r.n}</td><td className="num text-right">{pct(r.rate)}</td><td className="num text-[12px] text-muted">{pct(r.ciLow)} – {pct(r.ciHigh)}</td><td><Badge tone={r.strength === "statistically_meaningful" ? "ok" : r.strength === "indicative" ? "accent" : "muted"}>{r.strength === "statistically_meaningful" ? "statistisch betekenisvol" : r.strength === "indicative" ? "indicatief" : "speculatief"}</Badge></td></tr>)}
        </tbody></table>
      )}
    </Section>
  );
}

export default async function Market() {
  const user = await requirePageUser("viewer");
  const db = getDb();
  const [map, perf] = await Promise.all([marketMap(), commercialPerformance()]);
  const signals = (await db.execute(sql`select signal_type as type, count(*)::int as n, count(*) filter (where created_at > now() - interval '30 days')::int as recent from buying_signals group by signal_type order by recent desc, n desc`)) as unknown as { type: string; n: number; recent: number }[];
  const geo = (await db.execute(sql`select coalesce(province, hq_city, nl_office_city, 'onbekend') as place, count(*)::int as n, count(*) filter (where status in ('qualified','approved','exported'))::int as q from companies where deleted_at is null group by 1 order by n desc limit 20`)) as unknown as { place: string; n: number; q: number }[];
  const discovery = (await db.execute(sql`select to_char(date_trunc('week', created_at), 'IYYY-"W"IW') as week, count(*)::int as n from companies where deleted_at is null group by 1 order by 1 desc limit 12`)) as unknown as { week: string; n: number }[];
  const recs = await db.select().from(schema.recommendations).orderBy(desc(schema.recommendations.createdAt)).limit(15);
  const industries = await db.select().from(schema.industries);
  const maxGeo = Math.max(1, ...geo.map((g) => g.n));
  return (
    <>
      <PageHeader title="Marktinformatie" subtitle={map.note} />
      <Section title="Marktdekking per sector">
        <div className="overflow-x-auto border border-line rounded-lg">
          <table>
            <thead><tr><th>Sector</th><th>Tier</th><th className="text-right">Ontdekt</th><th className="text-right">Onderzocht</th><th className="text-right">Gekwal.</th><th className="text-right">Geleverd</th><th className="text-right">Afspraken</th><th>Geschatte pool</th><th>Dekking</th><th>Uitputting (agent)</th><th>Laatst</th></tr></thead>
            <tbody>
              {map.industries.filter((i) => i.baseTier > 0).map((i) => {
                const ind = industries.find((x) => x.code === i.code)!;
                return (
                  <tr key={i.code}>
                    <td>{i.nameNl}{i.queriesUsed.length > 0 && <div className="text-[11px] text-faint" title={i.queriesUsed.join("\n")}>{i.queriesUsed.length} queries · {i.sourcesUsed.length} bronnen</div>}</td>
                    <td>{i.effectiveTier !== i.baseTier ? <span className="text-accent">T{i.effectiveTier}</span> : `T${i.baseTier}`}</td>
                    <td className="num text-right">{i.discovered}</td><td className="num text-right">{i.researched}</td><td className="num text-right">{i.qualified}</td><td className="num text-right">{i.exported}</td><td className="num text-right">{i.appointments}</td>
                    <td>
                      {user.role === "admin" ? (
                        <form action={setIndustryPoolAction.bind(null, ind.id)} className="flex gap-1">
                          <input name="size" defaultValue={ind.estimatedPoolSize ?? ""} placeholder="?" className="w-16 text-[12px]" inputMode="numeric" />
                          <input name="source" defaultValue={ind.poolEstimateSource ?? ""} placeholder="bron schatting" className="w-28 text-[12px]" />
                          <Button variant="ghost">✓</Button>
                        </form>
                      ) : <span className="num">{ind.estimatedPoolSize ?? "onbekend"}</span>}
                    </td>
                    <td className="w-28">{i.coverage != null ? <div className="flex items-center gap-1"><Bar value={i.coverage} max={1} /><span className="num text-[11px]">{pct(i.coverage, 0)}</span></div> : <span className="text-faint text-[12px]">onzeker</span>}</td>
                    <td className="num text-[12px] text-muted">{i.exhaustionEstimate != null ? `${pct(i.exhaustionEstimate, 0)} (onzeker)` : "—"}</td>
                    <td className="text-[12px] text-muted">{dd(i.lastResearchedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="grid xl:grid-cols-2 gap-8">
        <StatTable rows={perf.byIndustry} title="Commerciële prestaties per sector" />
        <StatTable rows={perf.bySize} title="Per bedrijfsomvang" />
        <StatTable rows={perf.byScoreBand} title="Per leadscore (valideert scoremodel)" />
        <StatTable rows={perf.bySignal} title="Per koopsignaal" />
        <StatTable rows={perf.byMicrosoftEvidence} title="Per Microsoft-bewijs" />
        <StatTable rows={perf.byService} title="Per aanbevolen dienst" />
      </div>
      <p className="text-[11px] text-faint -mt-4 mb-6">{perf.method} Correlatie is geen causaliteit.</p>

      <div className="grid xl:grid-cols-3 gap-8">
        <Section title="Opkomende koopsignalen">
          {signals.length === 0 ? <Empty>Nog geen signalen.</Empty> : <table><thead><tr><th>Signaal</th><th className="text-right">30 dgn</th><th className="text-right">Totaal</th></tr></thead><tbody>{signals.map((s) => <tr key={s.type}><td>{SIGNAL_LABELS[s.type] ?? s.type}</td><td className="num text-right">{s.recent}</td><td className="num text-right">{s.n}</td></tr>)}</tbody></table>}
        </Section>
        <Section title="Geografische spreiding">
          {geo.length === 0 ? <Empty>Geen data.</Empty> : <table><tbody>{geo.map((g) => <tr key={g.place}><td>{g.place}</td><td className="w-32"><Bar value={g.n} max={maxGeo} /></td><td className="num text-right">{g.n}</td><td className="num text-right text-ok">{g.q}</td></tr>)}</tbody></table>}
        </Section>
        <Section title="Historische ontdekking">
          {discovery.length === 0 ? <Empty>Geen data.</Empty> : <table><tbody>{discovery.map((d) => <tr key={d.week}><td>{d.week}</td><td className="num text-right">{nf(d.n)}</td></tr>)}</tbody></table>}
        </Section>
      </div>

      <Section title="Aanbevelingen (zelflerend)">
        {recs.length === 0 ? <Empty>Nog geen aanbevelingen — deze ontstaan uit belbureau-feedback.</Empty> : (
          <table><thead><tr><th>Aanbeveling</th><th>Bewijskracht</th><th>Status</th><th>Door</th><th></th></tr></thead><tbody>
            {recs.map((r) => (
              <tr key={r.id}>
                <td><div className="font-medium">{r.title}</div><div className="text-[12px] text-muted">{r.content}</div></td>
                <td><Badge tone={r.evidenceStrength === "statistically_meaningful" ? "ok" : r.evidenceStrength === "indicative" ? "accent" : "muted"}>{r.evidenceStrength}</Badge></td>
                <td><Badge tone={tone(r.status)}>{label(r.status)}</Badge>{r.requiresApproval && r.status === "proposed" && <div className="text-[11px] text-warn">vereist goedkeuring</div>}</td>
                <td className="text-[12px] text-muted">{r.createdBy}</td>
                <td>{user.role === "admin" && r.status === "proposed" && <div className="flex gap-1"><form action={decideRecommendationAction.bind(null, r.id, "approved")}><Button>Keur goed</Button></form><form action={decideRecommendationAction.bind(null, r.id, "rejected")}><Button variant="ghost">Wijs af</Button></form></div>}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </Section>
    </>
  );
}
