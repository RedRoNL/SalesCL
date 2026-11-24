import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db/client";
import { buildDossier } from "@/pipeline/dossier";
import { requirePageUser } from "@/lib/auth/current";
import { overrideQaAction, reactivateCompanyAction, setRelationshipAction, eraseCompanyAction } from "@/app/actions";
import { PageHeader, Section, Badge, Bar, Empty, Button, dt, dd, nf } from "@/components/ui";
import { label, tone, TECH_LABELS, SIGNAL_LABELS } from "@/lib/labels";
import { SERVICE_LABELS } from "@/domain/services";
import { CLASSIFICATION_LABELS, type ScoreComponent, type Classification } from "@/domain/scoring";
import { OUTCOME_LABELS } from "@/lib/feedbackImport";
import { AGENTS } from "@/agents/definitions";
import type { AgentId } from "@/agents/types";

export default async function Profile({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const user = await requirePageUser("viewer");
  const d = await buildDossier(id, false);
  if (!d) notFound();
  const db = getDb();
  const scores = await db.select().from(schema.qualificationScores).where(eq(schema.qualificationScores.companyId, id)).orderBy(desc(schema.qualificationScores.createdAt));
  const qa = await db.select().from(schema.qaReviews).where(eq(schema.qaReviews.companyId, id)).orderBy(desc(schema.qaReviews.createdAt));
  const calls = await db.select().from(schema.callingResults).where(eq(schema.callingResults.companyId, id)).orderBy(desc(schema.callingResults.createdAt));
  const deliveries = await db.select().from(schema.deliveries).where(eq(schema.deliveries.companyId, id));
  const tasks = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.companyId, id)).orderBy(desc(schema.agentTasks.createdAt)).limit(20);
  const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, id));
  const s = scores[0];
  const c = d.company;
  const srcLink = (sid: string | null | undefined) => {
    const src = d.sources.find((x) => x.id === sid);
    if (!src) return <span className="text-faint">geen bron</span>;
    return src.url.startsWith("http") ? <a href={src.url} target="_blank" rel="noopener noreferrer nofollow" className="text-accent text-[12px]">{src.type} ↗</a> : <span className="text-[12px] text-muted">{src.type}</span>;
  };
  return (
    <>
      <PageHeader
        title={c.officialName}
        subtitle={<span>{d.prospectId} · {c.domain ?? "geen domein"} · {c.industry?.name ?? "sector onbekend"} · laatst onderzocht {dd(c.lastResearchedAt)}</span>}
        actions={<><Badge tone={tone(c.status)}>{label(c.status)}</Badge><Badge tone={tone(c.contactEligibility)}>Contact: {label(c.contactEligibility)}</Badge>{c.relationship !== "none" && <Badge tone={tone(c.relationship)}>{label(c.relationship)}</Badge>}</>}
      />
      <div className="grid xl:grid-cols-[1fr_380px] gap-8">
        <div>
          <Section title="Kwalificatie">
            {s ? (
              <div className="border border-line rounded-lg bg-panel p-4">
                <div className="flex flex-wrap gap-8 mb-4">
                  <div><div className="text-[11px] uppercase text-muted">Commerciële fit</div><div className="text-3xl font-semibold num">{s.fitScore}</div></div>
                  <div><div className="text-[11px] uppercase text-muted">Bewijsbetrouwbaarheid</div><div className="text-3xl font-semibold num text-muted">{s.confidenceScore}</div></div>
                  <div><div className="text-[11px] uppercase text-muted">Classificatie</div><div className="mt-2"><Badge tone={tone(s.classification)}>{CLASSIFICATION_LABELS[s.classification as Classification]}</Badge></div></div>
                  <div><div className="text-[11px] uppercase text-muted">Aanbevolen dienst</div><div className="mt-1.5 font-medium">{SERVICE_LABELS[s.recommendedService as keyof typeof SERVICE_LABELS] ?? s.recommendedService}</div></div>
                </div>
                <table>
                  <tbody>
                    {(s.components as ScoreComponent[]).map((k) => (
                      <tr key={k.key}><td className="w-56">{k.label}</td><td className="w-40"><Bar value={k.points} max={k.max} /></td><td className="num text-right w-20">{k.points}/{k.max}</td><td className="text-muted text-[12px]">{k.explanation}</td></tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-4 whitespace-pre-wrap">{s.rationale}</p>
                {s.hardFailures.length > 0 && <p className="mt-2 text-bad text-[12px]">Harde blokkades: {s.hardFailures.join("; ")}</p>}
                {s.missingInformation.length > 0 && <p className="mt-2 text-warn text-[12px]">Ontbrekende informatie: {s.missingInformation.join(", ")}</p>}
                <p className="mt-2 text-faint text-[11px]">Scoremodel-versie en historie: {scores.length} beoordeling(en); laatste {dt(s.createdAt)}.</p>
              </div>
            ) : <Empty>Nog niet gekwalificeerd.</Empty>}
          </Section>

          <Section title="Microsoft-technologiebewijs">
            {d.technologyEvidence.length === 0 ? <Empty>Geen bewijs vastgelegd — onbekend.</Empty> : (
              <table><thead><tr><th>Technologie</th><th>Classificatie</th><th>Type</th><th>Toelichting</th><th>Bron</th></tr></thead><tbody>
                {d.technologyEvidence.map((t, i) => <tr key={i}><td>{TECH_LABELS[t.technology]}</td><td><Badge tone={tone(t.classification)}>{label(t.classification)}</Badge></td><td className="text-muted text-[12px]">{t.evidenceType}</td><td className="text-[12px]">{t.detail}</td><td>{srcLink(t.sourceId)}</td></tr>)}
              </tbody></table>
            )}
            <p className="text-[11px] text-faint mt-1">Een Exchange Online MX-record bewijst Microsoft-gehoste mail, niet het gebruik van Intune, Defender, Purview of een specifieke licentie.</p>
          </Section>

          <Section title="Koopsignalen">
            {d.buyingSignals.length === 0 ? <Empty>Geen onderbouwde koopsignalen gevonden.</Empty> : (
              <table><thead><tr><th>Signaal</th><th>Datum</th><th>Relevantie</th><th>Toelichting</th><th>Bron</th></tr></thead><tbody>
                {d.buyingSignals.map((b, i) => <tr key={i}><td>{SIGNAL_LABELS[b.type] ?? b.type}<div className="text-[12px] text-muted">{b.title}</div></td><td className="text-[12px]">{b.date ?? "onbekend"}</td><td><Badge tone={b.relevance === "high" ? "ok" : b.relevance === "medium" ? "accent" : "muted"}>{b.relevance}</Badge></td><td className="text-[12px]">{b.explanation}<div className="text-muted">{b.commercialAssessment}</div></td><td>{srcLink(b.sourceId)}</td></tr>)}
              </tbody></table>
            )}
          </Section>

          <Section title="Onderbouwde feiten">
            <table><thead><tr><th>Veld</th><th>Waarde</th><th className="text-right">Betrouwb.</th><th>Waargenomen</th><th>Bron</th></tr></thead><tbody>
              {d.facts.filter((f) => !["field_confidence", "compliance"].includes(f.field)).map((f, i) => <tr key={i}><td className="text-muted">{f.field}</td><td className="text-[12px]">{String((f.value as { v?: unknown })?.v ?? "")}</td><td className="num text-right">{Math.round(f.confidence * 100)}%</td><td className="text-[12px] text-muted">{dd(f.observedAt)}</td><td>{srcLink(f.sourceId)}</td></tr>)}
            </tbody></table>
          </Section>

          <Section title={`Bronnen (${d.sources.length})`}>
            <ul className="space-y-1 text-[12px]">
              {d.sources.map((src) => <li key={src.id} className="flex gap-2"><Badge>{src.type}</Badge>{src.url.startsWith("http") ? <a className="text-accent truncate" href={src.url} target="_blank" rel="noopener noreferrer nofollow">{src.title ?? src.url}</a> : <span className="truncate">{src.title ?? src.url}</span>}<span className="ml-auto text-faint">{dt(src.retrievedAt)}</span></li>)}
            </ul>
          </Section>
        </div>

        <aside>
          <Section title="Bedrijfsgegevens">
            <dl className="grid grid-cols-[130px_1fr] gap-y-1.5 text-[13px]">
              <dt className="text-muted">Officiële naam</dt><dd>{c.officialName}</dd>
              <dt className="text-muted">Handelsnaam</dt><dd>{c.tradingName ?? "—"}</dd>
              <dt className="text-muted">Website</dt><dd>{c.website ? <a href={c.website} target="_blank" rel="noopener noreferrer nofollow" className="text-accent">{c.website}</a> : "—"}</dd>
              <dt className="text-muted">Medewerkers</dt><dd className="num">{c.employees.count != null ? nf(c.employees.count) : c.employees.min != null ? `${nf(c.employees.min)}–${nf(c.employees.max)}` : "onbekend"} {c.employees.sourceId && srcLink(c.employees.sourceId)}</dd>
              <dt className="text-muted">Hoofdkantoor</dt><dd>{[c.hqCity, c.hqCountry].filter(Boolean).join(", ") || "—"}</dd>
              <dt className="text-muted">NL-vestiging</dt><dd>{c.nlOfficeCity ?? "—"}</dd>
              <dt className="text-muted">Moederbedrijf</dt><dd>{d.group ? `${d.group.name}${d.group.hqCountry ? ` (${d.group.hqCountry})` : ""}` : "—"}</dd>
              <dt className="text-muted">Inkoopbevoegdheid</dt><dd>{c.purchasingAuthority}</dd>
              <dt className="text-muted">Rechtsvorm</dt><dd>{c.legalForm ?? "onbekend"}</dd>
              <dt className="text-muted">KvK</dt><dd className="num">{c.kvkNumber ?? "—"}</dd>
              <dt className="text-muted">Telefoon (openbaar)</dt><dd className="num">{c.phone ?? "—"} {c.phoneSourceId && srcLink(c.phoneSourceId)}</dd>
              <dt className="text-muted">Contactgeschiktheid</dt><dd className="text-[12px]">{company.eligibilityReason ?? label(c.contactEligibility)}</dd>
            </dl>
          </Section>
          <Section title="IT-beslissers (rollen)">
            {d.contacts.length === 0 ? <div className="text-faint">Geen</div> : d.contacts.map((ct, i) => <div key={i} className="text-[13px]">{ct.role}{ct.name ? ` — ${ct.name}` : ""} {ct.sourceId && srcLink(ct.sourceId)}</div>)}
          </Section>
          <Section title="QA-reviews">
            {qa.length === 0 ? <div className="text-faint">Nog niet beoordeeld</div> : qa.map((r) => (
              <div key={r.id} className="mb-3 text-[12px] border-l-2 border-line-strong pl-3">
                <div className="flex gap-2 items-center"><Badge tone={r.verdict === "approved" ? "ok" : r.verdict === "rejected" ? "bad" : "warn"}>{r.verdict}</Badge><span className="text-faint">{dt(r.createdAt)}</span></div>
                {r.issues.length > 0 && <ul className="list-disc pl-4 mt-1 text-muted">{r.issues.slice(0, 6).map((x, i) => <li key={i}>{x}</li>)}</ul>}
                {r.overriddenBy && <div className="text-warn mt-1">Overschreven door beheerder: {r.overrideReason}</div>}
                {user.role === "admin" && r.verdict !== "approved" && !r.overriddenBy && (
                  <form action={overrideQaAction.bind(null, r.id, id)} className="mt-2 flex gap-2">
                    <input name="reason" placeholder="Gedocumenteerde reden (verplicht)" className="flex-1 text-[12px]" minLength={15} required />
                    <Button variant="danger">Overschrijf</Button>
                  </form>
                )}
              </div>
            ))}
          </Section>
          <Section title="Belhistorie">
            {calls.length === 0 ? <div className="text-faint">Geen feedback</div> : calls.map((cr) => <div key={cr.id} className={`text-[12px] mb-1 ${cr.supersededById ? "text-faint line-through" : ""}`}>{dd(cr.calledAt ?? cr.createdAt)} — {OUTCOME_LABELS[cr.outcome]}{cr.notes ? `: ${cr.notes}` : ""}</div>)}
            <div className="text-[11px] text-faint mt-1">{deliveries.length} keer geleverd aan belbureau.</div>
          </Section>
          <Section title="Agenthistorie">
            {tasks.map((t) => <div key={t.id} className="text-[12px] flex gap-2"><Badge tone={tone(t.status)}>{label(t.status)}</Badge><span>{AGENTS[t.agentId as AgentId]?.nameNl}: {t.taskType}</span><span className="ml-auto text-faint">{dd(t.createdAt)}</span></div>)}
          </Section>
          {user.role !== "viewer" && (
            <Section title="Beheer">
              <form action={setRelationshipAction.bind(null, id)} className="flex gap-2 mb-2">
                <select name="relationship" defaultValue={c.relationship === "opted_out" ? "none" : c.relationship} className="flex-1 text-[12px]">
                  <option value="none">Geen relatie</option><option value="customer">Bestaande klant</option><option value="active_opportunity">Actieve opportunity</option><option value="prior_prospect">Eerdere prospect</option><option value="rejected">Afgewezen</option>
                </select>
                <Button>Opslaan</Button>
              </form>
              {user.role === "admin" && (
                <>
                  <form action={reactivateCompanyAction.bind(null, id)} className="flex gap-2 mb-2">
                    <input name="reason" placeholder="Reden reactivatie" className="flex-1 text-[12px]" minLength={10} required />
                    <Button>Reactiveer</Button>
                  </form>
                  <form action={eraseCompanyAction.bind(null, id)}>
                    <Button variant="danger">AVG: wis gegevens</Button>
                  </form>
                </>
              )}
            </Section>
          )}
        </aside>
      </div>
    </>
  );
}
