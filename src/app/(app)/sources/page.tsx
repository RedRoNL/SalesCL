import { requirePageUser } from "@/lib/auth/current";
import { getDb, schema } from "@/db/client";
import { sourceStats } from "@/discovery/sources";
import { addSourceAction, setSourceStatusAction } from "@/app/actions";
import { PageHeader, Section, Badge, Bar, Button, Field, dd } from "@/components/ui";
import { SOURCE_TYPES } from "@/agents/schemas";

const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "muted" | "accent"> = { active: "ok", unverified: "accent", exhausted: "muted", blocked: "bad", retired: "muted" };

export default async function Sources() {
  const user = await requirePageUser("viewer");
  const stats = (await sourceStats()).sort((a, b) => b.qualified - a.qualified || b.priority - a.priority || b.uniqueNew - a.uniqueNew);
  const industries = (await getDb().select().from(schema.industries)).filter((i) => i.priorityTier > 0);
  const harvested = stats.filter((s) => s.harvestCount > 0);
  const totals = { sources: stats.length, active: stats.filter((s) => s.status === "active").length, unique: harvested.reduce((a, s) => a + s.uniqueNew, 0), qualified: harvested.reduce((a, s) => a + s.qualified, 0) };
  return (
    <>
      <PageHeader title="Ontdekkingsbronnen" subtitle={`Permanente bronnendatabase: ${totals.sources} bronnen (${totals.active} actief), ${totals.unique} unieke bedrijven ontdekt, ${totals.qualified} daarvan gekwalificeerd. Prioriteit = rendement aan unieke én gekwalificeerde bedrijven, gewogen naar nieuwheid; een deel van de capaciteit gaat altijd naar nieuwe bronnen (exploratie).`} />
      {user.role === "admin" && (
        <Section title="Bron toevoegen">
          <form action={addSourceAction} className="flex flex-wrap gap-2 items-end">
            <Field label="Naam"><input name="name" required /></Field>
            <Field label="Type"><select name="sourceType">{SOURCE_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="URL van een lijstpagina, of zoekopdracht met {sector}"><input name="target" required className="w-96" placeholder="https://… of: exposantenlijst {sector} beurs 2026" /></Field>
            <Field label="Sectoren (leeg = alle)"><select name="industries" multiple size={3}>{industries.map((i) => <option key={i.code} value={i.code}>{i.nameNl}</option>)}</select></Field>
            <Button>Toevoegen</Button>
          </form>
        </Section>
      )}
      <div className="overflow-x-auto border border-line rounded-lg">
        <table>
          <thead><tr><th>Bron</th><th>Type</th><th>Sectoren</th><th>Status</th><th className="text-right">Oogsten</th><th className="text-right">Gevonden</th><th className="text-right">Uniek</th><th className="text-right">Gekwal.</th><th className="text-right">Afspr.</th><th className="w-28">Prioriteit</th><th>Laatst</th><th></th></tr></thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.id}>
                <td><div className="font-medium">{s.name}</div><div className="text-[11px] text-faint truncate max-w-80">{s.url ?? s.query}</div></td>
                <td className="text-[12px]">{s.sourceType}<div className="text-faint">{s.kind} · {s.origin}</div></td>
                <td className="text-[12px] text-muted max-w-40">{s.industryCodes.join(", ") || "alle"}</td>
                <td><Badge tone={STATUS_TONE[s.status] ?? "muted"}>{s.status}</Badge></td>
                <td className="num text-right">{s.harvestCount}</td><td className="num text-right">{s.found}</td><td className="num text-right">{s.uniqueNew}</td>
                <td className="num text-right font-medium">{s.qualified}</td><td className="num text-right">{s.appointments}</td>
                <td><div className="flex items-center gap-1"><Bar value={s.priority} /><span className="num text-[11px] w-6 text-right">{s.priority}</span></div></td>
                <td className="text-[12px] text-muted">{dd(s.lastHarvestedAt)}</td>
                <td>{user.role === "admin" && (s.status === "retired" || s.status === "blocked" || s.status === "exhausted"
                  ? <form action={setSourceStatusAction.bind(null, s.id, "unverified")}><Button variant="ghost">Heractiveer</Button></form>
                  : <form action={setSourceStatusAction.bind(null, s.id, "retired")}><Button variant="ghost">Stop</Button></form>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
