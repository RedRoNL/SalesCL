import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { runAgent } from "@/agents/runtime";
import type * as S from "@/agents/schemas";
import type { AgentId } from "@/agents/types";
import { buildCapabilities } from "./capabilities";
import { getQueue, JOBS } from "./queue";

export interface ChatJob {
  threadId: string;
  agentId: AgentId;
  userId: string;
  userRole: string;
}

/** Store a user message and enqueue the agent turn (processed by the worker). */
export async function postChatMessage(job: ChatJob & { message: string }) {
  await getDb().insert(schema.agentMessages).values({ threadId: job.threadId, toAgent: job.agentId, userId: job.userId, role: "user", content: job.message });
  await (await getQueue()).send(JOBS.chat, { threadId: job.threadId, agentId: job.agentId, userId: job.userId, userRole: job.userRole }, { retryLimit: 1 });
}

/** Execute one conversational turn: real agent execution with tools and delegation. */
export async function handleChat(job: ChatJob) {
  const db = getDb();
  const history = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.threadId, job.threadId)).orderBy(asc(schema.agentMessages.createdAt));
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  if (!lastUser) return;
  const prior = history.filter((m) => m.id !== lastUser.id && (m.role === "user" || (m.role === "agent" && m.fromAgent === job.agentId))).slice(-20);
  try {
    const r = await runAgent<typeof S.ChatOutput>(job.agentId, "chat", {
      message: lastUser.content,
      history: prior.map((m) => ({ role: m.role === "user" ? "gebruiker" : "agent", content: m.content.slice(0, 3000) })),
      userRole: job.userRole,
    }, { threadId: job.threadId, userId: job.userId, userRole: job.userRole, capabilities: buildCapabilities({ userId: job.userId, userRole: job.userRole, threadId: job.threadId }) });
    const out = r.output;
    const extra = [
      out.findings.length ? `\n\n**Bevindingen**\n${out.findings.map((f) => `- ${f.statement}${f.sourceId ? ` _(bron ${f.sourceId.slice(0, 8)})_` : ""}`).join("\n")}` : "",
      out.recommendations.length ? `\n\n**Aanbevelingen**\n${out.recommendations.map((x) => `- ${x}`).join("\n")}` : "",
    ].join("");
    await db.insert(schema.agentMessages).values({ threadId: job.threadId, fromAgent: job.agentId, role: "agent", content: out.reply + extra, taskId: r.taskId });
  } catch (e) {
    await db.insert(schema.agentMessages).values({ threadId: job.threadId, fromAgent: job.agentId, role: "system", content: `Taak mislukt: ${e instanceof Error ? e.message : String(e)}` });
  }
}
