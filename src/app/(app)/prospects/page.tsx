import Link from "next/link";
import { getDb, schema } from "@/db/client";
import { searchProspects, type ProspectFilters } from "@/lib/queries";
import { PageHeader, Badge, Empty, nf, dd } from "@/components/ui";
import { label, tone, TECH_LABELS, SIGNAL_LABELS } from "@/lib/labels";
import { SERVICE_LABELS, SERVICES } from "@/domain/services";
import { OUTCOME_LABELS, OUTCOMES } from "@/lib/feedbackImport";
import { AGENT_LIST } from "@/agents/definitions";
import { formatProspectId } from "@/domain/normalize";

const MS = ["Tegengesproken", "Onbekend", "Zwak", "Sterk", "Bevestigd"];

export default async function Prospects({ searchParams }: { searchParams: Promise<ProspectFilters> }) {
  const f = await searchParams;
  const { rows, total, page, pageSize } = await searchProspects(f);
  const industries = await getDb().select().from(schema.industries);
  const qs = (extra: Record<string, string>) => "?" + new URLSearchParams({ ...(f as Record<string, string>), ...extra }).toString();
  const sel = (name: keyof ProspectFilters, opts: [string, string][], placeholder: string) => (
    <select name={name} defaultValue={f[name] ?? ""} className="text-[12px]">
      <option value="">{placeholder}</option>
      {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
  return (
    <>
      <PageHeader title="Prospectdatabase" subtitle={`${nf(total)} organisaties in het permanente geheugen van het Sales Army.`} />
      <form className="flex flex-wrap gap-2 mb-4 items-end" method="get">
        <input name="q" defaultValue={f.q ?? ""} placeholder="Naam, domein of CLSA-ID" className="w-56 text-[12px]" />
        {sel("industry", industries.map((i) => [i.code, i.nameNl]), "Alle sectoren")}
        {sel("size", [["50-299", "50–299"], ["300-1999", "300–1.999"], ["2000-5000", "2.000–5.000"], ["unknown", "Onbekend"]], "Alle omvang")}
        <input name="location" defaultValue={f.location ?? ""} placeholder="Plaats/provincie" className="w-32 text-[12px]" />
        <input name="minFit" defaultValue={f.minFit ?? ""} placeholder="Min. fit" className="w-20 text-[12px]" inputMode="numeric" />
        <input name="minConfidence" defaultValue={f.minConfidence ?? ""} placeholder="Min. betrouwb." className="w-28 text-[12px]" inputMode="numeric" />
        {sel("tech", Object.entries(TECH_LABELS), "Microsoft-technologie")}
        {sel("techClass", [["confirmed", "Bevestigd"], ["strongly_indicated", "Sterk"], ["weakly_indicated", "Zwak"], ["contradicted", "Tegengesproken"]], "Elke classificatie")}
        {sel("signal", Object.entries(SIGNAL_LABELS), "Koopsignaal")}
        {sel("service", SERVICES.map((s) => [s, SERVICE_LABELS[s]]), "Aanbevolen dienst")}
        {sel("calling", OUTCOMES.map((o) => [o, OUTCOME_LABELS[o]]), "Belstatus")}
        {sel("status", ["candidate", "researching", "researched", "qualified", "needs_research", "rejected", "approved", "exported", "excluded"].map((s) => [s, label(s)]), "Kwalificatiestatus")}
        <input name="researchedSince" type="date" defaultValue={f.researchedSince ?? ""} className="text-[12px]" title="Onderzocht sinds" />
        {sel("exported", [["yes", "Geleverd"], ["no", "Niet geleverd"]], "Exporthistorie")}
        <input name="parent" defaultValue={f.parent ?? ""} placeholder="Moederbedrijf" className="w-32 text-[12px]" />
        {sel("agent", AGENT_LIST.map((a) => [a.id, a.nameNl]), "Toegewezen agent")}
        <button className="rounded-md border border-line-strong px-3 py-1 text-[12px] hover:bg-panel-2">Filter</button>
        <Link href="/prospects" className="text-[12px] text-muted px-2 py-1">Wissen</Link>
      </form>
      {rows.length === 0 ? <Empty>Geen organisaties gevonden voor deze filters.</Empty> : (
        <div className="overflow-x-auto border border-line rounded-lg">
          <table>
            <thead>
              <tr><th>ID</th><th>Organisatie</th><th>Sector</th><th className="text-right">Mdw.</th><th>Plaats</th><th className="text-right">Fit</th><th className="text-right">Betr.</th><th>M365</th><th className="text-right">Sign.</th><th>Dienst</th><th>Status</th><th>Belstatus</th><th>Onderzocht</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.id)}>
                  <td className="num text-faint text-[12px]">{formatProspectId(Number(r.prospectNumber))}</td>
                  <td><Link href={`/prospects/${r.id}`} className="hover:text-accent font-medium">{String(r.name)}</Link><div className="text-[11px] text-faint">{String(r.domain ?? "")}{r.group ? ` · ${r.group}` : ""}</div></td>
                  <td className="text-muted">{String(r.industry ?? "—")}</td>
                  <td className="num text-right">{String(r.employees ?? "—")}</td>
                  <td className="text-muted">{String(r.city ?? "—")}</td>
                  <td className="num text-right font-medium">{r.fit != null ? String(r.fit) : "—"}</td>
                  <td className="num text-right text-muted">{r.confidence != null ? String(r.confidence) : "—"}</td>
                  <td className="text-[12px]">{r.msLevel != null ? MS[Number(r.msLevel) + 1] : "—"}</td>
                  <td className="num text-right">{String(r.signals)}</td>
                  <td className="text-[12px] text-muted">{r.service ? SERVICE_LABELS[r.service as keyof typeof SERVICE_LABELS] ?? String(r.service) : "—"}</td>
                  <td><Badge tone={tone(String(r.status))}>{label(String(r.status))}</Badge></td>
                  <td className="text-[12px]">{r.calling ? OUTCOME_LABELS[r.calling as keyof typeof OUTCOME_LABELS] : "—"}</td>
                  <td className="text-[12px] text-muted">{dd(r.researchedAt as string)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex gap-3 mt-3 text-[12px] text-muted">
        {page > 1 && <Link href={qs({ page: String(page - 1) })} className="text-accent">← Vorige</Link>}
        <span>Pagina {page} van {Math.max(1, Math.ceil(total / pageSize))}</span>
        {page * pageSize < total && <Link href={qs({ page: String(page + 1) })} className="text-accent">Volgende →</Link>}
      </div>
    </>
  );
}
