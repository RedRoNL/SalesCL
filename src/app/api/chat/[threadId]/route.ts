import { asc, eq, and, inArray } from "drizzle-orm";
import { z } from "zod";
import { apiRoute } from "@/lib/api";
import { getDb, schema } from "@/db/client";

/** Poll a HQ conversation thread: messages + whether agents are still executing. */
export const GET = apiRoute<{ threadId: string }>({ role: "viewer", limit: 120 }, async ({ params }) => {
  const threadId = z.string().uuid().parse(params.threadId);
  const db = getDb();
  const messages = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.threadId, threadId)).orderBy(asc(schema.agentMessages.createdAt));
  const taskIds = messages.map((m) => m.taskId).filter(Boolean) as string[];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const answered = lastUser ? messages.some((m) => m.createdAt > lastUser.createdAt && (m.role === "agent" || m.role === "system") && (m.toAgent === null || m.toAgent === undefined) && m.fromAgent === lastUser.toAgent) : true;
  const running = taskIds.length ? await db.select({ id: schema.agentTasks.id }).from(schema.agentTasks).where(and(inArray(schema.agentTasks.id, taskIds), eq(schema.agentTasks.status, "running"))) : [];
  return {
    messages: messages.map((m) => ({ id: m.id, role: m.role, fromAgent: m.fromAgent, toAgent: m.toAgent, content: m.content, createdAt: m.createdAt })),
    pending: !answered || running.length > 0,
  };
});
