import type Anthropic from "@anthropic-ai/sdk";
import { eq, sql, desc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db/client";
import { getSettings, type Settings } from "@/lib/settings";
import { modelCostEur } from "@/lib/costs";
import { assertWithinBudget } from "@/lib/budget";
import { audit } from "@/lib/audit";
import { ResearchService } from "@/research/service";
import { getAgent } from "./definitions";
import { CLOUD_LIFE_PROFILE, icpText, SECURITY_RULES } from "./knowledge";
import { loadSkill } from "./skills";
import { getModelClient } from "./model";
import { AwaitingExecutor, currentExecutor, jobContext, taskKey } from "./executor";
import { TOOLS, toolJsonSchema, type ToolContext } from "./tools";
import type { AgentId, AgentTask, ModelTier, ToolName } from "./types";

export interface RunAgentOptions {
  runId?: string | null;
  parentTaskId?: string | null;
  companyId?: string | null;
  threadId?: string | null;
  userId?: string | null;
  userRole?: string | null;
  depth?: number;
  research?: ResearchService;
  /** Extra capabilities wired in by the pipeline (analytics, dossier, delegation…). */
  capabilities?: Partial<Pick<ToolContext, "delegate" | "startRun" | "analytics" | "marketMap" | "dossier" | "runStatus">>;
}

export interface AgentResult<T> {
  taskId: string;
  output: T;
  costEur: number;
  toolCalls: number;
}

export class AgentError extends Error {
  constructor(message: string, public taskId: string, public retryable: boolean) {
    super(message);
  }
}

const SUBMIT = "submit_result";

export function resolveModel(settings: Settings, agentId: AgentId, tier: ModelTier): string {
  return settings.models.perAgent[agentId] ?? settings.models[tier];
}

/** Build the (cache-friendly, stable) system prompt for an agent task. */
export function buildSystemPrompt(agentId: AgentId, task: AgentTask, settings: Settings): string {
  const a = getAgent(agentId);
  const mode = task.skills ?? "project";
  const enabledSkills = (settings.agentSkills[agentId] ?? a.skills).filter((s) => mode === "all" || (mode === "project" && s.startsWith("sales-army-")));
  const skillText = mode === "none" ? "" : enabledSkills.map((s) => loadSkill(s, mode === "all" ? 4500 : 2500)).filter(Boolean).join("\n\n");
  return [
    `Je bent agent ${a.number.toString().padStart(2, "0")} van het Cloud Life Sales Army: ${a.nameNl}.`,
    `Missie: ${a.mission}`,
    `Verantwoordelijkheden:\n- ${a.responsibilities.join("\n- ")}`,
    `Kwaliteitsnormen:\n- ${a.qualityStandards.join("\n- ")}`,
    `Escalatieregels:\n- ${a.escalationRules.join("\n- ")}`,
    SECURITY_RULES,
    CLOUD_LIFE_PROFILE,
    icpText(settings),
    `# Taak: ${task.description}\n${task.instructions}`,
    skillText ? `# Methodiek-referentie (gecontroleerde community-skills; Cloud Life-regels hierboven gaan altijd voor)\n${skillText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Run one agent task to completion through a bounded tool loop.
 * - Only tools in BOTH the agent's and the task's allow-list are exposed and executable.
 * - The final answer must come through `submit_result` and pass Zod validation.
 * - Token usage and cost are recorded on the agent_tasks row after every turn.
 */
export async function runAgent<T extends z.ZodType>(
  agentId: AgentId,
  taskType: string,
  input: unknown,
  opts: RunAgentOptions = {},
): Promise<AgentResult<z.infer<T>>> {
  const agent = getAgent(agentId);
  const task = agent.tasks[taskType];
  if (!task) throw new Error(`Agent ${agentId} heeft geen taak ${taskType}`);
  const settings = await getSettings();
  const parsedInput = task.input.parse(input);
  const model = resolveModel(settings, agentId, task.modelTier ?? agent.modelTier);
  const db = getDb();

  // ── Claude Subscription Mode: park the task for a native Claude Code session (no API call, no API key).
  if ((await currentExecutor()) === "claude_code") {
    const key = taskKey({ agentId, taskType, runId: opts.runId, companyId: opts.companyId, input: parsedInput });
    const [existing] = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.idempotencyKey, key)).orderBy(desc(schema.agentTasks.createdAt)).limit(1);
    if (existing?.status === "succeeded" && existing.output) {
      const parsed = task.output.safeParse(existing.output);
      if (parsed.success) return { taskId: existing.id, output: parsed.data as z.infer<T>, costEur: 0, toolCalls: existing.toolCalls };
    }
    if (existing && existing.status === "awaiting") throw new AwaitingExecutor(existing.id, agentId, taskType);
    const tier = task.modelTier ?? agent.modelTier;
    const [parked] = await db.insert(schema.agentTasks).values({
      runId: opts.runId ?? null, agentId, parentTaskId: opts.parentTaskId ?? null, companyId: opts.companyId ?? null, taskType,
      status: "awaiting", input: parsedInput as object, model: `claude-code:${settings.execution.subscriptionModels[tier]}`, executor: "claude_code",
      idempotencyKey: key, resumeJob: jobContext.getStore() ?? null, attempts: 0,
    }).returning({ id: schema.agentTasks.id });
    throw new AwaitingExecutor(parked.id, agentId, taskType);
  }

  const [row] = await db
    .insert(schema.agentTasks)
    .values({
      runId: opts.runId ?? null, agentId, parentTaskId: opts.parentTaskId ?? null, companyId: opts.companyId ?? null,
      taskType, status: "running", input: parsedInput as object, model, startedAt: new Date(), attempts: 1,
    })
    .returning({ id: schema.agentTasks.id });
  const taskId = row.id;

  const allowed = task.tools.filter((t) => agent.tools.includes(t)) as ToolName[];
  const research = (opts.research ?? (await ResearchService.create({}))).withContext({ runId: opts.runId, agentTaskId: taskId, agentId, companyId: opts.companyId });
  const ctx: ToolContext = {
    research, agentId, taskId, runId: opts.runId, companyId: opts.companyId, threadId: opts.threadId, userId: opts.userId,
    userRole: opts.userRole, depth: opts.depth ?? 0, ...opts.capabilities,
  };

  const tools: Anthropic.Tool[] = [
    ...allowed.map((name) => ({ name, description: TOOLS[name].description, input_schema: toolJsonSchema(TOOLS[name].schema) as Anthropic.Tool.InputSchema })),
    {
      name: SUBMIT,
      description: "Lever het eindresultaat van deze taak. Moet exact aan het schema voldoen. Roep dit precies één keer aan als je klaar bent.",
      input_schema: toolJsonSchema(task.output) as Anthropic.Tool.InputSchema,
    },
  ];
  // Cache the stable prefix (tools + system).
  tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: "ephemeral" } };
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: buildSystemPrompt(agentId, task, settings), cache_control: { type: "ephemeral" } }];
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Taakinvoer (JSON, door het systeem aangeleverd):\n${JSON.stringify(parsedInput, null, 1).slice(0, 60000)}\n\nVoer de taak uit en lever het resultaat met ${SUBMIT}.`,
    },
  ];

  let costEur = 0;
  let inTok = 0;
  let outTok = 0;
  let cacheTok = 0;
  let toolCalls = 0;
  let nudges = 0;
  let invalidSubmits = 0;
  const maxTurns = task.maxTurns ?? 12;
  const client = await getModelClient();

  const persist = async (extra: Partial<typeof schema.agentTasks.$inferInsert> = {}) => {
    await db
      .update(schema.agentTasks)
      .set({ inputTokens: inTok, outputTokens: outTok, cacheReadTokens: cacheTok, toolCalls, costEur: costEur.toFixed(4), ...extra })
      .where(eq(schema.agentTasks.id, taskId));
  };
  const fail = async (message: string, retryable: boolean): Promise<never> => {
    await persist({ status: "failed", error: message.slice(0, 2000), finishedAt: new Date() });
    if (opts.runId) await db.update(schema.researchRuns).set({ costEur: sql`${schema.researchRuns.costEur} + ${costEur.toFixed(4)}` }).where(eq(schema.researchRuns.id, opts.runId));
    throw new AgentError(message, taskId, retryable);
  };

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      await assertWithinBudget(opts.runId);
      const response = await client.create({
        model,
        max_tokens: task.maxTokens ?? 16000,
        system,
        tools,
        tool_choice: { type: "auto" },
        output_config: { effort: task.effort ?? settings.models.effort },
        messages,
      });
      inTok += response.usage.input_tokens;
      outTok += response.usage.output_tokens;
      cacheTok += response.usage.cache_read_input_tokens ?? 0;
      costEur += modelCostEur(model, response.usage, settings.models.usdToEur);
      await persist();

      if (response.stop_reason === "refusal") return await fail("Model weigerde de taak (refusal)", false);
      if (response.stop_reason === "max_tokens") return await fail("Antwoord afgekapt (max_tokens)", true);
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "pause_turn") continue;

      const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!uses.length) {
        if (++nudges > 2) return await fail("Agent leverde geen resultaat via submit_result", true);
        messages.push({ role: "user", content: `Lever je resultaat nu via de tool ${SUBMIT}.` });
        continue;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      let submitted: z.infer<T> | null = null;
      for (const use of uses) {
        toolCalls++;
        if (use.name === SUBMIT) {
          const parsed = task.output.safeParse(use.input);
          if (parsed.success) {
            submitted = parsed.data as z.infer<T>;
            results.push({ type: "tool_result", tool_use_id: use.id, content: "Ontvangen." });
          } else {
            invalidSubmits++;
            const issues = parsed.error.issues.slice(0, 15).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
            results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Schemafout, corrigeer en lever opnieuw: ${issues}` });
          }
          continue;
        }
        if (!allowed.includes(use.name as ToolName)) {
          await audit({ actorType: "agent", actorId: agentId, action: "agent.tool_denied", entityType: "agent_task", entityId: taskId, details: { tool: use.name } });
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Tool '${use.name}' is niet toegestaan voor deze taak.` });
          continue;
        }
        const tool = TOOLS[use.name as ToolName];
        const parsedArgs = tool.schema.safeParse(use.input);
        if (!parsedArgs.success) {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Ongeldige argumenten: ${parsedArgs.error.issues.map((i) => i.message).join("; ")}` });
          continue;
        }
        try {
          const out = await tool.run(parsedArgs.data, ctx);
          results.push({ type: "tool_result", tool_use_id: use.id, content: out.slice(0, 30000) });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (err && typeof err === "object" && err.constructor?.name === "BudgetExceededError") throw err;
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Toolfout: ${msg.slice(0, 500)}` });
        }
      }
      messages.push({ role: "user", content: results });
      await persist();
      if (submitted) {
        await persist({ status: "succeeded", output: submitted as object, finishedAt: new Date() });
        if (opts.runId) await db.update(schema.researchRuns).set({ costEur: sql`${schema.researchRuns.costEur} + ${costEur.toFixed(4)}` }).where(eq(schema.researchRuns.id, opts.runId));
        return { taskId, output: submitted, costEur, toolCalls };
      }
      if (invalidSubmits > 3) return await fail("Herhaaldelijk ongeldige output (schemavalidatie)", true);
    }
    return await fail(`Maximaal aantal beurten (${maxTurns}) bereikt zonder resultaat`, true);
  } catch (err) {
    if (err instanceof AgentError || err instanceof AwaitingExecutor) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const budget = err && typeof err === "object" && err.constructor?.name === "BudgetExceededError";
    await persist({ status: "failed", error: msg.slice(0, 2000), finishedAt: new Date() });
    if (budget) throw err;
    throw new AgentError(msg, taskId, true);
  }
}
