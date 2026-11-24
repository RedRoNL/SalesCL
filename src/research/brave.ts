import type { SearchProvider } from "./types";
import { ProviderUnavailableError } from "./types";

/**
 * Brave Search API — independent index, ~$5 per 1,000 queries (2026), no model
 * tokens involved. Optional low-cost alternative to Claude web search for
 * high-volume discovery queries.
 */
export class BraveSearchProvider implements SearchProvider {
  readonly name = "brave";
  readonly paid = true;
  constructor(private apiKey: string | null, private fetchImpl: typeof fetch = fetch) {
    if (!apiKey) throw new ProviderUnavailableError("brave", "BRAVE_SEARCH_API_KEY ontbreekt");
  }
  async search(query: string, opts: { limit?: number; country?: string } = {}) {
    const u = new URL("https://api.search.brave.com/res/v1/web/search");
    u.searchParams.set("q", query);
    u.searchParams.set("count", String(Math.min(opts.limit ?? 10, 20)));
    u.searchParams.set("country", (opts.country ?? "NL").toLowerCase());
    u.searchParams.set("search_lang", "nl");
    const r = await this.fetchImpl(u, { headers: { "X-Subscription-Token": this.apiKey!, accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Brave Search ${r.status}`);
    const j = (await r.json()) as { web?: { results?: { url: string; title?: string; description?: string }[] } };
    return { results: (j.web?.results ?? []).map((x) => ({ url: x.url, title: x.title ?? "", snippet: (x.description ?? "").replace(/<[^>]+>/g, "") })), units: 1 };
  }
}
