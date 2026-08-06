import { z } from "zod";

import type { ToolDefinition } from "../ai/types.js";
import { getLogger } from "../logging.js";

import type { ToolExecuteResult, ToolTurnContext } from "./types.js";

const SEARCH_RESULT_CAP = 8;
const FETCH_TEXT_MAX_CHARS = 40_000;

export const WEB_SEARCH_PROVIDERS = ["serpapi", "firecrawl"] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export const WEB_FETCH_PROVIDERS = ["firecrawl", "fetchapi"] as const;
export type WebFetchProvider = (typeof WEB_FETCH_PROVIDERS)[number];

export const WebSearchParams = z.object({
  query: z.string().min(1).describe("Web search query"),
});

export const WebFetchParams = z.object({
  url: z.string().url().describe("Absolute URL to fetch / crawl"),
});

function deny(message: string): ToolExecuteResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n…[truncated by tool]";
}

/** Cheap HTML → text for fetchapi (no extra deps). */
function htmlToRoughText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchSerpApi(
  query: string,
  apiKey: string,
): Promise<ToolExecuteResult> {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("engine", "google");
  url.searchParams.set("num", String(SEARCH_RESULT_CAP));

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return deny(
      `SerpAPI HTTP ${res.status}: ${body.slice(0, 500) || res.statusText}`,
    );
  }
  const data = (await res.json()) as {
    organic_results?: Array<{
      title?: string;
      link?: string;
      snippet?: string;
    }>;
    error?: string;
  };
  if (data.error) {
    return deny(`SerpAPI error: ${data.error}`);
  }
  const results = (data.organic_results ?? [])
    .slice(0, SEARCH_RESULT_CAP)
    .map((r) => ({
      title: r.title ?? "",
      link: r.link ?? "",
      snippet: r.snippet ?? "",
    }));
  return { content: JSON.stringify({ provider: "serpapi", query, results }) };
}

async function searchFirecrawl(
  query: string,
  apiKey: string,
): Promise<ToolExecuteResult> {
  const res = await fetch("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      limit: SEARCH_RESULT_CAP,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return deny(
      `Firecrawl search HTTP ${res.status}: ${body.slice(0, 500) || res.statusText}`,
    );
  }
  const data = (await res.json()) as {
    success?: boolean;
    data?: Array<{
      title?: string;
      url?: string;
      description?: string;
      markdown?: string;
    }>;
    error?: string;
  };
  if (data.success === false || data.error) {
    return deny(`Firecrawl search error: ${data.error ?? "unknown"}`);
  }
  const results = (data.data ?? []).slice(0, SEARCH_RESULT_CAP).map((r) => ({
    title: r.title ?? "",
    link: r.url ?? "",
    snippet: r.description ?? "",
  }));
  return {
    content: JSON.stringify({ provider: "firecrawl", query, results }),
  };
}

async function fetchFirecrawl(
  pageUrl: string,
  apiKey: string,
): Promise<ToolExecuteResult> {
  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: pageUrl,
      formats: ["markdown"],
      onlyMainContent: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return deny(
      `Firecrawl scrape HTTP ${res.status}: ${body.slice(0, 500) || res.statusText}`,
    );
  }
  const data = (await res.json()) as {
    success?: boolean;
    data?: { markdown?: string; content?: string; metadata?: unknown };
    error?: string;
  };
  if (data.success === false || data.error) {
    return deny(`Firecrawl scrape error: ${data.error ?? "unknown"}`);
  }
  const text = truncate(
    data.data?.markdown ?? data.data?.content ?? JSON.stringify(data.data),
    FETCH_TEXT_MAX_CHARS,
  );
  return {
    content: JSON.stringify({
      provider: "firecrawl",
      url: pageUrl,
      content: text,
    }),
  };
}

async function fetchNative(pageUrl: string): Promise<ToolExecuteResult> {
  const page = new URL(pageUrl);
  const res = await fetch(pageUrl, {
    redirect: "follow",
    headers: {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      // Same-origin-ish referer: site root of the target URL.
      Referer: `${page.protocol}//${page.host}/`,
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return deny(
      `fetchapi HTTP ${res.status}: ${body.slice(0, 500) || res.statusText}`,
    );
  }
  const contentType = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  const text = truncate(
    contentType.includes("html") ? htmlToRoughText(raw) : raw,
    FETCH_TEXT_MAX_CHARS,
  );
  return {
    content: JSON.stringify({
      provider: "fetchapi",
      url: pageUrl,
      contentType,
      content: text,
    }),
  };
}

export interface WebSearchToolOptions {
  provider: WebSearchProvider;
  apiKey: string;
}

export function createWebSearchTool(options: WebSearchToolOptions): {
  definition: ToolDefinition;
  execute: (
    args: unknown,
    ctx: ToolTurnContext,
  ) => Promise<ToolExecuteResult>;
} {
  const log = getLogger("tools.web_search");
  const { provider, apiKey } = options;
  return {
    definition: {
      name: "web_search",
      description:
        "Search the web. Returns a short list of organic results (title, link, snippet).",
      parameters: WebSearchParams,
    },
    async execute(raw) {
      const parsed = WebSearchParams.safeParse(raw);
      if (!parsed.success) {
        return deny(`Invalid web_search args: ${parsed.error.message}`);
      }
      try {
        const result =
          provider === "serpapi"
            ? await searchSerpApi(parsed.data.query, apiKey)
            : await searchFirecrawl(parsed.data.query, apiKey);
        if (!result.isError) {
          log.info(
            { provider, query: parsed.data.query },
            "web_search ok",
          );
        }
        return result;
      } catch (err) {
        return deny(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export interface WebFetchToolOptions {
  provider: WebFetchProvider;
  /** Required for `firecrawl`; ignored for `fetchapi`. */
  apiKey?: string;
}

export function createWebFetchTool(options: WebFetchToolOptions): {
  definition: ToolDefinition;
  execute: (
    args: unknown,
    ctx: ToolTurnContext,
  ) => Promise<ToolExecuteResult>;
} {
  const log = getLogger("tools.web_fetch");
  const { provider, apiKey } = options;
  return {
    definition: {
      name: "web_fetch",
      description:
        "Fetch a URL and return page text (markdown when using Firecrawl; rough text for native fetch).",
      parameters: WebFetchParams,
    },
    async execute(raw) {
      const parsed = WebFetchParams.safeParse(raw);
      if (!parsed.success) {
        return deny(`Invalid web_fetch args: ${parsed.error.message}`);
      }
      try {
        let result: ToolExecuteResult;
        if (provider === "firecrawl") {
          if (!apiKey) {
            return deny("Firecrawl fetch configured but API key is missing");
          }
          result = await fetchFirecrawl(parsed.data.url, apiKey);
        } else {
          result = await fetchNative(parsed.data.url);
        }
        if (!result.isError) {
          log.info({ provider, url: parsed.data.url }, "web_fetch ok");
        }
        return result;
      } catch (err) {
        return deny(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
