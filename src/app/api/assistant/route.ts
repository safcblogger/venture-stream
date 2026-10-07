import { z } from "zod";
import { apiHandler, assertSameOrigin } from "@/lib/api";
import { requireApiContext } from "@/lib/auth";
import { ask, latestConversation, listMessages } from "@/lib/assistant/chat";
import { AppError } from "@/lib/errors";
import { getAiProvider } from "@/lib/providers/ai";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const body = z.object({ conversationId: z.string().uuid().nullish(), message: z.string().min(1).max(2000) });

/** Restore the user's most recent conversation. */
export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireApiContext();
    const scope = { workspaceId: ctx.workspace.id, userId: ctx.user.id };
    const conv = await latestConversation(scope);
    if (!conv) return { conversationId: null, messages: [] };
    return { conversationId: conv.id, messages: (await listMessages(scope, conv.id)).map((m) => ({ id: m.id, role: m.role, content: m.content })) };
  });
}

export async function POST(req: Request) {
  return apiHandler(async () => {
    assertSameOrigin(req);
    const ctx = await requireApiContext();
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("validation", "Type a question (up to 2,000 characters).");
    return ask(
      { workspaceId: ctx.workspace.id, userId: ctx.user.id },
      ctx.workspace.name,
      { conversationId: parsed.data.conversationId, message: parsed.data.message },
      getAiProvider(),
    );
  });
}
