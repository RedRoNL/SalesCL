import type Anthropic from "@anthropic-ai/sdk";
import type { SearchProvider, SearchResult } from "./types";
import type { ModelClient } from "@/agents/model";

/**
 * Search via Claude's server-side web search tool. Used when Firecrawl is not
 * configured. Returns only result URLs/titles; page content is then retrieved
 * through the FetchProvider so every claim maps to a stored source.
 */
export class AnthropicWebSearchProvider implements SearchProvider {
  readonly name = "anthropic_web_search";
  readonly paid = true;
  constructor(private client: ModelClient, private model: string, private onUsage?: (msg: Anthropic.Message) => Promise<void>) {}

  async search(query: string, opts: { limit?: number } = {}) {
    const toolType = this.model.startsWith("claude-haiku") ? "web_search_20250305" : "web_search_20260209";
    const msg = await this.client.create({
      model: this.model,
      max_tokens: 2048,
      tools: [{ type: toolType, name: "web_search", max_uses: 1, user_location: { type: "approximate", country: "NL" } } as unknown as Anthropic.ToolUnion],
      messages: [{ role: "user", content: `Voer precies één webzoekopdracht uit met deze query en geef daarna alleen "klaar": ${JSON.stringify(query)}` }],
    });
    await this.onUsage?.(msg);
    const results: SearchResult[] = [];
    for (const block of msg.content as unknown as { type: string; content?: unknown }[]) {
      if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
      for (const r of block.content as { type: string; url: string; title?: string; page_age?: string }[]) {
        if (r.type === "web_search_result") results.push({ url: r.url, title: r.title ?? "", snippet: r.page_age ? `(${r.page_age})` : "" });
      }
    }
    return { results: results.slice(0, opts.limit ?? 10), units: 1 };
  }
}
