import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { AppError } from "@/lib/errors";
import { logActivity, type Scope } from "./common";
import { assertMember } from "./prospects";

const c = schema.campaigns;

export const campaignInputSchema = z.object({
  name: z.string().trim().min(1, "Enter a campaign name").max(200),
  description: z.string().trim().max(4000).nullish(),
  status: z.enum(["draft", "active", "paused", "completed"]).default("draft"),
  targetCriteria: z.string().trim().max(2000).nullish(),
  revenueTarget: z.number().int().min(0).nullish(),
  ownerId: z.string().uuid().nullish(),
});

export async function createCampaign(scope: Scope, input: unknown) {
  const parsed = campaignInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError("validation", parsed.error.issues[0].message);
  const d = parsed.data;
  if (d.ownerId) await assertMember(scope.workspaceId, d.ownerId);
  const [row] = await db
    .insert(c)
    .values({
      workspaceId: scope.workspaceId,
      name: d.name,
      description: d.description || null,
      status: d.status,
      targetCriteria: d.targetCriteria || null,
      revenueTarget: d.revenueTarget ?? null,
      ownerId: d.ownerId ?? scope.userId,
    })
    .returning();
  await logActivity(scope, { type: "campaign_created", summary: `Created campaign "${row.name}"`, campaignId: row.id });
  return row;
}

export async function updateCampaign(scope: Scope, id: string, input: unknown) {
  const parsed = campaignInputSchema.partial().safeParse(input);
  if (!parsed.success) throw new AppError("validation", parsed.error.issues[0].message);
  if (parsed.data.ownerId) await assertMember(scope.workspaceId, parsed.data.ownerId);
  const [row] = await db
    .update(c)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(and(eq(c.id, id), eq(c.workspaceId, scope.workspaceId)))
    .returning();
  if (!row) throw new AppError("not_found", "That campaign was not found.");
  return row;
}

export async function deleteCampaign(scope: Scope, id: string) {
  const res = await db.delete(c).where(and(eq(c.id, id), eq(c.workspaceId, scope.workspaceId))).returning({ id: c.id });
  if (res.length === 0) throw new AppError("not_found", "That campaign was not found.");
}

export async function requireCampaign(scope: Scope, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new AppError("not_found", "That campaign was not found.");
  const [row] = await db.select().from(c).where(and(eq(c.id, id), eq(c.workspaceId, scope.workspaceId)));
  if (!row) throw new AppError("not_found", "That campaign was not found.");
  return row;
}

export async function addProspectsToCampaign(scope: Scope, campaignId: string, prospectIds: string[]) {
  const camp = await requireCampaign(scope, campaignId);
  const valid = await db
    .select({ id: schema.prospects.id, name: schema.prospects.name })
    .from(schema.prospects)
    .where(and(eq(schema.prospects.workspaceId, scope.workspaceId), inArray(schema.prospects.id, prospectIds.slice(0, 500))));
  if (valid.length === 0) return 0;
  const inserted = await db
    .insert(schema.campaignProspects)
    .values(valid.map((v) => ({ campaignId, prospectId: v.id, workspaceId: scope.workspaceId, addedBy: scope.userId })))
    .onConflictDoNothing()
    .returning({ prospectId: schema.campaignProspects.prospectId });
  const names = new Map(valid.map((v) => [v.id, v.name]));
  for (const r of inserted) {
    await logActivity(scope, {
      type: "campaign_prospect_added",
      summary: `Added ${names.get(r.prospectId)} to campaign "${camp.name}"`,
      prospectId: r.prospectId,
      campaignId,
    });
  }
  return inserted.length;
}

export async function removeProspectFromCampaign(scope: Scope, campaignId: string, prospectId: string) {
  await requireCampaign(scope, campaignId);
  await db
    .delete(schema.campaignProspects)
    .where(and(eq(schema.campaignProspects.campaignId, campaignId), eq(schema.campaignProspects.prospectId, prospectId)));
}

export interface CampaignMetrics {
  prospects: number;
  contacts: number;
  opportunities: number;
  proposals: number;
  won: number;
  pipelineValue: number;
  revenue: number;
}

export type CampaignRow = {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "paused" | "completed";
  targetCriteria: string | null;
  revenueTarget: number | null;
  ownerId: string | null;
  ownerName: string | null;
  createdAt: Date;
} & CampaignMetrics;

/** All campaign metrics are aggregates over stored rows; deals attribute via deals.campaign_id. */
export async function listCampaigns(scope: Scope, opts: { campaignId?: string } = {}): Promise<CampaignRow[]> {
  const conds = [eq(c.workspaceId, scope.workspaceId)];
  if (opts.campaignId) conds.push(eq(c.id, opts.campaignId));
  return db
    .select({
      id: c.id,
      name: c.name,
      description: c.description,
      status: c.status,
      targetCriteria: c.targetCriteria,
      revenueTarget: c.revenueTarget,
      ownerId: c.ownerId,
      ownerName: schema.users.name,
      createdAt: c.createdAt,
      prospects: sql<number>`(select count(*)::int from campaign_prospects cp where cp.campaign_id = ${c.id})`,
      contacts: sql<number>`(select count(*)::int from contacts ct join campaign_prospects cp on cp.prospect_id = ct.prospect_id where cp.campaign_id = ${c.id})`,
      opportunities: sql<number>`(select count(*)::int from opportunities o join campaign_prospects cp on cp.prospect_id = o.prospect_id where cp.campaign_id = ${c.id} and o.status <> 'dismissed')`,
      proposals: sql<number>`(select count(*)::int from deals d where d.campaign_id = ${c.id} and (d.status in ('proposal','won') or d.proposal_value is not null))`,
      won: sql<number>`(select count(*)::int from deals d where d.campaign_id = ${c.id} and d.status = 'won')`,
      pipelineValue: sql<number>`(select coalesce(sum(coalesce(d.proposal_value, d.estimated_value, 0)), 0)::bigint from deals d where d.campaign_id = ${c.id} and d.status in ('open','proposal'))::float8`,
      revenue: sql<number>`(select coalesce(sum(d.won_value), 0)::bigint from deals d where d.campaign_id = ${c.id} and d.status = 'won')::float8`,
    })
    .from(c)
    .leftJoin(schema.users, eq(schema.users.id, c.ownerId))
    .where(and(...conds))
    .orderBy(desc(c.createdAt));
}

export async function campaignProspectsList(scope: Scope, campaignId: string) {
  await requireCampaign(scope, campaignId);
  return db
    .select({
      id: schema.prospects.id,
      name: schema.prospects.name,
      domain: schema.prospects.domain,
      stage: schema.prospects.pipelineStage,
      score: schema.prospects.opportunityScore,
      addedAt: schema.campaignProspects.addedAt,
    })
    .from(schema.campaignProspects)
    .innerJoin(schema.prospects, eq(schema.prospects.id, schema.campaignProspects.prospectId))
    .where(and(eq(schema.campaignProspects.campaignId, campaignId), eq(schema.prospects.workspaceId, scope.workspaceId)))
    .orderBy(desc(schema.prospects.opportunityScore));
}

export async function campaignsForProspect(scope: Scope, prospectId: string) {
  return db
    .select({ id: c.id, name: c.name, status: c.status, addedAt: schema.campaignProspects.addedAt })
    .from(schema.campaignProspects)
    .innerJoin(c, eq(c.id, schema.campaignProspects.campaignId))
    .where(and(eq(schema.campaignProspects.prospectId, prospectId), eq(c.workspaceId, scope.workspaceId)))
    .orderBy(desc(schema.campaignProspects.addedAt));
}
