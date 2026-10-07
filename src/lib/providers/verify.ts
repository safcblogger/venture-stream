import { env } from "@/lib/env";
import { fetchJson } from "@/lib/http";
import { TavilyProvider } from "@/lib/providers/search";
import type { SecretName } from "@/lib/secrets";

/**
 * Check a key against the provider before saving it. Throws AppError("provider_auth") for a rejected key;
 * other failures (network, rate limit) are rethrown so the caller can save anyway with a warning.
 */
export async function verifySecret(name: SecretName, value: string): Promise<void> {
  if (name === "openai_api_key") {
    const base = env().OPENAI_BASE_URL.replace(/\/+$/, "");
    await fetchJson(`${base}/models`, { service: "OpenAI", method: "GET", headers: { authorization: `Bearer ${value}` }, timeoutMs: 15_000 });
    return;
  }
  await new TavilyProvider(value, env().TAVILY_BASE_URL).search("test", { maxResults: 1 });
}
