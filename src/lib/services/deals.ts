import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { AppError } from "@/lib/errors";
import { logActivity, type Scope } from "./common";
import { requireCampaign } from "./campaigns";
import { requireProspect } from "./prospects";

const d = schema.deals;
const money = z.number().int().min(0).nullish();

export const dealInputSchema = z.object({
  title: z.string().trim().min(1, "Enter a deal title").max(200),
  campaignId: z.string().uuid().nullish(),
  opportunityId: z.string().uuid().nullish(),
  estimatedValue: money,
  proposalValue: money,
});

export async function createDeal(scope: Scope, prospectId: string, input: unknown) {
  const parsed = dealInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError("validation", parsed.error.issues[0].message);
  const p = await requireProspect(scope, prospectId);
  let campaignId = parsed.data.campaignId ?? null;
  if (campaignId) {
    await requireCampaign(scope, campaignId);
  } else {
    // Default attribution: the prospect's campaign, if it belongs to exactly one.
    const camps = await db
      .select({ id: schema.campaignProspects.campaignId })
      .from(schema.campaignProspects)
      .where(eq(schema.campaignProspects.prospectId, prospectId))
      .limit(2);
    if (camps.length === 1) campaignId = camps[0].id;
  }
  if (parsed.data.opportunityId) {
    const [opp] = await db
      .select({ id: schema.opportunities.id })
      .from(schema.opportunities)
      .where(and(eq(schema.opportunities.id, parsed.data.opportunityId), eq(schema.opportunities.prospectId, prospectId)));
    if (!opp) throw new AppError("validation", "That opportunity does not belong to this prospect.");
  }
  const [row] = await db
    .insert(d)
    .values({
      workspaceId: scope.workspaceId,
      prospectId,
      campaignId,
      opportunityId: parsed.data.opportunityId ?? null,
      title: parsed.data.title,
      estimatedValue: parsed.data.estimatedValue ?? null,
      proposalValue: parsed.data.proposalValue ?? null,
      status: parsed.data.proposalValue != null ? "proposal" : "open",
      discoverySource: p.discoverySource,
      createdBy: scope.userId,
    })
    .returning();
  await logActivity(scope, { type: "deal_created", summary: `Created deal "${row.title}" for ${p.name}`, prospectId, campaignId });
  return row;
}

export const dealUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["open", "proposal", "won", "lost"]).optional(),
  estimatedValue: money,
  proposalValue: money,
  wonValue: money,
  campaignId: z.string().uuid().nullish(),
});

export async function updateDeal(scope: Scope, id: string, input: unknown) {
  const parsed = dealUpdateSchema.safeParse(input);
  if (!parsed.success) throw new AppError("validation", parsed.error.issues[0].message);
  const [before] = await db.select().from(d).where(and(eq(d.id, id), eq(d.workspaceId, scope.workspaceId)));
  if (!before) throw new AppError("not_found", "That deal was not found.");
  const patch = parsed.data;
  if (patch.campaignId) await requireCampaign(scope, patch.campaignId);
  const status = patch.status ?? before.status;
  if (status === "won") {
    const wonValue = patch.wonValue ?? before.wonValue;
    if (wonValue == null) throw new AppError("validation", "Enter the won value to mark this deal as won.");
  }
  const closing = (status === "won" || status === "lost") && before.status !== status;
  const [row] = await db
    .update(d)
    .set({
      ...patch,
      wonValue: status === "won" ? (patch.wonValue ?? before.wonValue) : null,
      closedAt: status === "won" || status === "lost" ? (closing ? new Date() : before.closedAt) : null,
      updatedAt: new Date(),
    })
    .where(eq(d.id, id))
    .returning();
  if (closing && status === "won") {
    await logActivity(scope, { type: "deal_won", summary: `Won deal "${row.title}"`, prospectId: row.prospectId, campaignId: row.campaignId });
  } else if (closing && status === "lost") {
    await logActivity(scope, { type: "deal_lost", summary: `Lost deal "${row.title}"`, prospectId: row.prospectId, campaignId: row.campaignId });
  }
  return row;
}

export async function deleteDeal(scope: Scope, id: string) {
  const res = await db.delete(d).where(and(eq(d.id, id), eq(d.workspaceId, scope.workspaceId))).returning({ id: d.id });
  if (res.length === 0) throw new AppError("not_found", "That deal was not found.");
}

export async function listDealsForProspect(scope: Scope, prospectId: string) {
  return db
    .select({
      id: d.id,
      title: d.title,
      status: d.status,
      estimatedValue: d.estimatedValue,
      proposalValue: d.proposalValue,
      wonValue: d.wonValue,
      campaignId: d.campaignId,
      campaignName: schema.campaigns.name,
      createdAt: d.createdAt,
    })
    .from(d)
    .leftJoin(schema.campaigns, eq(schema.campaigns.id, d.campaignId))
    .where(and(eq(d.prospectId, prospectId), eq(d.workspaceId, scope.workspaceId)))
    .orderBy(desc(d.createdAt));
}

export const dealValueSql = sql`coalesce(${d.proposalValue}, ${d.estimatedValue}, 0)`;
