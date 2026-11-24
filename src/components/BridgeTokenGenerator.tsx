"use client";

import { useState, useTransition } from "react";

/** Shows a freshly generated bridge token exactly once (it is never stored in plain text). */
export function BridgeTokenGenerator({ action, configured }: { action: () => Promise<string>; configured: boolean }) {
  const [token, setToken] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button type="button" className="rounded-md border border-line-strong px-3 py-1.5 text-[13px]" disabled={pending} onClick={() => start(async () => setToken(await action()))}>
          {configured ? "Nieuw bridge-token genereren (vervangt het oude)" : "Bridge-token genereren"}
        </button>
        {pending && <span className="text-faint text-[12px]">Bezig…</span>}
      </div>
      {token && (
        <div className="border border-warn/30 bg-warn/10 rounded p-2 text-[12px]">
          <div className="mb-1">Eenmalig zichtbaar. Sla dit token op als <b>network secret</b> in de Claude Code-omgeving (niet in de repository, niet in de prompt):</div>
          <code className="block font-mono break-all select-all">{token}</code>
        </div>
      )}
    </div>
  );
}
