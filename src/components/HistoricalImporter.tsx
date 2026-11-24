"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Mapping = Record<"name" | "website" | "email" | "phone" | "kvk" | "city" | "date" | "outcome" | "notes", string | null>;
type Row = { line: number; name: string; domain: string | null; phone: string | null; kvk: string | null; city: string | null; date: string | null; matchName: string | null; matchMethod: string | null; confidence: "certain" | "probable" | "new"; errors: string[] };
const FIELDS: [keyof Mapping, string][] = [["name", "Bedrijfsnaam *"], ["website", "Website"], ["email", "E-mail (domein)"], ["phone", "Telefoon"], ["kvk", "KvK"], ["city", "Plaats"], ["date", "Datum geleverd"], ["outcome", "Belstatus"], ["notes", "Notities"]];
const CONF: Record<Row["confidence"], [string, string]> = { certain: ["zeker", "text-ok"], probable: ["waarschijnlijk", "text-warn"], new: ["nieuw", "text-muted"] };

/** Import wizard for previous calling lists, customers, opportunities, rejected companies and opt-outs. */
export function HistoricalImporter({ kinds, defaultKind }: { kinds: Record<string, string>; defaultKind?: string }) {
  const router = useRouter();
  const [kind, setKind] = useState(defaultKind ?? Object.keys(kinds)[0]);
  const [state, setState] = useState<{ importId: string; headers: string[]; mapping: Mapping; preview: Row[] } | null>(null);
  const [acceptProbable, setAcceptProbable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const fd = new FormData(e.currentTarget);
    fd.set("kind", kind);
    const r = await fetch("/api/imports", { method: "POST", body: fd });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) return setMsg(j.error ?? "Upload mislukt");
    setState(j);
  }
  async function remap(m: Mapping) {
    if (!state) return;
    setState({ ...state, mapping: m });
    const r = await fetch(`/api/imports/${state.importId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "remap", mapping: m }) });
    const j = await r.json();
    if (r.ok) setState((s) => (s ? { ...s, preview: j.preview } : s));
    else setMsg(j.error);
  }
  async function commit() {
    if (!state) return;
    setBusy(true);
    const r = await fetch(`/api/imports/${state.importId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "commit", acceptProbable }) });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) return setMsg(j.error);
    setMsg(`Vastgelegd: ${j.linked} gekoppeld aan bestaande bedrijven, ${j.created} nieuw. Alle naamvarianten, (oude) domeinen en telefoonnummers worden voortaan herkend.`);
    setState(null);
    router.refresh();
  }
  const count = (c: Row["confidence"]) => state?.preview.filter((p) => p.confidence === c).length ?? 0;
  return (
    <div>
      <form onSubmit={upload} className="flex flex-wrap gap-2 items-center mb-3">
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="text-[12px]">{Object.entries(kinds).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input type="file" name="file" accept=".xlsx,.csv" required />
        <button disabled={busy} className="rounded-md border border-line-strong px-3 py-1.5 text-[13px] hover:bg-panel-2">Upload &amp; vergelijk</button>
      </form>
      {msg && <div className="mb-3 text-[13px] border border-line rounded-md px-3 py-2">{msg}</div>}
      {state && (
        <>
          <div className="flex flex-wrap gap-3 mb-3">
            {FIELDS.map(([k, l]) => (
              <label key={k} className="flex flex-col text-[12px] gap-1">
                <span className="text-muted">{l}</span>
                <select value={state.mapping[k] ?? ""} onChange={(e) => remap({ ...state.mapping, [k]: e.target.value || null })}>
                  <option value="">—</option>
                  {state.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="mb-2 text-[13px]">{state.preview.length} rijen · <span className="text-ok">{count("certain")} zeker gekoppeld</span> · <span className="text-warn">{count("probable")} waarschijnlijk (naam)</span> · {count("new")} nieuw</div>
          <div className="max-h-[380px] overflow-y-auto border border-line rounded-lg mb-3">
            <table>
              <thead><tr><th>Regel</th><th>Naam (import)</th><th>Domein</th><th>Telefoon</th><th>KvK</th><th>Koppeling</th><th>Methode</th></tr></thead>
              <tbody>
                {state.preview.map((p) => (
                  <tr key={p.line}>
                    <td className="num text-faint">{p.line}</td>
                    <td>{p.name}{p.errors.length > 0 && <div className="text-[11px] text-warn">{p.errors.join("; ")}</div>}</td>
                    <td className="text-[12px] text-muted">{p.domain ?? "—"}</td>
                    <td className="text-[12px] text-muted">{p.phone ?? "—"}</td>
                    <td className="text-[12px] text-muted">{p.kvk ?? "—"}</td>
                    <td className="text-[12px]"><span className={CONF[p.confidence][1]}>{CONF[p.confidence][0]}</span>{p.matchName ? ` → ${p.matchName}` : ""}</td>
                    <td className="text-[12px] text-muted">{p.matchMethod ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="flex items-center gap-2 text-[12px] mb-3"><input type="checkbox" checked={acceptProbable} onChange={(e) => setAcceptProbable(e.target.checked)} /> Koppel ook "waarschijnlijke" naamovereenkomsten (anders worden ze als nieuw bedrijf vastgelegd)</label>
          <button onClick={commit} disabled={busy} className="rounded-md bg-accent text-accent-ink px-4 py-1.5 font-medium disabled:opacity-40">Vastleggen</button>
        </>
      )}
    </div>
  );
}
