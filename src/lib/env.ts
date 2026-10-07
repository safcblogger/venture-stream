import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_URL: z.string().default("http://localhost:3000"),
  AI_PROVIDER: z.string().default("openai"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  OPENAI_MODEL: z.string().default("gpt-5-mini"),
  SEARCH_PROVIDER: z.string().default("tavily"),
  TAVILY_API_KEY: z.string().optional(),
  TAVILY_BASE_URL: z.string().default("https://api.tavily.com"),
  ALLOW_REGISTRATION: z.string().default("true"),
  WORKER_ENABLED: z.string().default("true"),
});

let cached: z.infer<typeof schema> | null = null;

/** Server-only configuration. Never import from client components. */
export function env() {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error("Invalid server configuration: " + parsed.error.issues.map((i) => i.message).join("; "));
    }
    cached = parsed.data;
  }
  return cached;
}
