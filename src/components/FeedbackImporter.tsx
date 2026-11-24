"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Mapping = { prospectId: string | null; companyName: string | null; outcome: string; date: string | null; notes: string | null; contactRole: string | null };
type Row = { line: number; companyName: string | null; prospectId: string | null; outcome: string | null; rawOutcome: string; calledAt: string | null; notes: string | null; errors: string[]; duplicate: boolean };
const FIELDS: [keyof Mapping, string][] = [["prospectId", "Prospect-ID"], ["companyName", "Bedrijfsnaam"], ["outcome", "Status *"], ["date", "Datum"], ["notes", "Notities"], ["contactRole", "Contactrol"]];

export function FeedbackImporter({ outcomeLabels }: { outcomeLabels: Record<string, string> }) {
  const router = useRouter();
  const [state, setState] = useState<{ importId: string; headers: string[]; mapping: Mapping; preview: Row[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/feedback", { method: "POST", body: new FormData(e.currentTarget) });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) return setMsg(j.error ?? "Upload mislukt");
    setState(j);
  }
  async function remap(m: Mapping) {
    if (!state) return;
    setState({ ...state, mapping: m });
    const r = await fetch(`/api/feedback/${state.importId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "remap", mapping: m }) });
    const j = await r.json();
    if (r.ok) setState((s) => (s ? { ...s, mapping: m, preview: j.preview } : s));
    else setMsg(j.error);
  }
  async function commit() {
    if (!state) return;
    setBusy(true);
    const r = await fetch(`/api/feedback/${state.importId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "commit" }) });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) return setMsg(j.error);
    setMsg(`${j.committed} resultaten vastgelegd. Historie is bewaard (eerdere uitkomsten zijn gemarkeerd als vervangen, niet overschreven).`);
    setState(null);
    router.refresh();
  }

  const valid = state?.preview.filter((p) => !p.errors.length && !p.duplicate).length ?? 0;
  return (
    <div>
      <form onSubmit={upload} className="flex gap-2 items-center mb-4">
        <input type="file" name="file" accept=".xlsx,.csv" required />
        <button disabled={busy} className="rounded-md border border-line-strong px-3 py-1.5 text-[13px] hover:bg-panel-2">Upload &amp; preview</button>
      </form>
      {msg && <div className="mb-4 text-[13px] border border-line rounded-md px-3 py-2">{msg}</div>}
      {state && (
        <>
          <div className="mb-3 text-[12px] uppercase tracking-wider text-muted">Kolomtoewijzing</div>
          <div className="flex flex-wrap gap-3 mb-4">
            {FIELDS.map(([k, l]) => (
              <label key={k} className="flex flex-col text-[12px] gap-1">
                <span className="text-muted">{l}</span>
                <select value={state.mapping[k] ?? ""} onChange={(e) => remap({ ...state.mapping, [k]: e.target.value || null } as Mapping)}>
                  <option value="">—</option>
                  {state.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="mb-2 text-[13px]">
            {state.preview.length} rijen · <span className="text-ok">{valid} geldig</span> · <span className="text-warn">{state.preview.filter((p) => p.duplicate).length} duplicaat</span> · <span className="text-bad">{state.preview.filter((p) => p.errors.length).length} fouten</span>
          </div>
          <div className="max-h-[420px] overflow-y-auto border border-line rounded-lg mb-3">
            <table>
              <thead><tr><th>Regel</th><th>Bedrijf</th><th>Ruwe status</th><th>Genormaliseerd</th><th>Datum</th><th>Notities</th><th>Validatie</th></tr></thead>
              <tbody>
                {state.preview.map((p) => (
                  <tr key={p.line}>
                    <td className="num text-faint">{p.line}</td>
                    <td>{p.companyName ?? "—"}<div className="text-[11px] text-faint">{p.prospectId}</div></td>
                    <td className="text-muted">{p.rawOutcome}</td>
                    <td>{p.outcome ? outcomeLabels[p.outcome] : "—"}</td>
                    <td className="text-[12px]">{p.calledAt ? new Date(p.calledAt).toLocaleDateString("nl-NL") : "—"}</td>
                    <td className="text-[12px] text-muted max-w-60 truncate">{p.notes}</td>
                    <td className="text-[12px]">{p.errors.length ? <span className="text-bad">{p.errors.join("; ")}</span> : p.duplicate ? <span className="text-warn">al geïmporteerd</span> : <span className="text-ok">ok</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button onClick={commit} disabled={busy || valid === 0} className="rounded-md bg-accent text-accent-ink px-4 py-1.5 font-medium disabled:opacity-40">Vastleggen ({valid})</button>
        </>
      )}
    </div>
  );
}
