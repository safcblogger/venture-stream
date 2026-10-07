import "server-only";
import { NextResponse } from "next/server";
import { AppError, toUserMessage } from "./errors";
import { env } from "./env";

/** Reject cross-site state-changing requests. SameSite=Lax cookies are the first line; this is the second. */
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return; // same-origin fetches from older browsers omit it; non-browser clients have no ambient cookies
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let allowed = false;
  try {
    const o = new URL(origin);
    allowed = o.host === host || o.host === new URL(env().APP_URL).host;
  } catch {
    allowed = false;
  }
  if (!allowed) throw new AppError("forbidden", "Cross-site request blocked.");
}

export async function apiHandler(fn: () => Promise<unknown>) {
  try {
    return NextResponse.json(await fn());
  } catch (err) {
    const { message, status } = toUserMessage(err);
    return NextResponse.json({ error: message }, { status });
  }
}
