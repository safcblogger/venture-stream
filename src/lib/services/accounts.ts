import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { db, schema } from "@/db";
import { AppError } from "@/lib/errors";
import { DEFAULT_CATEGORIES, findUserByEmail, registerSchema } from "./workspaces";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, saltHex, keyHex] = stored.split("$");
  if (alg !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length, SCRYPT);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Creates the user, their workspace, the owner membership and the default category set atomically. */
export async function registerAccount(input: unknown) {
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) throw new AppError("validation", parsed.error.issues[0].message);
  const { name, email, password, workspaceName } = parsed.data;
  if (await findUserByEmail(email)) {
    throw new AppError("conflict", "An account with that email already exists. Try signing in instead.");
  }
  const passwordHash = await hashPassword(password);
  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx.insert(schema.users).values({ name, email, passwordHash }).returning();
      const [ws] = await tx.insert(schema.workspaces).values({ name: workspaceName, createdBy: user.id }).returning();
      await tx.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner" });
      await tx.insert(schema.opportunityCategories).values(
        DEFAULT_CATEGORIES.map((c, i) => ({ ...c, workspaceId: ws.id, sortOrder: i })),
      );
      await tx.insert(schema.auditLog).values({ workspaceId: ws.id, userId: user.id, action: "account.registered" });
      return { user, workspace: ws };
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new AppError("conflict", "An account with that email already exists. Try signing in instead.");
    }
    throw err;
  }
}

/* Simple in-process login throttle. For multi-instance deployments put a shared limiter (e.g. at the proxy) in front. */
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 8;

export function checkLoginThrottle(key: string, now = Date.now(), max = MAX_ATTEMPTS) {
  const entry = attempts.get(key);
  if (entry && entry.resetAt > now && entry.count >= max) {
    throw new AppError("rate_limit", "Too many sign-in attempts. Please wait a few minutes and try again.");
  }
}
export function recordLoginFailure(key: string, now = Date.now()) {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count++;
}
export function clearLoginFailures(key: string) {
  attempts.delete(key);
}

const DUMMY_HASH = "scrypt$00000000000000000000000000000000$" + "00".repeat(64);

/** Returns the user on success, null on bad credentials. Timing is equalised for unknown emails. */
export async function authenticate(email: string, password: string) {
  const user = await findUserByEmail(email.trim());
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  return user && ok ? user : null;
}
