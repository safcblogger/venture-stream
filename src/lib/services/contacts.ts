import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { AppError } from "@/lib/errors";
import { clampPage, likePattern, logActivity, type Page, type Scope } from "./common";
import { requireProspect } from "./prospects";

const ct = schema.contacts;

/** Classify a job title into decision-maker relevance. Pure rules, no guessing beyond the stated title. */
export function relevanceForTitle(title: string | null | undefined): "primary" | "relevant" | "other" {
  const t = (title ?? "").toLowerCase();
  if (!t) return "other";
  if (/\b(founder|co-?founder|ceo|chief executive|managing director|owner|chief marketing|cmo|marketing director|head of marketing|digital director|head of digital|head of e-?commerce|e-?commerce director|director of e-?commerce|vp (of )?marketing)\b/.test(t)) return "primary";
  if (/\b(e-?commerce|seo|marketing|digital|growth|acquisition|content|trading|brand)\b/.test(t) && /\b(manager|lead|head|director|specialist|executive)\b/.test(t)) return "relevant";
  return "other";
}

export const contactInputSchema = z.object({
  name: z.string().trim().min(1, "Enter the person's name").max(200),
  jobTitle: z.string().trim().max(200).nullish(),
  email: z.string().trim().email("Enter a valid email address").max(254).nullish().or(z.literal("")),
  linkedinUrl: z
    .string()
    .trim()
    .url("Enter a valid LinkedIn URL")
    .refine((u) => /^https?:\/\/([a-z0-9-]+\.)?linkedin\.com\//i.test(u), "Enter a LinkedIn URL")
    .nullish()
    .or(z.literal("")),
  sourceType: z.enum(["manual", "research"]).default("manual"),
  sourceUrl: z.string().url().nullish(),
  confidence: z.enum(["low", "medium", "high"]).nullish(),
});

export async function addContact(scope: Scope, prospectId: string, input: unknown, opts: { attributeToUser?: boolean } = {}) {
  const parsed = contactInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError("validation", parsed.error.issues[0].message);
  const d = parsed.data;
  const prospect = await requireProspect(scope, prospectId);
  const [dup] = await db
    .select({ id: ct.id })
    .from(ct)
    .where(and(eq(ct.prospectId, prospectId), sql`lower(${ct.name}) = ${d.name.toLowerCase()}`));
  if (dup) throw new AppError("conflict", `${d.name} is already a contact for ${prospect.name}.`);
  const [row] = await db
    .insert(ct)
    .values({
      workspaceId: scope.workspaceId,
      prospectId,
      name: d.name,
      jobTitle: d.jobTitle || null,
      email: d.email || null,
      linkedinUrl: d.linkedinUrl || null,
      sourceType: d.sourceType,
      sourceUrl: d.sourceUrl ?? null,
      confidence: d.confidence ?? (d.sourceType === "manual" ? "high" : null),
      relevance: relevanceForTitle(d.jobTitle),
    })
    .returning();
  await logActivity(scope, {
    type: "contact_discovered",
    summary: `${d.sourceType === "research" ? "Found" : "Added"} contact ${row.name}${row.jobTitle ? ` (${row.jobTitle})` : ""} at ${prospect.name}`,
    prospectId,
    attributeToUser: opts.attributeToUser,
  });
  return row;
}

export async function deleteContact(scope: Scope, id: string) {
  const res = await db.delete(ct).where(and(eq(ct.id, id), eq(ct.workspaceId, scope.workspaceId))).returning({ id: ct.id });
  if (res.length === 0) throw new AppError("not_found", "That contact was not found.");
}

export async function listContactsForProspect(scope: Scope, prospectId: string) {
  return db
    .select()
    .from(ct)
    .where(and(eq(ct.prospectId, prospectId), eq(ct.workspaceId, scope.workspaceId)))
    .orderBy(sql`case ${ct.relevance} when 'primary' then 0 when 'relevant' then 1 else 2 end`, ct.name);
}

export async function listContacts(
  scope: Scope,
  f: { q?: string; relevance?: "primary" | "relevant" | "other"; uncontactedOnly?: boolean; page?: number; pageSize?: number } = {},
): Promise<Page<ContactRow>> {
  const { page, pageSize, offset } = clampPage(f.page, f.pageSize);
  const conds = [eq(ct.workspaceId, scope.workspaceId)];
  if (f.q?.trim()) {
    const like = likePattern(f.q);
    conds.push(or(ilike(ct.name, like), ilike(ct.jobTitle, like), ilike(schema.prospects.name, like))!);
  }
  if (f.relevance) conds.push(eq(ct.relevance, f.relevance));
  if (f.uncontactedOnly) conds.push(sql`${ct.lastContactedAt} is null`);
  const where = and(...conds);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: ct.id,
        prospectId: ct.prospectId,
        prospectName: schema.prospects.name,
        name: ct.name,
        jobTitle: ct.jobTitle,
        email: ct.email,
        linkedinUrl: ct.linkedinUrl,
        sourceType: ct.sourceType,
        sourceUrl: ct.sourceUrl,
        confidence: ct.confidence,
        relevance: ct.relevance,
        lastContactedAt: ct.lastContactedAt,
      })
      .from(ct)
      .innerJoin(schema.prospects, eq(schema.prospects.id, ct.prospectId))
      .where(where)
      .orderBy(sql`case ${ct.relevance} when 'primary' then 0 when 'relevant' then 1 else 2 end`, desc(ct.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(ct)
      .innerJoin(schema.prospects, eq(schema.prospects.id, ct.prospectId))
      .where(where),
  ]);
  return { rows, total, page, pageSize };
}

export type ContactRow = {
  id: string;
  prospectId: string;
  prospectName: string;
  name: string;
  jobTitle: string | null;
  email: string | null;
  linkedinUrl: string | null;
  sourceType: string;
  sourceUrl: string | null;
  confidence: "low" | "medium" | "high" | null;
  relevance: "primary" | "relevant" | "other";
  lastContactedAt: Date | null;
};
