import { and, asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { AppError } from "@/lib/errors";
import type { AiProvider, ChatMessage } from "@/lib/providers/ai";
import type { Scope } from "@/lib/services/common";
import { todayISO } from "@/lib/services/tasks";
import { runTool, TOOL_DEFINITIONS, type EntityRef } from "./tools";

export const NO_MATCH = "I couldn't find any prospects matching those criteria.";
export const NO_INFO = "I don't have enough information in Venture Stream to answer that.";

const MAX_TOOL_ROUNDS = 5;
const HISTORY_MESSAGES = 16;

export function systemPrompt(today: string, workspaceName: string) {
  return `You are the Venture Stream AI Sales Assistant for the workspace "${workspaceName}". Today's date is ${today}.
You answer questions about this workspace's sales operation: prospects, opportunities, contacts, tasks, campaigns, pipeline and revenue.

GROUNDING RULES (absolute):
- Use the provided tools to look up data before answering any question about prospects, contacts, opportunities, tasks, campaigns, pipeline or revenue. Never answer such questions from memory or assumption.
- Only state facts that appear in tool results. Never invent or guess companies, contacts, decision makers, opportunities, campaigns, revenue, tasks, scores, dates or pipeline stages.
- If a tool returns no matching records, reply exactly: "${NO_MATCH}" (adapt "prospects" to the record type asked about, e.g. campaigns or tasks).
- If the data needed is not available in Venture Stream, reply exactly: "${NO_INFO}"
- Do not fill gaps with plausible guesses. If only part of the question can be answered, answer that part and say what is missing.
- When drafting messages (e.g. follow-ups), use only facts from tool results, make clear they are drafts that have not been sent, and never fabricate details about the recipient.
- Messages marked [Records referenced earlier: ...] in the history are the records you previously showed. Resolve words like "those", "them" or "the first one" to those records, and call tools with their ids.

STYLE:
- Be concise and scannable: short paragraphs, bullets, numbered lists, and a short heading where useful. Put key figures in **bold**.
- Every company or campaign that exists in a tool result must be a markdown link using the "link" path given in the tool result, e.g. [Acme Ltd](/prospects/<id>). Never link to anything else and never invent ids or URLs.
- Money values from tools are in minor currency units (pence/cents); divide by 100 and show with the currency symbol only if the currency is known, otherwise as a plain number.
- Say how many records matched when a list is truncated.`;
}

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Strip any link the model produced that does not point at a record it actually retrieved. */
export function sanitizeLinks(text: string, allowed: Map<string, string>): string {
  return text.replace(LINK, (_m, label: string, href: string) => {
    const m = href.match(/^\/(prospects|campaigns)\/([0-9a-f-]{36})$/i);
    if (m && allowed.has(m[2].toLowerCase())) return `[${label}](${href})`;
    return label;
  });
}

export function referencedEntities(text: string, pool: Map<string, EntityRef>): EntityRef[] {
  const out = new Map<string, EntityRef>();
  for (const m of text.matchAll(/\]\(\/(?:prospects|campaigns)\/([0-9a-f-]{36})\)/gi)) {
    const e = pool.get(m[1].toLowerCase());
    if (e) out.set(e.id, e);
  }
  return [...out.values()];
}

export async function getConversation(scope: Scope, id: string) {
  const [conv] = await db
    .select()
    .from(schema.aiConversations)
    .where(and(eq(schema.aiConversations.id, id), eq(schema.aiConversations.workspaceId, scope.workspaceId), eq(schema.aiConversations.userId, scope.userId)));
  return conv ?? null;
}

export async function listMessages(scope: Scope, conversationId: string) {
  if (!(await getConversation(scope, conversationId))) return [];
  return db
    .select({ id: schema.aiMessages.id, role: schema.aiMessages.role, content: schema.aiMessages.content, createdAt: schema.aiMessages.createdAt })
    .from(schema.aiMessages)
    .where(eq(schema.aiMessages.conversationId, conversationId))
    .orderBy(asc(schema.aiMessages.createdAt));
}

export async function latestConversation(scope: Scope) {
  const [conv] = await db
    .select()
    .from(schema.aiConversations)
    .where(and(eq(schema.aiConversations.workspaceId, scope.workspaceId), eq(schema.aiConversations.userId, scope.userId)))
    .orderBy(desc(schema.aiConversations.updatedAt))
    .limit(1);
  return conv ?? null;
}

export async function ask(
  scope: Scope,
  workspaceName: string,
  input: { conversationId?: string | null; message: string },
  ai: AiProvider,
): Promise<{ conversationId: string; reply: string }> {
  const message = input.message.trim();
  if (!message) throw new AppError("validation", "Type a question first.");
  if (message.length > 2000) throw new AppError("validation", "Keep questions under 2,000 characters.");

  let conv = input.conversationId ? await getConversation(scope, input.conversationId) : null;
  if (input.conversationId && !conv) throw new AppError("not_found", "That conversation was not found.");
  if (!conv) {
    [conv] = await db
      .insert(schema.aiConversations)
      .values({ workspaceId: scope.workspaceId, userId: scope.userId, title: message.slice(0, 80) })
      .returning();
  }

  const history = (
    await db
      .select()
      .from(schema.aiMessages)
      .where(eq(schema.aiMessages.conversationId, conv.id))
      .orderBy(desc(schema.aiMessages.createdAt))
      .limit(HISTORY_MESSAGES)
  ).reverse();

  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt(todayISO(), workspaceName) }];
  const pool = new Map<string, EntityRef>();
  for (const h of history) {
    if (h.role === "user") messages.push({ role: "user", content: h.content });
    else {
      const refs = h.entities?.length ? `\n\n[Records referenced earlier: ${h.entities.map((e) => `${e.name} (${e.type} id ${e.id})`).join("; ")}]` : "";
      for (const e of h.entities ?? []) pool.set(e.id.toLowerCase(), e as EntityRef);
      messages.push({ role: "assistant", content: h.content + refs });
    }
  }
  messages.push({ role: "user", content: message });
  await db.insert(schema.aiMessages).values({ conversationId: conv.id, role: "user", content: message });

  let reply: string | null = null;
  let turnEntities: EntityRef[] = [];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await ai.complete({ messages, tools: round < MAX_TOOL_ROUNDS ? TOOL_DEFINITIONS : undefined });
    if (res.toolCalls.length === 0) {
      reply = res.content;
      break;
    }
    messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      const out = await runTool(scope, call.name, call.arguments);
      for (const e of out.entities) pool.set(e.id.toLowerCase(), e);
      if (out.entities.length) turnEntities = out.entities;
      messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(out.data).slice(0, 24_000) });
    }
  }
  if (!reply?.trim()) throw new AppError("empty_response", "The assistant did not produce an answer. Please try again.");

  const clean = sanitizeLinks(reply.trim(), new Map([...pool.keys()].map((k) => [k, pool.get(k)!.name])));
  const linked = referencedEntities(clean, pool);
  const entities = linked.length ? linked : turnEntities.slice(0, 15);
  await db.insert(schema.aiMessages).values({ conversationId: conv.id, role: "assistant", content: clean, entities });
  await db.update(schema.aiConversations).set({ updatedAt: new Date() }).where(eq(schema.aiConversations.id, conv.id));
  return { conversationId: conv.id, reply: clean };
}
