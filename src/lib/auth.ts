import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, lt } from "drizzle-orm";
import { db, schema } from "@/db";
import { AppError } from "./errors";
import { env } from "./env";

export const SESSION_COOKIE = "vs_session";
export const WORKSPACE_COOKIE = "vs_ws";
const SESSION_DAYS = 14;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, userId), lt(schema.sessions.expiresAt, new Date())));
  await db.insert(schema.sessions).values({ userId, tokenHash: sha256(token), expiresAt });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env().APP_URL.startsWith("https://"),
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, sha256(token)));
  jar.delete(SESSION_COOKIE);
  jar.delete(WORKSPACE_COOKIE);
}

export async function getCurrentUser() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const rows = await db
    .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.tokenHash, sha256(token)), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export type Role = "owner" | "admin" | "member";
export interface Ctx {
  user: { id: string; email: string; name: string };
  workspace: { id: string; name: string; currency: string };
  role: Role;
}

/** Resolve the signed-in user and their active workspace. Membership is always verified server-side. */
export async function getContext(): Promise<Ctx | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const memberships = await db
    .select({ id: schema.workspaces.id, name: schema.workspaces.name, currency: schema.workspaces.currency, role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
    .where(eq(schema.workspaceMembers.userId, user.id))
    .orderBy(schema.workspaceMembers.createdAt);
  if (memberships.length === 0) return null;
  const wanted = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const m = memberships.find((x) => x.id === wanted) ?? memberships[0];
  return { user, workspace: { id: m.id, name: m.name, currency: m.currency }, role: m.role };
}

/** For pages and server actions: redirects to /login when unauthenticated. */
export async function requireContext(): Promise<Ctx> {
  const ctx = await getContext();
  if (!ctx) redirect("/login");
  return ctx;
}

/** For API routes: throws an AppError instead of redirecting. */
export async function requireApiContext(): Promise<Ctx> {
  const ctx = await getContext();
  if (!ctx) throw new AppError("unauthenticated", "Please sign in to continue.");
  return ctx;
}

export function requireAdmin(ctx: Ctx) {
  if (ctx.role === "member") throw new AppError("forbidden", "Only workspace owners and admins can do that.");
}
