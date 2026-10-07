import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newProspect, newWorkspace } from "./helpers/fixtures";
import { OpenAiProvider, completeJson } from "@/lib/providers/ai";
import { TavilyProvider } from "@/lib/providers/search";
import { ask } from "@/lib/assistant/chat";
import { upsertOpportunity } from "@/lib/services/opportunities";
import { db, schema } from "@/db";
import { z } from "zod";

/** A local HTTP server speaking the OpenAI chat-completions and Tavily wire formats, so the real adapters run end to end. */
let server: Server;
let base: string;
const received: { path: string; auth?: string; body: any }[] = [];
let openAiScript: (body: any, n: number) => any = () => ({ choices: [{ message: { content: "{}" } }] });
let n = 0;

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || "{}");
    received.push({ path: req.url!, auth: req.headers.authorization, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/chat/completions") res.end(JSON.stringify(openAiScript(body, ++n)));
    else if (req.url === "/search") res.end(JSON.stringify({ results: [{ title: "Hit", url: "https://hit.test", content: "text" }] }));
    else res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("OpenAI adapter wire format", () => {
  it("sends bearer auth, tools and JSON mode; parses tool calls", async () => {
    const ai = new OpenAiProvider("sk-test", "model-x", `${base}/v1`);
    openAiScript = () => ({ choices: [{ message: { content: null, tool_calls: [{ id: "call_1", function: { name: "search_prospects", arguments: "{\"limit\":3}" } }] } }] });
    const r = await ai.complete({
      messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
      tools: [{ name: "search_prospects", description: "d", parameters: { type: "object", properties: {} } }],
    });
    expect(r.toolCalls).toEqual([{ id: "call_1", name: "search_prospects", arguments: "{\"limit\":3}" }]);
    const sent = received.at(-1)!;
    expect(sent.auth).toBe("Bearer sk-test");
    expect(sent.body.model).toBe("model-x");
    expect(sent.body.tools[0]).toMatchObject({ type: "function", function: { name: "search_prospects" } });

    openAiScript = () => ({ choices: [{ message: { content: "{\"a\":1}" } }] });
    await ai.complete({ messages: [{ role: "user", content: "x" }], json: true });
    expect(received.at(-1)!.body.response_format).toEqual({ type: "json_object" });
  });

  it("retries once when the model returns invalid JSON, then succeeds", async () => {
    const ai = new OpenAiProvider("k", "m", `${base}/v1`);
    let calls = 0;
    openAiScript = () => ({ choices: [{ message: { content: ++calls === 1 ? "oops" : "{\"ok\":true}" } }] });
    expect(await completeJson(ai, [{ role: "user", content: "x" }], z.object({ ok: z.boolean() }))).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("gives up with a safe error after two invalid replies", async () => {
    const ai = new OpenAiProvider("k", "m", `${base}/v1`);
    openAiScript = () => ({ choices: [{ message: { content: "still not json" } }] });
    await expect(completeJson(ai, [{ role: "user", content: "x" }], z.object({ ok: z.boolean() }))).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("reports an empty completion", async () => {
    const ai = new OpenAiProvider("k", "m", `${base}/v1`);
    openAiScript = () => ({ choices: [] });
    await expect(ai.complete({ messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ kind: "empty_response" });
  });
});

describe("Tavily adapter wire format", () => {
  it("posts the query with bearer auth", async () => {
    const t = new TavilyProvider("tvly-test", base);
    const r = await t.search("uk shopify stores", { maxResults: 3, includeDomains: ["linkedin.com"] });
    expect(r).toEqual([{ title: "Hit", url: "https://hit.test", content: "text" }]);
    const sent = received.at(-1)!;
    expect(sent.path).toBe("/search");
    expect(sent.auth).toBe("Bearer tvly-test");
    expect(sent.body).toMatchObject({ query: "uk shopify stores", max_results: 3, include_domains: ["linkedin.com"] });
  });
});

describe("assistant end to end through the real OpenAI adapter", () => {
  it("runs the tool loop against live database rows", async () => {
    const s = await newWorkspace();
    const p = await newProspect(s, "Wire Test Co");
    await upsertOpportunity(s, p.id, { categoryKey: "technical_seo", score: 66, description: "d", evidence: [{ text: "e" }], origin: "ai" });
    await db.update(schema.prospects).set({ ecommercePlatform: "Shopify" }).where(eq(schema.prospects.id, p.id));

    const ai = new OpenAiProvider("k", "m", `${base}/v1`);
    openAiScript = (body) => {
      const last = body.messages.at(-1);
      if (last.role === "tool") {
        const data = JSON.parse(last.content);
        const first = data.prospects[0];
        return { choices: [{ message: { content: `Top prospect: [${first.name}](${first.link}) — **${first.opportunityScore}**` } }] };
      }
      return { choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "search_prospects", arguments: JSON.stringify({ platform: "Shopify" }) } }] } }] };
    };
    const out = await ask(s, "WS", { message: "Best Shopify prospects?" }, ai);
    expect(out.reply).toBe(`Top prospect: [Wire Test Co](/prospects/${p.id}) — **66**`);
    // The system prompt carries the grounding rules and the exact fallback sentences.
    const sys = received.filter((r) => r.path === "/v1/chat/completions").at(-2)!.body.messages[0].content as string;
    expect(sys).toContain("I couldn't find any prospects matching those criteria.");
    expect(sys).toContain("I don't have enough information in Venture Stream to answer that.");
  });
});
