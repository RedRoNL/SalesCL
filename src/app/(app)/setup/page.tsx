import Link from "next/link";
import type { ReactNode } from "react";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { requirePageUser } from "@/lib/auth/current";
import { getSettings } from "@/lib/settings";
import { env } from "@/lib/env";
import { secretStatus, entraConfig, type SecretName } from "@/lib/secrets";
import { lastChecks, workerStatus } from "@/lib/integrations";
import { estimateWeeklyCost, SCENARIOS } from "@/lib/costModel";
import { PILOT_PRESETS, pilotRuns } from "@/lib/pilots";
import { KIND_LABELS } from "@/lib/historicalImport";
import { HistoricalImporter } from "@/components/HistoricalImporter";
import { addExclusionAction } from "@/app/actions";
import { saveSecretAction, deleteSecretAction, runCheckAction, saveProvidersAction, saveEntraAction, saveBudgetAction, saveScheduleAction, startPilotAction, startFirstRunAction } from "@/app/setup-actions";
import { PageHeader, Badge, Button, Field, eur, dt } from "@/components/ui";
import { label, tone } from "@/lib/labels";

type Status = "ok" | "warn" | "todo" | "optional";
const STATUS: Record<Status, [string, "ok" | "warn" | "bad" | "muted"]> = { ok: ["Gereed", "ok"], warn: ["Aandacht", "warn"], todo: ["Te doen", "bad"], optional: ["Optioneel", "muted"] };

function Step({ n, title, status, outside, children }: { n: number; title: string; status: Status; outside?: string; children: ReactNode }) {
  return (
    <section id={`stap-${n}`} className="border border-line rounded-lg bg-panel mb-4">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-line">
        <span className="num text-faint w-6">{String(n).padStart(2, "0")}</span>
        <h2 className="font-medium">{title}</h2>
        <span className="ml-auto"><Badge tone={STATUS[status][1]}>{STATUS[status][0]}</Badge></span>
      </div>
      <div className="px-4 py-3 text-[13px]">
        {outside && <p className="mb-3 text-[12px] text-warn border border-warn/30 bg-warn/10 rounded px-2 py-1">Buiten de applicatie: {outside}</p>}
        {children}
      </div>
    </section>
  );
}

function SecretField({ name, label: lbl, status, check }: { name: SecretName; label: string; status: Awaited<ReturnType<typeof secretStatus>>[SecretName]; check?: { ok: boolean; message: string; checkedAt: string } }) {
  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <span className="text-muted">{lbl}</span>
        {status.source ? <Badge tone="accent">{status.source === "env" ? "via omgevingsvariabele" : "opgeslagen (versleuteld)"} ••••{status.last4}</Badge> : <Badge>niet ingesteld</Badge>}
        {check && <Badge tone={check.ok ? "ok" : "bad"} title={dt(check.checkedAt)}>{check.ok ? "✓" : "✕"} {check.message}</Badge>}
      </div>
      {status.source !== "env" && (
        <div className="flex gap-2">
          <form action={saveSecretAction.bind(null, name)} className="flex gap-2 flex-1">
            <input name="value" type="password" autoComplete="off" placeholder={status.source ? "Nieuwe waarde om te vervangen" : "Plak sleutel"} className="flex-1" minLength={8} required />
            <Button>Opslaan &amp; valideren</Button>
          </form>
          {status.source && <form action={runCheckAction.bind(null, name)}><Button variant="ghost">Opnieuw testen</Button></form>}
          {status.source && <form action={deleteSecretAction.bind(null, name)}><Button variant="ghost">Verwijderen</Button></form>}
        </div>
      )}
      {status.source === "env" && <form action={runCheckAction.bind(null, name)}><Button variant="ghost">Testen</Button></form>}
    </div>
  );
}

export default async function Setup() {
  await requirePageUser("admin");
  const s = await getSettings();
  const e = env();
  const [secrets, checks, worker, entra, pilots] = await Promise.all([secretStatus(), lastChecks(), workerStatus(), entraConfig(), pilotRuns()]);
  const db = getDb();
  const [counts] = (await db.execute(sql`select
    (select count(*) from companies where relationship = 'customer')::int as customers,
    (select count(*) from companies where relationship = 'active_opportunity')::int as opportunities,
    (select count(distinct company_id) from deliveries)::int as delivered,
    (select count(*) from exclusions where active)::int as exclusions,
    (select count(*) from exclusions where active and scope = 'domain')::int as domainExclusions,
    (select count(*) from suppressions)::int as suppressions,
    (select count(*) from discovery_sources where status in ('active','unverified'))::int as sources`)) as unknown as Record<string, number>[];
  const ok = (k: string) => checks[k]?.ok === true;
  const search = s.research.searchProvider;
  const searchReady = (search === "anthropic_web_search" && ok("ANTHROPIC_API_KEY") && s.budget.approvedPaidProviders.includes("anthropic_web_search")) || (search === "brave" && ok("BRAVE_SEARCH_API_KEY") && s.budget.approvedPaidProviders.includes("brave")) || (search === "firecrawl" && ok("FIRECRAWL_API_KEY") && s.budget.approvedPaidProviders.includes("firecrawl"));
  const platformOk = Boolean(e.SESSION_SECRET) && worker.alive;
  const realistic = estimateWeeklyCost({ ...SCENARIOS.realistic, qualifiedPerWeek: s.schedule.weeklyTarget }, { kvk: s.research.registryProvider === "kvk", firecrawlSubscription: Boolean(secrets.FIRECRAWL_API_KEY.source) });
  const conservative = estimateWeeklyCost({ ...SCENARIOS.conservative, qualifiedPerWeek: s.schedule.weeklyTarget }, { kvk: s.research.registryProvider === "kvk", firecrawlSubscription: Boolean(secrets.FIRECRAWL_API_KEY.source) });
  const [cronM, cronH, , , cronDow] = s.schedule.cron.split(" ");
  const readyForLive = ok("ANTHROPIC_API_KEY") && searchReady && worker.alive && ok("connectivity");
  const redirect = `${e.APP_URL.replace(/\/$/, "")}/api/auth/callback`;

  return (
    <>
      <PageHeader title="Setup" subtitle="Doorloop deze stappen één keer. Elke stap toont de werkelijke operationele status. Wat buiten de applicatie moet gebeuren staat per stap aangegeven." />

      <Step n={1} title="Platform & worker" status={platformOk ? (e.SECRETS_ENCRYPTION_KEY ? "ok" : "warn") : "todo"} outside="hosting, PostgreSQL, en de omgevingsvariabelen DATABASE_URL, APP_URL, SESSION_SECRET, SECRETS_ENCRYPTION_KEY en SETUP_TOKEN (zie DEPLOYMENT.md). De worker draait als apart proces.">
        <ul className="space-y-1">
          <li>Database: <Badge tone="ok">verbonden</Badge></li>
          <li>SESSION_SECRET: <Badge tone={e.SESSION_SECRET ? "ok" : "bad"}>{e.SESSION_SECRET ? "ingesteld" : "ontbreekt"}</Badge></li>
          <li>SECRETS_ENCRYPTION_KEY: <Badge tone={e.SECRETS_ENCRYPTION_KEY ? "ok" : "warn"}>{e.SECRETS_ENCRYPTION_KEY ? "ingesteld" : "niet ingesteld — sleutels worden versleuteld met een van SESSION_SECRET afgeleide sleutel"}</Badge></li>
          <li>APP_URL: <span className="font-mono text-[12px]">{e.APP_URL}</span></li>
          <li>Worker: <Badge tone={worker.alive ? "ok" : "bad"}>{worker.message}</Badge> {worker.schedule && <span className="text-muted">planning {worker.schedule}</span>}</li>
        </ul>
      </Step>

      <Step n={2} title="Claude API (Anthropic)" status={ok("ANTHROPIC_API_KEY") ? "ok" : "todo"} outside="maak een API-sleutel aan in de Anthropic Console (console.anthropic.com) en stel daar een maandlimiet in.">
        <SecretField name="ANTHROPIC_API_KEY" label="ANTHROPIC_API_KEY" status={secrets.ANTHROPIC_API_KEY} check={checks.ANTHROPIC_API_KEY} />
        <p className="text-[12px] text-faint">Validatie gebruikt de gratis Models-API. Modellen: snel {s.models.fast}, standaard {s.models.standard}, sterk {s.models.strong} (Instellingen → AI-modelconfiguratie).</p>
      </Step>

      <Step n={3} title="Onderzoeksproviders" status={searchReady && ok("connectivity") ? "ok" : "todo"}>
        <form action={saveProvidersAction} className="grid md:grid-cols-2 gap-4">
          <Field label="Zoekprovider (ontdekking)" hint="Claude-webzoekopdrachten vereisen geen extra abonnement (~€0,01 per zoekopdracht). Brave is het goedkoopst bij hoog volume (~€0,005).">
            <select name="searchProvider" defaultValue={search}>
              <option value="anthropic_web_search">Claude web search (aanbevolen: geen extra abonnement)</option>
              <option value="brave">Brave Search API (optioneel, eigen abonnement)</option>
              <option value="firecrawl">Firecrawl search (optioneel, eigen abonnement)</option>
              <option value="none">Geen (alleen bronnen-oogst zonder zoeken)</option>
            </select>
          </Field>
          <Field label="Betaalde providers expliciet goedkeuren" hint="Zonder goedkeuring wordt een betaalde provider nooit aangeroepen.">
            <div className="flex flex-col gap-1">
              {[["anthropic_web_search", "Claude web search"], ["brave", "Brave Search"], ["firecrawl", "Firecrawl"], ["kvk", "KvK API"]].map(([v, l]) => (
                <label key={v} className="flex gap-2 items-center"><input type="checkbox" name="approvedPaidProviders" value={v} defaultChecked={s.budget.approvedPaidProviders.includes(v)} /> {l}</label>
              ))}
            </div>
          </Field>
          <Field label="Pagina's ophalen" hint="Directe HTTP (gratis, respecteert robots.txt). Firecrawl alleen als JavaScript-renderfallback — nooit om blokkades of CAPTCHA's te omzeilen.">
            <label className="flex gap-2 items-center"><input type="checkbox" name="firecrawlRenderFallback" defaultChecked={s.research.firecrawlRenderFallback} /> Firecrawl gebruiken voor JavaScript-pagina's</label>
          </Field>
          <Field label="Bedrijfsregister" hint="KvK Basisprofiel: €6,20/mnd + €0,02 per bevraging. Aanbevolen: verifieert rechtsvorm (belgeschiktheid) en werkzame personen.">
            <select name="registryProvider" defaultValue={s.research.registryProvider}><option value="none">Geen</option><option value="kvk">KvK API</option></select>
          </Field>
          <Field label="Entra-tenantcontrole (optioneel)" hint="Vraagt Microsofts publieke OpenID-metadata op voor een domein. Geen verkeer naar de prospect, geen gebruikersenumeratie. Standaard uit.">
            <label className="flex gap-2 items-center"><input type="checkbox" name="tenantDiscovery" defaultChecked={s.integrations.tenantDiscovery} /> Inschakelen</label>
          </Field>
          <Field label="Testpagina voor uitgaand verkeer"><input name="connectivityTestUrl" defaultValue={s.integrations.connectivityTestUrl} /></Field>
          <div className="md:col-span-2"><Button>Opslaan</Button></div>
        </form>
        <div className="mt-4 border-t border-line pt-3">
          <SecretField name="BRAVE_SEARCH_API_KEY" label="BRAVE_SEARCH_API_KEY (optioneel)" status={secrets.BRAVE_SEARCH_API_KEY} check={checks.BRAVE_SEARCH_API_KEY} />
          <SecretField name="FIRECRAWL_API_KEY" label="FIRECRAWL_API_KEY (optioneel)" status={secrets.FIRECRAWL_API_KEY} check={checks.FIRECRAWL_API_KEY} />
          <div className="flex items-center gap-2">
            <form action={runCheckAction.bind(null, "connectivity")}><Button>Test uitgaand web- en DNS-verkeer</Button></form>
            {checks.connectivity && <Badge tone={checks.connectivity.ok ? "ok" : "bad"}>{checks.connectivity.message}</Badge>}
          </div>
        </div>
      </Step>

      <Step n={4} title="Bedrijfsinformatie (optioneel): KvK" status={ok("KVK_API_KEY") ? "ok" : "optional"} outside="vraag een KvK API-sleutel aan op developers.kvk.nl (abonnement per API-sleutel).">
        <SecretField name="KVK_API_KEY" label="KVK_API_KEY" status={secrets.KVK_API_KEY} check={checks.KVK_API_KEY} />
        <p className="text-[12px] text-faint">Zonder KvK haalt het systeem rechtsvorm en KvK-nummer van de eigen website (colofon/voorwaarden). Bedrijven waarvoor dat niet lukt blijven 'onbekend' en komen niet op de bellijst. Commerciële databases (Company.info, Graydon/Creditsafe, D&amp;B) zijn niet nodig voor basiswerking; zie COSTS.md.</p>
      </Step>

      <Step n={5} title="Microsoft Entra ID (inloggen)" status={ok("ENTRA_CLIENT_SECRET") ? "ok" : entra.tenantId ? "warn" : "todo"} outside={`registreer een app in Entra ID (single tenant), redirect-URI ${redirect}, maak een clientgeheim en de app-rollen SalesArmy.Admin en SalesArmy.Analyst (vereist een Entra-beheerder).`}>
        <form action={saveEntraAction} className="grid md:grid-cols-2 gap-3">
          <Field label="Tenant-ID"><input name="tenantId" defaultValue={entra.tenantId ?? ""} placeholder="00000000-0000-0000-0000-000000000000" disabled={Boolean(process.env.ENTRA_TENANT_ID)} /></Field>
          <Field label="Client-ID (applicatie-ID)"><input name="clientId" defaultValue={entra.clientId ?? ""} disabled={Boolean(process.env.ENTRA_CLIENT_ID)} /></Field>
          <Field label="Clientgeheim" hint={secrets.ENTRA_CLIENT_SECRET.source ? `ingesteld ••••${secrets.ENTRA_CLIENT_SECRET.last4} — leeg laten om te behouden` : "nog niet ingesteld"}><input name="clientSecret" type="password" autoComplete="off" /></Field>
          <div />
          <Field label="Beheerdersgroep-ID (optioneel)"><input name="adminGroupId" defaultValue={entra.adminGroupId ?? ""} /></Field>
          <Field label="Analistengroep-ID (optioneel)"><input name="analystGroupId" defaultValue={entra.analystGroupId ?? ""} /></Field>
          <div className="md:col-span-2 flex items-center gap-2"><Button>Opslaan &amp; valideren</Button>{checks.ENTRA_CLIENT_SECRET && <Badge tone={checks.ENTRA_CLIENT_SECRET.ok ? "ok" : "bad"}>{checks.ENTRA_CLIENT_SECRET.message}</Badge>}</div>
        </form>
        <p className="text-[12px] text-faint mt-2">Na de eerste Entra-login van een beheerder sluit de SETUP_TOKEN-toegang automatisch.</p>
      </Step>

      <Step n={6} title="Bestaande commerciële data importeren" status={counts.customers + counts.delivered > 0 ? "ok" : "todo"}>
        <p className="mb-2 text-muted">Nu bekend: {counts.customers} klanten · {counts.opportunities} actieve opportunities · {counts.delivered} eerder geleverde bedrijven · {counts.suppressions} opt-outs. Elke kolomindeling; matching op KvK, (oude) domeinen incl. e-maildomein, telefoon en naam.</p>
        <HistoricalImporter kinds={KIND_LABELS} />
      </Step>

      <Step n={7} title="Uitsluitingen" status={counts.domainExclusions > 0 ? "ok" : "warn"}>
        <p className="mb-2 text-muted">{counts.exclusions} actieve uitsluitingen (incl. permanente seeds Visma/ProActive, RedFoxBlue, ZIGT Mediabureau, The Sales Unit en concurrent-sectoren). Voeg domeinen van concurrenten en partners toe — seeds zijn op naam.</p>
        <form action={addExclusionAction} className="flex flex-wrap gap-2">
          <input type="hidden" name="scope" value="domain" />
          <input type="hidden" name="category" value="competitor" />
          <input name="value" placeholder="concurrent.nl" required />
          <input name="reason" placeholder="Reden" defaultValue="Concurrent / partner" required />
          <Button>Domein uitsluiten</Button>
          <Link href="/settings" className="text-accent self-center">Alle uitsluitingen →</Link>
        </form>
      </Step>

      <Step n={8} title="Budget" status={s.budget.weeklyEur > 0 ? "ok" : "todo"}>
        <form action={saveBudgetAction} className="flex flex-wrap gap-3 items-end mb-3">
          <Field label="Weekbudget (€)"><input name="weeklyEur" type="number" step="1" defaultValue={s.budget.weeklyEur} /></Field>
          <Field label="Maandbudget (€)"><input name="monthlyEur" type="number" step="1" defaultValue={s.budget.monthlyEur} /></Field>
          <Field label="Standaard per run (€)"><input name="perRunDefaultEur" type="number" step="1" defaultValue={s.budget.perRunDefaultEur} /></Field>
          <Button>Opslaan</Button>
        </form>
        <p className="text-muted">Geschatte variabele kosten voor {s.schedule.weeklyTarget} gekwalificeerde bedrijven per week (huidige configuratie, zie COSTS.md voor aannames):</p>
        <table className="mt-1 max-w-xl"><tbody>
          <tr><td>Realistisch</td><td className="num text-right">{eur(realistic.weeklyEur)} / week</td><td className="num text-right">{eur(realistic.monthlyEur, 0)} / maand</td><td className="num text-right text-muted">{eur(realistic.perQualifiedEur)} per prospect</td></tr>
          <tr><td>Conservatief</td><td className="num text-right">{eur(conservative.weeklyEur)} / week</td><td className="num text-right">{eur(conservative.monthlyEur, 0)} / maand</td><td className="num text-right text-muted">{eur(conservative.perQualifiedEur)} per prospect</td></tr>
        </tbody></table>
        <p className="text-[12px] text-faint mt-1">Een run die zijn budget bereikt pauzeert zichzelf. Weekbudget ≥ conservatieve schatting voorkomt onderbrekingen.</p>
      </Step>

      <Step n={9} title="Wekelijkse planning" status={s.schedule.enabled && worker.alive ? "ok" : "warn"}>
        <form action={saveScheduleAction} className="flex flex-wrap gap-3 items-end">
          <label className="flex gap-2 items-center"><input type="checkbox" name="enabled" defaultChecked={s.schedule.enabled} /> Automatisch</label>
          <Field label="Dag"><select name="weekday" defaultValue={cronDow}>{["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"].map((d, i) => <option key={d} value={i}>{d}</option>)}</select></Field>
          <Field label="Tijd"><input name="time" type="time" defaultValue={`${cronH.padStart(2, "0")}:${cronM.padStart(2, "0")}`} /></Field>
          <Field label="Tijdzone"><input name="timezone" defaultValue={s.schedule.timezone} /></Field>
          <Field label="Doel per week"><input name="weeklyTarget" type="number" min={1} max={500} defaultValue={s.schedule.weeklyTarget} /></Field>
          <Button>Opslaan</Button>
        </form>
        <p className="text-[12px] text-faint mt-1">De worker past de planning binnen een minuut toe ({worker.schedule ?? "worker niet actief"}).</p>
      </Step>

      <Step n={10} title="Live pilots en eerste run" status={pilots.some((p) => p.status === "completed") ? "ok" : readyForLive ? "warn" : "todo"}>
        {!readyForLive && <p className="mb-3 text-warn">Nog niet gereed: vereist een gevalideerde Claude-sleutel, een goedgekeurde zoekprovider, een actieve worker en geslaagde verbindingstest.</p>}
        <div className="grid md:grid-cols-3 gap-3 mb-4">
          {(Object.entries(PILOT_PRESETS) as [keyof typeof PILOT_PRESETS, (typeof PILOT_PRESETS)[keyof typeof PILOT_PRESETS]][]).map(([key, p]) => (
            <form key={key} action={startPilotAction.bind(null, key)} className="border border-line rounded-md p-3 flex flex-col gap-2">
              <div className="font-medium">{p.label}</div>
              <div className="text-[12px] text-muted">{p.industries.join(", ")} · 300–5.000 FTE</div>
              <Field label="Maximaal budget (€)"><input name="budgetEur" type="number" min={1} max={200} defaultValue={15} /></Field>
              <label className="flex gap-2 items-start text-[12px]"><input type="checkbox" name="approved" required /> Ik keur betaalde research tot dit bedrag goed</label>
              <Button variant="primary" disabled={!readyForLive}>Start pilot</Button>
            </form>
          ))}
        </div>
        {pilots.length > 0 && (
          <table className="mb-4"><thead><tr><th>Pilot</th><th>Status</th><th>Gestart</th><th className="text-right">Kosten</th><th></th></tr></thead><tbody>
            {pilots.map((r) => <tr key={r.id}><td>{(r.params as { pilot?: string }).pilot}</td><td><Badge tone={tone(r.status)}>{label(r.status)}</Badge></td><td className="text-muted">{dt(r.createdAt)}</td><td className="num text-right">{eur(Number(r.costEur))}</td><td><Link className="text-accent" href={`/pilots?run=${r.id}`}>Metingen →</Link></td></tr>)}
          </tbody></table>
        )}
        <form action={startFirstRunAction} className="border-t border-line pt-3 flex flex-wrap items-end gap-3">
          <div className="font-medium w-full">Eerste volledige run ({s.schedule.weeklyTarget} prospects)</div>
          <Field label="Maximaal budget (€)"><input name="budgetEur" type="number" min={1} defaultValue={Math.ceil(conservative.weeklyEur)} /></Field>
          <label className="flex gap-2 items-center text-[12px]"><input type="checkbox" name="approved" required /> Ik keur betaalde research tot dit bedrag goed</label>
          <Button variant="primary" disabled={!readyForLive}>Start eerste onderzoeksrun</Button>
        </form>
      </Step>
    </>
  );
}
