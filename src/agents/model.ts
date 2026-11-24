import Anthropic from "@anthropic-ai/sdk";
import { getSecret } from "@/lib/secrets";

/**
 * Model client abstraction. Production uses the official Anthropic SDK
 * (Messages API). Tests inject a scripted client (clearly synthetic).
 */
export interface ModelClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export class AnthropicModelClient implements ModelClient {
  private client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 3, timeout: 10 * 60 * 1000 });
  }
  async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    // Streaming + finalMessage avoids HTTP timeouts on long agent turns.
    return this.client.messages.stream(params).finalMessage();
  }
}

let override: ModelClient | null = null;
export function setModelClient(c: ModelClient | null) {
  override = c;
}
export function hasModelOverride(): boolean {
  return override !== null;
}
let cached: { key: string; client: AnthropicModelClient } | null = null;
export async function getModelClient(): Promise<ModelClient> {
  if (override) return override;
  const { getSettings } = await import("@/lib/settings");
  const s = await getSettings();
  // Paid API usage is never automatic: it requires Paid API Mode AND an explicit administrator approval.
  if (s.execution.mode !== "api" || !s.execution.paidApiApproved) throw new Error("Paid API Mode is niet ingeschakeld/goedgekeurd — Claude Subscription Mode gebruikt geen API-sleutel");
  const key = await getSecret("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY ontbreekt — alleen nodig voor Paid API Mode (Setup → Uitvoeringsmodus)");
  if (!cached || cached.key !== key) cached = { key, client: new AnthropicModelClient(key) };
  return cached.client;
}
/** True when AI work can proceed: Claude Subscription Mode (deferred to Claude Code) or approved Paid API Mode. */
export async function modelAvailable(): Promise<boolean> {
  if (override) return true;
  const { executorAvailable } = await import("./executor");
  return executorAvailable();
}
