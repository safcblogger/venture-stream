import { z } from "zod";
import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { fetchJson } from "@/lib/http";
import { getSecret } from "@/lib/secrets";

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** Ask the model to return a single JSON object. */
  json?: boolean;
  timeoutMs?: number;
}

export interface CompletionResult {
  content: string | null;
  toolCalls: ToolCall[];
}

/** LLM boundary. Add a provider by implementing this and registering it in getAiProvider(). */
export interface AiProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

class OpenAiProvider implements AiProvider {
  readonly name = "OpenAI";
  constructor(private readonly apiKey: string, private readonly model: string, private readonly baseUrl = "https://api.openai.com/v1") {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const messages = req.messages.map((m) => {
      if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      if (m.role === "assistant") {
        return {
          role: "assistant",
          content: m.content,
          tool_calls: m.toolCalls?.length
            ? m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }))
            : undefined,
        };
      }
      return m;
    });
    const data = await fetchJson<{
      choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
    }>(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      service: "OpenAI",
      headers: { authorization: `Bearer ${this.apiKey}` },
      timeoutMs: req.timeoutMs ?? 90_000,
      body: {
        model: this.model,
        messages,
        tools: req.tools?.length
          ? req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }))
          : undefined,
        response_format: req.json ? { type: "json_object" } : undefined,
      },
    });
    const message = data.choices?.[0]?.message;
    if (!message) throw new AppError("empty_response", "OpenAI returned an empty response.");
    const toolCalls = (message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }));
    if (!message.content && toolCalls.length === 0) {
      throw new AppError("empty_response", "OpenAI returned an empty response.");
    }
    return { content: message.content ?? null, toolCalls };
  }
}

export { OpenAiProvider };

/** A key saved in Settings → Integrations wins over the server environment variable. */
export async function getAiProvider(workspaceId?: string): Promise<AiProvider> {
  const { AI_PROVIDER, OPENAI_MODEL, OPENAI_BASE_URL } = env();
  const OPENAI_API_KEY = (workspaceId ? await getSecret(workspaceId, "openai_api_key") : null) ?? env().OPENAI_API_KEY;
  switch (AI_PROVIDER) {
    case "openai":
      if (!OPENAI_API_KEY) {
        throw new AppError("not_configured", "The AI provider is not configured. Add your OpenAI API key in Settings → Integrations to enable AI features.");
      }
      return new OpenAiProvider(OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL);
    default:
      throw new AppError("not_configured", `Unknown AI provider "${AI_PROVIDER}".`);
  }
}

/** Request JSON and validate it with zod; retries once with the validation error fed back to the model. */
export async function completeJson<S extends z.ZodType>(
  ai: AiProvider,
  messages: ChatMessage[],
  schema: S,
): Promise<z.infer<S>> {
  let msgs = messages;
  let lastIssue = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ai.complete({ messages: msgs, json: true });
    try {
      const parsed = schema.safeParse(JSON.parse(res.content ?? ""));
      if (parsed.success) return parsed.data;
      lastIssue = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    } catch {
      lastIssue = "The response was not valid JSON.";
    }
    msgs = [
      ...messages,
      { role: "assistant", content: res.content },
      { role: "user", content: `Your previous reply was invalid (${lastIssue}). Reply again with only a valid JSON object matching the requested shape.` },
    ];
  }
  throw new AppError("invalid_response", "The AI returned a response that could not be understood. Please try again.");
}
