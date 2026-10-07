import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";

export type SecretName = "openai_api_key" | "tavily_api_key";
export const SECRET_NAMES: SecretName[] = ["openai_api_key", "tavily_api_key"];

function key(): Buffer {
  // SECRETS_KEY is preferred. Fallback: derive from DATABASE_URL so local setups work with zero config.
  const material = process.env.SECRETS_KEY || `venture-stream|${process.env.DATABASE_URL ?? ""}`;
  return createHash("sha256").update(material).digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

export function decrypt(payload: string): string {
  const [iv, tag, enc] = payload.split(".").map((p) => Buffer.from(p, "base64"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

/** Remove whitespace and control characters that terminals/browsers sometimes add when pasting. */
export function cleanSecret(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\s\u0000-\u001f\u007f]/g, "");
}

export async function setSecret(workspaceId: string, userId: string, name: SecretName, value: string) {
  const v = cleanSecret(value);
  await db
    .insert(schema.workspaceSecrets)
    .values({ workspaceId, name, ciphertext: encrypt(v), last4: v.slice(-4), updatedBy: userId })
    .onConflictDoUpdate({
      target: [schema.workspaceSecrets.workspaceId, schema.workspaceSecrets.name],
      set: { ciphertext: encrypt(v), last4: v.slice(-4), updatedBy: userId, updatedAt: new Date() },
    });
}

export async function deleteSecret(workspaceId: string, name: SecretName) {
  await db.delete(schema.workspaceSecrets).where(and(eq(schema.workspaceSecrets.workspaceId, workspaceId), eq(schema.workspaceSecrets.name, name)));
}

/** Decrypted value for server-side use only. Returns null if unset or undecryptable (e.g. SECRETS_KEY changed). */
export async function getSecret(workspaceId: string, name: SecretName): Promise<string | null> {
  const [row] = await db
    .select({ ciphertext: schema.workspaceSecrets.ciphertext })
    .from(schema.workspaceSecrets)
    .where(and(eq(schema.workspaceSecrets.workspaceId, workspaceId), eq(schema.workspaceSecrets.name, name)));
  if (!row) return null;
  try {
    return decrypt(row.ciphertext);
  } catch {
    return null;
  }
}

/** For the Settings screen: where each key comes from and its last 4 characters. Never the key itself. */
export async function secretStatus(workspaceId: string) {
  const rows = await db
    .select({ name: schema.workspaceSecrets.name, last4: schema.workspaceSecrets.last4 })
    .from(schema.workspaceSecrets)
    .where(eq(schema.workspaceSecrets.workspaceId, workspaceId));
  const envHas: Record<SecretName, boolean> = { openai_api_key: Boolean(process.env.OPENAI_API_KEY), tavily_api_key: Boolean(process.env.TAVILY_API_KEY) };
  return Object.fromEntries(
    SECRET_NAMES.map((n) => {
      const row = rows.find((r) => r.name === n);
      return [n, row ? { source: "app" as const, last4: row.last4 } : envHas[n] ? { source: "env" as const, last4: null } : { source: null, last4: null }];
    }),
  ) as Record<SecretName, { source: "app" | "env" | null; last4: string | null }>;
}
