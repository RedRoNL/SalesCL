/**
 * army — the Claude Code session's command-line client for the Sales Army research bridge.
 *
 *   npx tsx scripts/army.ts start [--run <id>] [--kind weekly|manual|pilot] [--preset manufacturing|logistics|operational] [--target N] [--session-url URL] [--payload-file F]
 *   npx tsx scripts/army.ts pump [--ms 60000]
 *   npx tsx scripts/army.ts tasks [--run <id>] [--limit 5] [--agent <agentId>]
 *   npx tsx scripts/army.ts spec <taskId>
 *   npx tsx scripts/army.ts tool <taskId> <toolName> '<json args>'   (or --args-file F)
 *   npx tsx scripts/army.ts submit <taskId> <output.json>            (or '-' for stdin)
 *   npx tsx scripts/army.ts fail <taskId> "<reason>"
 *   npx tsx scripts/army.ts status [--run <id>]
 *
 * Transport: HTTPS to $SALES_ARMY_URL/api/bridge/<action>. In a Claude Code cloud environment the
 * bridge token is a *network secret* for that host: the egress proxy injects the Authorization header,
 * so the token never appears in the session. Locally, SALES_ARMY_BRIDGE_TOKEN may be set instead.
 * `--direct` (or no SALES_ARMY_URL but a DATABASE_URL, e.g. from a git-ignored .env.local) calls the bridge
 * in-process against the database (local development / pilots).
 * Output is always JSON on stdout.
 */
import { readFileSync } from "node:fs";

// Local development: optional, git-ignored .env.local (never used for the bridge token in the cloud).
try {
  process.loadEnvFile(".env.local");
} catch {
  /* not present */
}
const argv = process.argv.slice(2);
// In-process mode when explicitly requested, or locally when no bridge URL is configured but a database is.
const direct = argv.includes("--direct") || (!process.env.SALES_ARMY_URL && Boolean(process.env.DATABASE_URL));
const args = argv.filter((a) => a !== "--direct");
const cmd = args[0];
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));
const readJson = (src: string) => JSON.parse(src === "-" ? readFileSync(0, "utf8") : src.trim().startsWith("{") || src.trim().startsWith("[") ? src : readFileSync(src, "utf8"));
const num = (v?: string) => (v ? Number(v) : undefined);

function body(): { action: string; payload: Record<string, unknown> } {
  switch (cmd) {
    case "start":
      return { action: "start", payload: { runId: flag("run"), kind: flag("kind"), preset: flag("preset"), target: num(flag("target")), sessionUrl: flag("session-url") ?? sessionUrlFromEnv(), payload: flag("payload-file") ? readFileSync(flag("payload-file")!, "utf8").slice(0, 65536) : flag("payload") } };
    case "pump":
      return { action: "pump", payload: { maxMs: num(flag("ms")) } };
    case "tasks":
      return { action: "tasks", payload: { runId: flag("run"), limit: num(flag("limit")), agentId: flag("agent") } };
    case "spec":
      return { action: "spec", payload: { taskId: positional[0] } };
    case "tool":
      return { action: "tool", payload: { taskId: positional[0], tool: positional[1], args: flag("args-file") ? readJson(flag("args-file")!) : readJson(positional[2] ?? "{}") } };
    case "submit":
      return { action: "submit", payload: { taskId: positional[0], output: readJson(positional[1] ?? "-") } };
    case "fail":
      return { action: "fail", payload: { taskId: positional[0], reason: positional.slice(1).join(" ") } };
    case "status":
      return { action: "status", payload: { runId: flag("run") } };
    default:
      console.error("Gebruik: army <start|pump|tasks|spec|tool|submit|fail|status> … (zie scripts/army.ts)");
      process.exit(2);
  }
}

function sessionUrlFromEnv() {
  const id = process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
  return id && /^[A-Za-z0-9_-]+$/.test(id) ? `https://claude.ai/code/${id}` : undefined;
}

const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

async function viaHttp(action: string, payload: Record<string, unknown>) {
  const base = process.env.SALES_ARMY_URL;
  if (!base || !/^https?:\/\//.test(base)) throw new Error("SALES_ARMY_URL ontbreekt (bijv. https://sales.cloudlife.example)");
  // Placeholder is replaced by the environment's network secret; a locally set token is used as-is.
  const token = process.env.SALES_ARMY_BRIDGE_TOKEN || "injected-by-network-secret";
  const res = await fetch(new URL(`/api/bridge/${action}`, base), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(clean(payload)), signal: AbortSignal.timeout(130000) });
  const out = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw Object.assign(new Error((out as { error?: string }).error ?? `HTTP ${res.status}`), { details: out });
  return out;
}

async function viaDirect(action: string, payload: Record<string, unknown>) {
  const s = await import("../src/bridge/service");
  const p = clean(payload) as never as Record<string, string & number & undefined>;
  switch (action) {
    case "start": return s.bridgeStart(p);
    case "pump": return s.bridgePump(p);
    case "tasks": return s.bridgeTasks(p);
    case "spec": return s.bridgeSpec(p.taskId);
    case "tool": return { result: await s.bridgeTool(p.taskId, p.tool, (payload as { args: unknown }).args) };
    case "submit": return s.bridgeSubmit(p.taskId, (payload as { output: unknown }).output);
    case "fail": return s.bridgeFail(p.taskId, p.reason);
    case "status": return s.bridgeStatus(p.runId);
  }
}

async function main() {
  const { action, payload } = body();
  const out = direct ? await viaDirect(action, payload) : await viaHttp(action, payload);
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  if (direct) process.exit(0); // close DB/pg-boss handles
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ error: e instanceof Error ? e.message : String(e), details: (e as { details?: unknown }).details }, null, 2) + "\n");
  process.exit(1);
});
