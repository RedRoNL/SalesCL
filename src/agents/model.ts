import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";

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
export function getModelClient(): ModelClient {
  if (override) return override;
  const key = env().ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY ontbreekt — AI-agents kunnen niet draaien (zie BUILD_STATUS.md)");
  return new AnthropicModelClient(key);
}
export function modelAvailable(): boolean {
  return Boolean(override || env().ANTHROPIC_API_KEY);
}
