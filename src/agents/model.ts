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
let cached: { key: string; client: AnthropicModelClient } | null = null;
export async function getModelClient(): Promise<ModelClient> {
  if (override) return override;
  const key = await getSecret("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY ontbreekt — stel de Claude API-sleutel in via Setup (/setup)");
  if (!cached || cached.key !== key) cached = { key, client: new AnthropicModelClient(key) };
  return cached.client;
}
export async function modelAvailable(): Promise<boolean> {
  return Boolean(override || (await getSecret("ANTHROPIC_API_KEY")));
}
