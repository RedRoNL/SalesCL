import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { desc } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { requirePageUser } from "@/lib/auth/current";
import { getSettings, type SettingsKey } from "@/lib/settings";
import { integrationStatus } from "@/lib/env";
import { AGENT_LIST } from "@/agents/definitions";
import { MODEL_PRICING_USD } from "@/lib/costs";
import {
  updateSettingsAction, addExclusionAction, toggleExclusionAction, addSuppressionAction, createScoringVersionAction,
  setUserRoleAction, setIndustryTierAction, importRelationshipsAction,
} from "@/app/actions";
import { PageHeader, Section, Badge, Button, Field, dt } from "@/components/ui";

const SETTING_SECTIONS: [SettingsKey, string, string][] = [
  ["icp", "Ideaal klantprofiel & omvangprioriteiten", "Banden, minimum/maximum en uitgesloten categorieën."],
  ["schedule", "Onderzoeksplanning", "Cron in de opgegeven tijdzone; standaard maandag 08:00 Europe/Amsterdam. De worker synchroniseert elke 5 minuten."],
  ["models", "AI-modelconfiguratie", "Goedkopere modellen voor volumewerk, sterkere modellen voor kwalificatie en QA. Per-agent override mogelijk."],
  ["research", "Onderzoeksproviders", "Zoek-, ophaal-, DNS- en registerprovider, hergebruiktermijn, cache en beleefdheidsvertraging."],
  ["budget", "Budgetlimieten & betaalde providers", "Betaalde providers moeten expliciet in approvedPaidProviders staan."],
  ["eligibility", "Contactgeschiktheid (telemarketing)", "Rechtsvormen die B2B gebeld mogen worden zonder toestemming. Laat juridisch valideren."],
  ["learning", "Zelflerend gedrag", "Grenzen voor automatische aanpassingen. Harde uitsluitingen en juridische regels vereisen altijd menselijke goedkeuring."],
  ["retention", "Dataretentie", "Bewaartermijnen voor contactgegevens, bronfragmenten, afgewezen bedrijven en auditlog."],
  ["agentSkills", "Skillbeheer per agent", "agentId → lijst met skillnamen. Leeg = standaard uit de agentdefinitie."],
];

function skillsInstalled() {
  const dir = path.join(process.cwd(), ".claude", "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((name) => {
    const origin = existsSync(path.join(dir, name, "ORIGIN.json")) ? JSON.parse(readFileSync(path.join(dir, name, "ORIGIN.json"), "utf8")) : {};
    return { name, ...origin } as { name: string; source?: string; version?: string; license?: string; commit?: string };
  });
}

export default async function Settings() {
  const user = await requirePageUser("viewer");
  const isAdmin = user.role === "admin";
  const settings = await getSettings();
  const integ = integrationStatus();
  const db = getDb();
  const [exclusions, suppressionsCount, scoring, users, industries, audit] = await Promise.all([
    db.select().from(schema.exclusions).orderBy(desc(schema.exclusions.createdAt)),
    db.select().from(schema.suppressions).then((r) => r.length),
    db.select().from(schema.scoringConfigs).orderBy(desc(schema.scoringConfigs.version)),
    isAdmin ? db.select().from(schema.users).orderBy(schema.users.email) : Promise.resolve([]),
    db.select().from(schema.industries).orderBy(schema.industries.priorityTier),
    isAdmin ? db.select().from(schema.auditLogs).orderBy(desc(schema.auditLogs.createdAt)).limit(40) : Promise.resolve([]),
  ]);
  const active = scoring.find((s) => s.active);
  const skills = skillsInstalled();
  const assigned = (skill: string) => AGENT_LIST.filter((a) => (settings.agentSkills[a.id] ?? a.skills).includes(skill)).map((a) => a.nameNl);

  return (
    <>
      <PageHeader title="Instellingen" subtitle={isAdmin ? "Wijzigingen worden gevalideerd, geversioneerd waar relevant en vastgelegd in de auditlog." : "Alleen-lezen. Wijzigen vereist beheerdersrechten."} />

      <Section title="Integraties & API-sleutels">
        <p className="text-[12px] text-muted mb-2">Sleutels worden uitsluitend server-side uit de omgeving (secret manager) gelezen en nooit naar de browser gestuurd. Hier ziet u alleen of ze aanwezig zijn.</p>
        <div className="flex flex-wrap gap-2">
          {Object.entries({ "Claude API (ANTHROPIC_API_KEY)": integ.anthropic, "Firecrawl (FIRECRAWL_API_KEY)": integ.firecrawl, "KvK API (KVK_API_KEY)": integ.kvk, "Microsoft Entra ID": integ.entra, "SESSION_SECRET": integ.sessionSecret }).map(([k, v]) => (
            <Badge key={k} tone={v ? "ok" : "warn"}>{v ? "✓" : "✕"} {k}</Badge>
          ))}
        </div>
      </Section>

      <div className="grid xl:grid-cols-2 gap-x-8">
        {SETTING_SECTIONS.map(([key, title, hint]) => (
          <Section key={key} title={title}>
            <p className="text-[12px] text-faint mb-2">{hint}</p>
            <form action={updateSettingsAction.bind(null, key)} className="flex flex-col gap-2">
              <textarea name="json" rows={Math.min(16, JSON.stringify(settings[key], null, 2).split("\n").length + 1)} defaultValue={JSON.stringify(settings[key], null, 2)} className="font-mono text-[12px]" readOnly={!isAdmin} spellCheck={false} />
              {isAdmin && <div><Button>Opslaan</Button></div>}
            </form>
            {key === "models" && <p className="text-[11px] text-faint mt-1">Prijzen (USD/1M tokens in/out): {Object.entries(MODEL_PRICING_USD).map(([m, p]) => `${m} ${p.input}/${p.output}`).join(" · ")}</p>}
          </Section>
        ))}
      </div>

      <Section title="Sectorprioriteiten">
        <table><thead><tr><th>Sector</th><th>NIS2 (indicatief)</th><th>DORA</th><th>Tier</th></tr></thead><tbody>
          {industries.map((i) => (
            <tr key={i.id}>
              <td>{i.nameNl}</td><td className="text-muted">{i.nis2Sector ?? "—"}</td><td>{i.doraApplicable ? "ja" : "—"}</td>
              <td>{i.priorityTier === 0 ? <Badge tone="bad">Uitgesloten</Badge> : isAdmin ? (
                <form action={setIndustryTierAction.bind(null, i.id)} className="flex gap-1">
                  <select name="tier" defaultValue={i.priorityTier} className="text-[12px]">{[1, 2, 3, 4].map((t) => <option key={t} value={t}>T{t}</option>)}</select>
                  <Button variant="ghost">✓</Button>
                </form>
              ) : `T${i.priorityTier}`}</td>
            </tr>
          ))}
        </tbody></table>
      </Section>

      <Section title={`Scoremodel (actief: v${active?.version ?? "—"})`}>
        <p className="text-[12px] text-faint mb-2">Het initiële model is een hypothese. Een nieuwe versie wordt actief; eerdere versies en historische scores blijven bewaard.</p>
        {active && (
          <form action={createScoringVersionAction} className="grid xl:grid-cols-3 gap-3">
            <Field label="Gewichten"><textarea name="weights" rows={8} className="font-mono text-[12px]" defaultValue={JSON.stringify(active.weights, null, 2)} readOnly={!isAdmin} /></Field>
            <Field label="Drempels"><textarea name="thresholds" rows={8} className="font-mono text-[12px]" defaultValue={JSON.stringify(active.thresholds, null, 2)} readOnly={!isAdmin} /></Field>
            <Field label="Regels"><textarea name="rules" rows={8} className="font-mono text-[12px]" defaultValue={JSON.stringify(active.rules, null, 2)} readOnly={!isAdmin} /></Field>
            {isAdmin && <div className="flex gap-2 items-center xl:col-span-3"><input name="notes" placeholder="Toelichting op wijziging" className="flex-1" /><Button>Nieuwe versie activeren</Button></div>}
          </form>
        )}
        <div className="text-[12px] text-muted mt-2">Versies: {scoring.map((s) => `v${s.version}${s.active ? " (actief)" : ""} ${dt(s.createdAt)}`).join(" · ")}</div>
      </Section>

      <Section title={`Uitsluitingen (${exclusions.filter((e) => e.active).length} actief) · ${suppressionsCount} permanente onderdrukkingen`}>
        {isAdmin && (
          <form action={addExclusionAction} className="flex flex-wrap gap-2 mb-3">
            <select name="scope" className="text-[12px]"><option value="name">Bedrijfsnaam</option><option value="domain">Domein</option><option value="parent_company">Moederbedrijf</option><option value="legal_entity">Juridische entiteit / KvK</option><option value="sector">Sector</option></select>
            <input name="value" placeholder="Waarde" required className="text-[12px]" />
            <select name="category" className="text-[12px]"><option value="manual">Handmatig</option><option value="competitor">Concurrent</option><option value="msp">MSP</option><option value="agency">Bureau</option><option value="customer">Klant</option><option value="opportunity">Opportunity</option><option value="rejected">Afgewezen</option></select>
            <input name="reason" placeholder="Reden" required className="text-[12px] flex-1" />
            <Button>Toevoegen</Button>
          </form>
        )}
        {user.role !== "viewer" && (
          <form action={addSuppressionAction} className="flex flex-wrap gap-2 mb-3">
            <select name="identifierType" className="text-[12px]"><option value="domain">Domein</option><option value="kvk">KvK</option><option value="name">Naam</option><option value="phone">Telefoon</option></select>
            <input name="identifierValue" placeholder="Opt-out registreren (permanent, niet terug te draaien)" required className="text-[12px] flex-1" />
            <Button variant="danger">Opt-out vastleggen</Button>
          </form>
        )}
        <table><thead><tr><th>Scope</th><th>Waarde</th><th>Categorie</th><th>Reden</th><th>Status</th><th></th></tr></thead><tbody>
          {exclusions.map((e) => (
            <tr key={e.id} className={e.active ? "" : "opacity-50"}>
              <td>{e.scope}</td><td>{e.value}</td><td>{e.category}{e.permanent && <Badge tone="bad">permanent</Badge>}</td><td className="text-[12px] text-muted">{e.reason}</td><td>{e.active ? "actief" : "inactief"}</td>
              <td>{isAdmin && !e.permanent && <form action={toggleExclusionAction.bind(null, e.id, !e.active)}><Button variant="ghost">{e.active ? "Deactiveer" : "Activeer"}</Button></form>}</td>
            </tr>
          ))}
        </tbody></table>
      </Section>

      {isAdmin && (
        <Section title="Bestaande relaties importeren">
          <p className="text-[12px] text-faint mb-2">CSV/XLSX met kolommen als Bedrijfsnaam, Website, KvK. Deze bedrijven komen nooit in nieuwe acquisitielijsten tenzij expliciet gereactiveerd.</p>
          <form action={importRelationshipsAction} className="flex gap-2 items-center">
            <select name="kind" className="text-[12px]"><option value="customer">Bestaande klanten</option><option value="active_opportunity">Actieve opportunities</option><option value="prior_prospect">Historische prospectlijsten</option><option value="rejected">Eerder afgewezen</option></select>
            <input type="file" name="file" accept=".csv,.xlsx" required />
            <Button>Importeren</Button>
          </form>
        </Section>
      )}

      <Section title="Geïnstalleerde skills">
        <table><thead><tr><th>Skill</th><th>Herkomst</th><th>Versie</th><th>Licentie</th><th>Toegewezen aan</th></tr></thead><tbody>
          {skills.map((s) => <tr key={s.name}><td className="font-mono text-[12px]">{s.name}</td><td className="text-[12px] text-muted">{s.source}{s.commit ? ` @ ${s.commit.slice(0, 7)}` : ""}</td><td className="text-[12px]">{s.version}</td><td className="text-[12px]">{s.license}</td><td className="text-[12px] text-muted">{assigned(s.name).join(", ") || "— (ontwikkelomgeving)"}</td></tr>)}
        </tbody></table>
      </Section>

      {isAdmin && (
        <Section title="Gebruikers & rechten">
          <table><thead><tr><th>E-mail</th><th>Naam</th><th>Laatst ingelogd</th><th>Rol / actief</th></tr></thead><tbody>
            {users.map((u) => (
              <tr key={u.id}><td>{u.email}</td><td>{u.name ?? "—"}</td><td className="text-[12px] text-muted">{dt(u.lastLoginAt)}</td>
                <td><form action={setUserRoleAction.bind(null, u.id)} className="flex gap-2 items-center">
                  <select name="role" defaultValue={u.role} className="text-[12px]"><option value="admin">Beheerder</option><option value="analyst">Analist</option><option value="viewer">Alleen-lezen</option></select>
                  <label className="text-[12px] flex gap-1 items-center"><input type="checkbox" name="active" defaultChecked={u.active} /> actief</label>
                  <Button variant="ghost">✓</Button>
                </form></td></tr>
            ))}
          </tbody></table>
          <p className="text-[11px] text-faint mt-1">Rollen worden bij elke Entra-login gesynchroniseerd vanuit app-rollen/groepen (zie DEPLOYMENT.md).</p>
        </Section>
      )}

      {isAdmin && (
        <Section title="Auditlog (recent)">
          <table><thead><tr><th>Tijd</th><th>Actor</th><th>Actie</th><th>Object</th></tr></thead><tbody>
            {audit.map((a) => <tr key={a.id}><td className="text-[12px] text-muted">{dt(a.createdAt)}</td><td className="text-[12px]">{a.actorType}:{a.actorId?.slice(0, 18)}</td><td className="text-[12px]">{a.action}</td><td className="text-[12px] text-muted">{a.entityType} {a.entityId?.slice(0, 8)}</td></tr>)}
          </tbody></table>
        </Section>
      )}
    </>
  );
}
