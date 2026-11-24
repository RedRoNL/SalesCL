import Link from "next/link";
import { desc } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { getSettings } from "@/lib/settings";
import { requirePageUser } from "@/lib/auth/current";
import { integrationStatus } from "@/lib/env";
import { startRunAction } from "@/app/actions";
import { PageHeader, Section, Badge, Field, Button, Empty, eur, dt } from "@/components/ui";
import { label, tone } from "@/lib/labels";

export default async function Research() {
  const user = await requirePageUser("viewer");
  const settings = await getSettings();
  const integ = integrationStatus();
  const db = getDb();
  const industries = (await db.select().from(schema.industries)).filter((i) => i.priorityTier > 0).sort((a, b) => a.priorityTier - b.priorityTier);
  const runs = await db.select().from(schema.researchRuns).orderBy(desc(schema.researchRuns.createdAt)).limit(30);
  const canRun = user.role !== "viewer";
  return (
    <>
      <PageHeader title="Onderzoekscentrum" subtitle={`Wekelijkse automatische run: ${settings.schedule.enabled ? `${settings.schedule.cron} (${settings.schedule.timezone}), doel ${settings.schedule.weeklyTarget}` : "uitgeschakeld"}. Handmatige, sector- en bedrijfsruns gebruiken dezelfde pijplijn.`} />
      <div className="grid xl:grid-cols-[420px_1fr] gap-8">
        <Section title="Nieuwe onderzoeksrun">
          {!integ.anthropic && <div className="mb-3 text-[12px] text-warn">ANTHROPIC_API_KEY ontbreekt — runs worden aangemaakt maar agents kunnen niet uitvoeren.</div>}
          <form action={startRunAction} className="flex flex-col gap-3 border border-line rounded-lg bg-panel p-4">
            <Field label="Type">
              <select name="kind" defaultValue="manual">
                <option value="manual">Handmatige run (CSO bepaalt strategie)</option>
                <option value="sector">Sectorgericht</option>
                <option value="company">Specifiek bedrijf</option>
              </select>
            </Field>
            <Field label="Doel (aantal prospects)"><input name="target" type="number" min={1} max={300} defaultValue={25} /></Field>
            <Field label="Sectoren" hint="Leeg = CSO kiest op basis van prestaties en dekking. Ctrl/Cmd voor meerdere.">
              <select name="industries" multiple size={7}>{industries.map((i) => <option key={i.code} value={i.code}>{i.nameNl} (T{i.priorityTier})</option>)}</select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Min. medewerkers"><input name="minEmployees" type="number" placeholder={String(settings.icp.minEmployees)} /></Field>
              <Field label="Max. medewerkers"><input name="maxEmployees" type="number" placeholder={String(settings.icp.maxEmployees)} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Bedrijfsnaam (bij bedrijfsrun)"><input name="companyName" maxLength={200} /></Field>
              <Field label="Website (optioneel)"><input name="companyWebsite" maxLength={300} placeholder="https://" /></Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Onderzoeksdiepte"><select name="depth" defaultValue={settings.research.depth}><option value="light">Licht</option><option value="standard">Standaard</option><option value="deep">Diep</option></select></Field>
              <Field label="Maximaal budget (€)"><input name="budgetEur" type="number" step="1" min={0} defaultValue={settings.budget.perRunDefaultEur} /></Field>
            </div>
            <Field label="Providers" hint="Configureerbaar in Instellingen → Onderzoek">
              <div className="text-[12px] text-muted">Zoeken: {settings.research.searchProvider} · Ophalen: {settings.research.fetchProvider} · DNS: {settings.research.dnsProvider} · Register: {settings.research.registryProvider}</div>
            </Field>
            <Field label="Extra instructies voor de CSO (optioneel)"><textarea name="instructions" rows={2} maxLength={1500} /></Field>
            <Button variant="primary" disabled={!canRun}>Start onderzoek</Button>
          </form>
        </Section>
        <Section title="Runs">
          {runs.length === 0 ? <Empty>Nog geen runs.</Empty> : (
            <table>
              <thead><tr><th>Gestart</th><th>Type</th><th>Status</th><th>Fase</th><th className="text-right">Doel</th><th className="text-right">Gekwal.</th><th className="text-right">Kosten</th><th>Door</th></tr></thead>
              <tbody>
                {runs.map((r) => {
                  const st = (r.stats ?? {}) as Record<string, number>;
                  return (
                    <tr key={r.id}>
                      <td><Link href={`/research/${r.id}`} className="text-accent">{dt(r.startedAt ?? r.createdAt)}</Link></td>
                      <td>{r.kind}</td>
                      <td><Badge tone={tone(r.status)}>{label(r.status)}</Badge></td>
                      <td className="text-muted">{r.stage ?? "—"}</td>
                      <td className="num text-right">{r.targetProspects}</td>
                      <td className="num text-right">{st.qualified ?? 0}</td>
                      <td className="num text-right">{eur(Number(r.costEur))}<span className="text-faint"> / {eur(Number(r.budgetEur), 0)}</span></td>
                      <td className="text-[12px] text-muted truncate max-w-32">{r.triggeredBy.split(":")[0]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Section>
      </div>
    </>
  );
}
