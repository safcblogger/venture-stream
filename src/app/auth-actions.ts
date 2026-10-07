"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSession, destroySession, getContext } from "@/lib/auth";
import { AppError, toUserMessage } from "@/lib/errors";
import { authenticate, checkLoginThrottle, clearLoginFailures, recordLoginFailure, registerAccount } from "@/lib/services/accounts";
import { db, schema } from "@/db";
import { env } from "@/lib/env";

export type AuthState = { error: string } | null;

const field = (fd: FormData, k: string) => (typeof fd.get(k) === "string" ? (fd.get(k) as string) : "");

async function clientKeys(email: string) {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  // The per-email key cannot be bypassed by spoofing the forwarded IP; its higher limit limits lock-out abuse.
  return { pair: `${ip}|${email.toLowerCase()}`, email: `email|${email.toLowerCase()}` };
}

export async function loginAction(_prev: AuthState, fd: FormData): Promise<AuthState> {
  const email = field(fd, "email").trim();
  const password = field(fd, "password");
  try {
    const keys = await clientKeys(email);
    checkLoginThrottle(keys.pair);
    checkLoginThrottle(keys.email, Date.now(), 25);
    const user = email && password ? await authenticate(email, password) : null;
    if (!user) {
      recordLoginFailure(keys.pair);
      recordLoginFailure(keys.email);
      throw new AppError("unauthenticated", "That email and password don't match.");
    }
    clearLoginFailures(keys.pair);
    clearLoginFailures(keys.email);
    await createSession(user.id);
    await db.insert(schema.auditLog).values({ userId: user.id, action: "auth.login" });
  } catch (err) {
    return { error: toUserMessage(err).message };
  }
  redirect("/");
}

export async function registerAction(_prev: AuthState, fd: FormData): Promise<AuthState> {
  try {
    if (env().ALLOW_REGISTRATION === "false") throw new AppError("forbidden", "Sign-up is closed. Ask a workspace owner for an invitation.");
    const { user } = await registerAccount({
      name: field(fd, "name"),
      email: field(fd, "email"),
      password: field(fd, "password"),
      workspaceName: field(fd, "workspaceName"),
    });
    await createSession(user.id);
  } catch (err) {
    return { error: toUserMessage(err).message };
  }
  redirect("/");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

export async function redirectIfSignedIn() {
  if (await getContext()) redirect("/");
}
