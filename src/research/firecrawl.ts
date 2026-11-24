import Firecrawl from "@mendable/firecrawl-js";
import type { FetchProvider, SearchProvider } from "./types";
import { ProviderUnavailableError } from "./types";
import { assertPublicHttpUrl } from "./http";

/** Firecrawl (https://firecrawl.dev) — community-proven search + scrape. Paid per credit. */
export class FirecrawlProvider implements SearchProvider, FetchProvider {
  readonly name = "firecrawl";
  readonly paid = true;
  private client: Firecrawl;
  constructor(apiKey: string | undefined) {
    if (!apiKey) throw new ProviderUnavailableError("firecrawl", "FIRECRAWL_API_KEY ontbreekt");
    this.client = new Firecrawl({ apiKey, timeoutMs: 60000, maxRetries: 2 });
  }

  async search(query: string, opts: { limit?: number; country?: string; includeDomains?: string[] } = {}) {
    const limit = Math.min(opts.limit ?? 10, 20);
    const data = await this.client.search(query, { limit, country: opts.country ?? "NL", sources: ["web"], includeDomains: opts.includeDomains });
    const results = (data.web ?? []).map((r) => {
      const anyR = r as { url?: string; title?: string; description?: string; metadata?: { url?: string; title?: string; description?: string } };
      return {
        url: anyR.url ?? anyR.metadata?.url ?? "",
        title: anyR.title ?? anyR.metadata?.title ?? "",
        snippet: anyR.description ?? anyR.metadata?.description ?? "",
      };
    }).filter((r) => r.url);
    // Firecrawl search bills ~2 credits per 10 results.
    return { results, units: Math.max(1, Math.ceil(limit / 10) * 2) };
  }

  async fetch(url: string) {
    assertPublicHttpUrl(url);
    const doc = await this.client.scrape(url, { formats: ["markdown", "links"], onlyMainContent: false });
    return {
      page: {
        url,
        finalUrl: doc.metadata?.url ?? url,
        status: (doc.metadata as { statusCode?: number } | undefined)?.statusCode ?? 200,
        title: doc.metadata?.title ?? null,
        text: doc.markdown ?? "",
        links: (doc.links ?? []).slice(0, 400).map((href) => ({ href, text: "" })),
      },
      units: 1,
    };
  }
}
