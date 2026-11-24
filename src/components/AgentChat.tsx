"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { sendChatAction } from "@/app/actions";

type Msg = { id: string; role: string; fromAgent: string | null; toAgent: string | null; content: string; createdAt: string };

export function AgentChat({ agentId, agentName, threadId, examples, names, canWrite }: { agentId: string; agentName: string; threadId: string; examples: string[]; names: Record<string, string>; canWrite: boolean }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [pending, setPending] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch(`/api/chat/${threadId}`, { cache: "no-store" });
        if (r.ok) {
          const j = await r.json();
          if (!stop) {
            setMessages(j.messages);
            setPending(j.pending);
          }
        }
      } catch {}
      if (!stop) setTimeout(poll, 2500);
    };
    poll();
    return () => {
      stop = true;
    };
  }, [threadId]);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight; // scroll the thread only, never the page
  }, [messages.length]);

  const send = (msg: string) => {
    if (!msg.trim()) return;
    setError(null);
    start(async () => {
      try {
        await sendChatAction(threadId, agentId, msg);
        setText("");
        setPending(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Verzenden mislukt");
      }
    });
  };

  return (
    <div className="flex flex-col h-[calc(100vh-220px)] min-h-[420px] border border-line rounded-lg bg-panel">
      <div className="px-4 py-2.5 border-b border-line text-[13px] flex items-center gap-2">
        <span className="font-medium">{agentName}</span>
        {pending && <span className="text-info text-[12px]">· aan het werk (echte uitvoering, kan minuten duren)</span>}
      </div>
      <div ref={scroller} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-muted text-[13px]">
            <p className="mb-2">Stel een vraag of geef een opdracht. Voorbeelden:</p>
            <div className="flex flex-col gap-1">
              {examples.map((e) => (
                <button key={e} disabled={!canWrite} onClick={() => send(e)} className="text-left text-accent hover:underline disabled:text-faint disabled:no-underline">{e}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "ml-auto max-w-[80%]" : "max-w-[92%]"}>
            <div className="text-[11px] text-faint mb-0.5">
              {m.role === "user" ? "U" : m.role === "delegation" ? `${names[m.fromAgent ?? ""] ?? m.fromAgent} → ${names[m.toAgent ?? ""] ?? m.toAgent} (delegatie)` : names[m.fromAgent ?? ""] ?? m.role}
              {" · "}
              {new Date(m.createdAt).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}
            </div>
            <div className={`whitespace-pre-wrap rounded-md px-3 py-2 text-[13px] ${m.role === "user" ? "bg-accent/15 border border-accent/30" : m.role === "delegation" ? "bg-panel-2 border border-line text-muted italic" : m.role === "system" ? "bg-bad/10 border border-bad/30 text-bad" : "bg-panel-2 border border-line"}`}>{m.content}</div>
          </div>
        ))}
      </div>
      <form
        className="border-t border-line p-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} className="flex-1 resize-none" placeholder={canWrite ? `Bericht aan ${agentName}…` : "Alleen-lezen"} disabled={!canWrite} maxLength={8000}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }} />
        <button disabled={!canWrite || isPending || !text.trim()} className="rounded-md bg-accent text-accent-ink px-4 font-medium disabled:opacity-40">Verstuur</button>
      </form>
      {error && <div className="px-3 pb-2 text-[12px] text-bad">{error}</div>}
    </div>
  );
}
