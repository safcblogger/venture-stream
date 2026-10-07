import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { AppError } from "@/lib/errors";
import { clampPage, logActivity, type Page, type Scope } from "./common";
import { recomputeScore, requireProspect } from "./prospects";

const o = schema.opportunities;
const c = schema.opportunityCategories;

export async function listOpportunities(
  scope: Scope,
  f: { categoryKey?: string; status?: "identified" | "pursuing" | "dismissed"; minScore?: number; prospectId?: string; page?: number; pageSize?: number } = {},
): Promise<Page<OpportunityRow>> {
  const { page, pageSize, offset } = clampPage(f.page, f.pageSize);
  const conds = [eq(o.workspaceId, scope.workspaceId)];
  if (f.categoryKey) conds.push(eq(c.key, f.categoryKey));
  if (f.status) conds.push(eq(o.status, f.status));
  else conds.push(sql`${o.status} <> 'dismissed'`);
  if (f.minScore !== undefined) conds.push(sql`${o.score} >= ${f.minScore}`);
  if (f.prospectId) conds.push(eq(o.prospectId, f.prospectId));
  const where = and(...conds);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: o.id,
        prospectId: o.prospectId,
        prospectName: schema.prospects.name,
        categoryKey: c.key,
        categoryLabel: c.label,
        score: o.score,
        description: o.description,
        evidence: o.evidence,
        importance: o.importance,
        potentialImpact: o.potentialImpact,
        commercialValue: o.commercialValue,
        recommendedAction: o.recommendedAction,
        status: o.status,
        origin: o.origin,
        createdAt: o.createdAt,
      })
      .from(o)
      .innerJoin(c, eq(c.id, o.categoryId))
      .innerJoin(schema.prospects, eq(schema.prospects.id, o.prospectId))
      .where(where)
      .orderBy(desc(o.score), desc(o.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(o)
      .innerJoin(c, eq(c.id, o.categoryId))
      .where(where),
  ]);
  return { rows, total, page, pageSize };
}

export type OpportunityRow = {
  id: string;
  prospectId: string;
  prospectName: string;
  categoryKey: string;
  categoryLabel: string;
  score: number;
  description: string;
  evidence: { text: string; sourceUrl?: string | null }[];
  importance: "low" | "medium" | "high";
  potentialImpact: string | null;
  commercialValue: number | null;
  recommendedAction: string | null;
  status: "identified" | "pursuing" | "dismissed";
  origin: string;
  createdAt: Date;
};

export const upsertOpportunitySchema = z.object({
  categoryKey: z.string().min(1),
  score: z.number().int().min(0).max(100),
  description: z.string().trim().min(1).max(2000),
  evidence: z.array(z.object({ text: z.string().trim().min(1).max(1000), sourceUrl: z.string().url().nullish() })).min(1, "An opportunity needs at least one piece of evidence"),
  importance: z.enum(["low", "medium", "high"]).default("medium"),
  potentialImpact: z.string().trim().max(1000).nullish(),
  commercialValue: z.number().int().min(0).nullish(),
  recommendedAction: z.string().trim().max(1000).nullish(),
  origin: z.enum(["ai", "manual"]).default("manual"),
});

/** Create or update the single opportunity of a category on a prospect. Dismissed opportunities stay dismissed. */
export async function upsertOpportunity(scope: Scope, prospectId: string, input: unknown, opts: { attributeToUser?: boolean } = {}) {
  const parsed = upsertOpportunitySchema.safeParse(input);
  if (!parsed.success) throw new AppError("validation", parsed.error.issues[0].message);
  const d = parsed.data;
  const prospect = await requireProspect(scope, prospectId);
  const [cat] = await db
    .select()
    .from(c)
    .where(and(eq(c.workspaceId, scope.workspaceId), eq(c.key, d.categoryKey), eq(c.active, true)));
  if (!cat) throw new AppError("validation", `Unknown opportunity category "${d.categoryKey}".`);
  const values = {
    workspaceId: scope.workspaceId,
    prospectId,
    categoryId: cat.id,
    score: d.score,
    description: d.description,
    evidence: d.evidence,
    importance: d.importance,
    potentialImpact: d.potentialImpact ?? null,
    commercialValue: d.commercialValue ?? null,
    recommendedAction: d.recommendedAction ?? null,
    origin: d.origin,
  };
  const [existing] = await db.select({ id: o.id }).from(o).where(and(eq(o.prospectId, prospectId), eq(o.categoryId, cat.id)));
  let row;
  if (existing) {
    [row] = await db.update(o).set({ ...values, updatedAt: new Date() }).where(eq(o.id, existing.id)).returning();
  } else {
    [row] = await db.insert(o).values(values).returning();
    await logActivity(
      scope,
      { type: "opportunity_identified", summary: `${cat.label} opportunity identified for ${prospect.name} (score ${d.score})`, prospectId, attributeToUser: opts.attributeToUser },
    );
  }
  await recomputeScore(scope.workspaceId, prospectId);
  return row;
}

export async function setOpportunityStatus(scope: Scope, id: string, status: "identified" | "pursuing" | "dismissed") {
  const [row] = await db
    .update(o)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(o.id, id), eq(o.workspaceId, scope.workspaceId)))
    .returning();
  if (!row) throw new AppError("not_found", "That opportunity was not found.");
  await recomputeScore(scope.workspaceId, row.prospectId);
  return row;
}
