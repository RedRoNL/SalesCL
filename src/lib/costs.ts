/**
 * Model pricing (USD per 1M tokens) — Anthropic first-party list prices as of
 * 2026-11. Kept in code so cost per task is computed at write time; update
 * when prices change (see OPERATIONS.md).
 */
export const MODEL_PRICING_USD: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
};
/** Anthropic web search server tool: USD per search. */
export const WEB_SEARCH_USD_PER_SEARCH = 0.01;

export function modelCostEur(
  model: string,
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; server_tool_use?: { web_search_requests?: number | null } | null },
  usdToEur: number,
): number {
  const p = MODEL_PRICING_USD[model] ?? MODEL_PRICING_USD["claude-opus-5-5"];
  const usd =
    (usage.input_tokens * p.input + (usage.cache_creation_input_tokens ?? 0) * p.input * 1.25 + (usage.cache_read_input_tokens ?? 0) * p.cacheRead + usage.output_tokens * p.output) / 1_000_000 +
    (usage.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD_PER_SEARCH;
  return usd * usdToEur;
}
