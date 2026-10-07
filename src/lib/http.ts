import { AppError } from "./errors";

export interface FetchJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Human name of the service, used in user-facing error messages. */
  service: string;
}

/**
 * fetch + JSON with timeout and uniform error mapping.
 * Covers: timeout, auth failure, rate limit, API failure, invalid and empty responses, network failure.
 */
export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers: { "content-type": "application/json", ...opts.headers },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      throw new AppError("timeout", `${opts.service} took too long to respond. Please try again.`, { cause: err });
    }
    throw new AppError("network", `Could not reach ${opts.service}. Check the connection and try again.`, { cause: err });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new AppError("provider_auth", `${opts.service} rejected the configured credentials. Check the API key in the server configuration.`);
  }
  if (res.status === 429) {
    throw new AppError("rate_limit", `${opts.service} is rate limiting requests. Please wait a moment and try again.`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[${opts.service}] HTTP ${res.status}`, detail.slice(0, 500));
    throw new AppError("provider_api", `${opts.service} returned an error (${res.status}). Please try again later.`);
  }
  const text = await res.text();
  if (!text.trim()) throw new AppError("empty_response", `${opts.service} returned an empty response.`);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new AppError("invalid_response", `${opts.service} returned a response that could not be understood.`, { cause: err });
  }
}
