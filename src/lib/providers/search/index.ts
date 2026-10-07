import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { fetchJson } from "@/lib/http";
import { getSecret } from "@/lib/secrets";

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export interface SearchOptions {
  maxResults?: number;
  includeDomains?: string[];
}

/** Web-search boundary. Add a new provider by implementing this and registering it in getSearchProvider(). */
export interface SearchProvider {
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  /** Fetch readable page text for specific URLs. */
  extract(urls: string[]): Promise<{ url: string; content: string }[]>;
}

class TavilyProvider implements SearchProvider {
  readonly name = "Tavily";
  constructor(private readonly apiKey: string, private readonly baseUrl = "https://api.tavily.com") {}

  private headers() {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const data = await fetchJson<{ results?: { title?: string; url?: string; content?: string }[] }>(
      `${this.baseUrl}/search`,
      {
        service: "Tavily web search",
        headers: this.headers(),
        timeoutMs: 30_000,
        body: {
          query,
          search_depth: "basic",
          max_results: options.maxResults ?? 8,
          include_domains: options.includeDomains?.length ? options.includeDomains : undefined,
        },
      },
    );
    if (!Array.isArray(data.results)) {
      throw new AppError("invalid_response", "Tavily web search returned a response that could not be understood.");
    }
    return data.results
      .filter((r) => r.url && (r.content || r.title))
      .map((r) => ({ title: r.title ?? r.url!, url: r.url!, content: r.content ?? "" }));
  }

  async extract(urls: string[]): Promise<{ url: string; content: string }[]> {
    if (urls.length === 0) return [];
    const data = await fetchJson<{ results?: { url?: string; raw_content?: string }[] }>(
      `${this.baseUrl}/extract`,
      { service: "Tavily page extraction", headers: this.headers(), timeoutMs: 45_000, body: { urls } },
    );
    if (!Array.isArray(data.results)) {
      throw new AppError("invalid_response", "Tavily page extraction returned a response that could not be understood.");
    }
    return data.results.filter((r) => r.url && r.raw_content).map((r) => ({ url: r.url!, content: r.raw_content! }));
  }
}

export async function getSearchProvider(workspaceId?: string): Promise<SearchProvider> {
  const { SEARCH_PROVIDER, TAVILY_BASE_URL } = env();
  const TAVILY_API_KEY = (workspaceId ? await getSecret(workspaceId, "tavily_api_key") : null) ?? env().TAVILY_API_KEY;
  switch (SEARCH_PROVIDER) {
    case "tavily":
      if (!TAVILY_API_KEY) {
        throw new AppError("not_configured", "Web search is not configured. Add your Tavily API key in Settings → Integrations to enable discovery and research.");
      }
      return new TavilyProvider(TAVILY_API_KEY, TAVILY_BASE_URL);
    default:
      throw new AppError("not_configured", `Unknown search provider "${SEARCH_PROVIDER}".`);
  }
}

export { TavilyProvider };
