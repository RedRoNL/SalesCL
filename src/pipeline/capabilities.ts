import { getDb, schema } from "@/db/client";
import { commercialPerformance, marketMap } from "@/lib/analytics";
import { runAgent, type RunAgentOptions } from "@/agents/runtime";
import type { AgentId } from "@/agents/types";
import { buildDossier } from "./dossier";
import { runStatusSummary, startRunFromAgent } from "./runs";

/** Read-only and delegation capabilities wired into agent tool contexts. */
export function buildCapabilities(opts: { userId?: string | null; userRole?: string | null; threadId?: string | null; parentTaskId?: string | null } = {}): RunAgentOptions["capabilities"] {
  return {
    analytics: () => commercialPerformance(),
    marketMap: () => marketMap(),
    dossier: (id, forQa) => buildDossier(id, forQa),
    runStatus: (runId) => runStatusSummary(runId),
    startRun: startRunFromAgent(opts.userId ?? null),
    delegate: async (agentId: AgentId, instruction: string) => {
      const db = getDb();
      if (opts.threadId)
        await db.insert(schema.agentMessages).values({ threadId: opts.threadId, fromAgent: "chief_sales_officer", toAgent: agentId, role: "delegation", content: instruction });
      const r = await runAgent(agentId, "chat", { message: instruction, history: [], userRole: opts.userRole ?? "viewer" }, {
        depth: 1, threadId: opts.threadId, userId: opts.userId, userRole: opts.userRole, parentTaskId: opts.parentTaskId,
        capabilities: { analytics: () => commercialPerformance(), marketMap: () => marketMap(), dossier: (id, f) => buildDossier(id, f), runStatus: (r) => runStatusSummary(r) },
      });
      const out = r.output as { reply: string; findings: { statement: string; sourceId: string | null }[] };
      if (opts.threadId)
        await db.insert(schema.agentMessages).values({ threadId: opts.threadId, fromAgent: agentId, toAgent: "chief_sales_officer", role: "agent", content: out.reply, taskId: r.taskId });
      return JSON.stringify({ agent: agentId, reply: out.reply, findings: out.findings });
    },
  };
}
