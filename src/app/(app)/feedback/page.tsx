import { desc } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { requirePageUser } from "@/lib/auth/current";
import { FeedbackImporter } from "@/components/FeedbackImporter";
import { OUTCOME_LABELS } from "@/lib/feedbackImport";
import { PageHeader, Section, Badge, Empty, dt } from "@/components/ui";

export default async function Feedback() {
  const user = await requirePageUser("viewer");
  const imports = await getDb().select().from(schema.feedbackImports).orderBy(desc(schema.feedbackImports.createdAt)).limit(30);
  return (
    <>
      <PageHeader title="Belbureau-feedback" subtitle="Upload Excel of CSV van het belbureau. U ziet eerst een preview met kolomtoewijzing, validatie en duplicaatdetectie; pas na 'Vastleggen' wordt de historie bijgewerkt. Het sjabloon zit als tweede tabblad in elke Excel-export." />
      {user.role === "viewer" ? <Empty>Alleen-lezen: importeren vereist analist- of beheerdersrechten.</Empty> : (
        <Section title="Nieuwe import"><FeedbackImporter outcomeLabels={OUTCOME_LABELS} /></Section>
      )}
      <Section title="Toegestane statussen">
        <div className="flex flex-wrap gap-1">{Object.values(OUTCOME_LABELS).map((l) => <Badge key={l}>{l}</Badge>)}</div>
        <p className="text-[12px] text-faint mt-2">"Niet benaderen" leidt direct tot een permanente onderdrukking met minimale identificatiegegevens.</p>
      </Section>
      <Section title="Importhistorie">
        {imports.length === 0 ? <Empty>Nog geen imports.</Empty> : (
          <table><thead><tr><th>Bestand</th><th>Status</th><th className="text-right">Rijen</th><th className="text-right">Geldig</th><th className="text-right">Duplicaat</th><th>Fouten</th><th>Datum</th></tr></thead><tbody>
            {imports.map((i) => <tr key={i.id}><td>{i.fileName}</td><td><Badge tone={i.status === "committed" ? "ok" : "muted"}>{i.status}</Badge></td><td className="num text-right">{i.rowCount}</td><td className="num text-right">{i.validRows}</td><td className="num text-right">{i.duplicateRows}</td><td className="text-[12px] text-muted">{(i.errors ?? []).slice(0, 2).join("; ")}</td><td className="text-[12px] text-muted">{dt(i.createdAt)}</td></tr>)}
          </tbody></table>
        )}
      </Section>
    </>
  );
}
