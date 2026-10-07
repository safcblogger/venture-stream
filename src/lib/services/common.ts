import { sql } from "drizzle-orm";
import { db, schema } from "@/db";

/** Every service call is scoped to one workspace and acting user. Services never trust ids from clients without this scope. */
export interface Scope {
  workspaceId: string;
  userId: string;
}

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function clampPage(page?: number, pageSize?: number, max = 100) {
  const size = Math.min(Math.max(Math.trunc(pageSize ?? 25), 1), max);
  const p = Math.max(Math.trunc(page ?? 1), 1);
  return { page: p, pageSize: size, offset: (p - 1) * size };
}

/** Escape LIKE wildcards so user input is matched literally. */
export function likePattern(q: string) {
  return `%${q.trim().replace(/[\\%_]/g, (c) => "\\" + c)}%`;
}

export type Executor = Pick<typeof db, "insert" | "select" | "update" | "delete">;

export async function logActivity(
  scope: Scope,
  entry: {
    type: string;
    summary: string;
    prospectId?: string | null;
    campaignId?: string | null;
    metadata?: unknown;
    /** Set false for system-generated activity (research jobs). */
    attributeToUser?: boolean;
  },
  exec: Executor = db,
) {
  await exec.insert(schema.activities).values({
    workspaceId: scope.workspaceId,
    userId: entry.attributeToUser === false ? null : scope.userId,
    type: entry.type,
    summary: entry.summary,
    prospectId: entry.prospectId ?? null,
    campaignId: entry.campaignId ?? null,
    metadata: entry.metadata ?? null,
  });
}

export const sqlCount = sql<number>`count(*)::int`;

/** Normalise a user-supplied website into { website, domain } or null if unusable. */
export function parseWebsite(input: string): { website: string; domain: string } | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!url.hostname.includes(".")) return null;
    const domain = url.hostname.toLowerCase().replace(/^www\./, "");
    return { website: `${url.protocol}//${url.hostname}`, domain };
  } catch {
    return null;
  }
}
