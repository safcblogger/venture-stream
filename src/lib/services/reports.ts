import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { PIPELINE_STAGES } from "@/db/schema";
import type { Scope } from "./common";
import { listCampaigns } from "./campaigns";
import { listActivity } from "./prospects";
import { taskCounts, todayISO } from "./tasks";

const p = schema.prospects;
const d = schema.deals;

export async function dashboard(scope: Scope) {
  const ws = scope.workspaceId;
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [[pc], [oc], [dv], tasks, campaigns, recent, top] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        fresh: sql<number>`count(*) filter (where ${p.discoveredAt} >= ${weekAgo}::timestamptz)::int`,
        qualified: sql<number>`count(*) filter (where ${p.pipelineStage} = 'qualified')::int`,
      })
      .from(p)
      .where(eq(p.workspaceId, ws)),
    db
      .select({ active: sql<number>`count(*)::int` })
      .from(schema.opportunities)
      .where(sql`${schema.opportunities.workspaceId} = ${ws} and ${schema.opportunities.status} <> 'dismissed'`),
    db
      .select({
        pipeline: sql<number>`coalesce(sum(coalesce(${d.proposalValue}, ${d.estimatedValue}, 0)) filter (where ${d.status} in ('open','proposal')), 0)::float8`,
        revenue: sql<number>`coalesce(sum(${d.wonValue}) filter (where ${d.status} = 'won'), 0)::float8`,
        dealCount: sql<number>`count(*)::int`,
      })
      .from(d)
      .where(eq(d.workspaceId, ws)),
    taskCounts(scope),
    listCampaigns(scope),
    listActivity(scope, { limit: 10 }),
    db
      .select({ id: p.id, name: p.name, domain: p.domain, score: p.opportunityScore, stage: p.pipelineStage, platform: p.ecommercePlatform })
      .from(p)
      .where(sql`${p.workspaceId} = ${ws} and ${p.opportunityScore} is not null and ${p.pipelineStage} not in ('won','lost')`)
      .orderBy(desc(p.opportunityScore))
      .limit(6),
  ]);
  return {
    totalProspects: pc.total,
    newProspects: pc.fresh,
    qualifiedProspects: pc.qualified,
    activeOpportunities: oc.active,
    openTasks: tasks.open,
    overdueTasks: tasks.overdue,
    pipelineValue: dv.pipeline,
    revenue: dv.revenue,
    dealCount: dv.dealCount,
    campaigns: campaigns.slice(0, 5),
    recentActivity: recent,
    topProspects: top,
  };
}

export async function reports(scope: Scope) {
  const ws = scope.workspaceId;
  const campaigns = await listCampaigns(scope);
  const [sources, stages, categories] = await Promise.all([
    db
      .select({
        source: sql<string>`coalesce(${p.discoverySource}, 'unknown')`,
        prospects: sql<number>`count(distinct ${p.id})::int`,
        avgScore: sql<number | null>`(select round(avg(p2.opportunity_score))::int from prospects p2 where p2.workspace_id = ${ws} and p2.discovery_source = ${p.discoverySource})`,
        deals: sql<number>`count(${d.id})::int`,
        pipelineValue: sql<number>`coalesce(sum(coalesce(${d.proposalValue}, ${d.estimatedValue}, 0)) filter (where ${d.status} in ('open','proposal')), 0)::float8`,
        revenue: sql<number>`coalesce(sum(${d.wonValue}) filter (where ${d.status} = 'won'), 0)::float8`,
        biggestDeal: sql<number>`coalesce(max(coalesce(${d.proposalValue}, ${d.estimatedValue}, ${d.wonValue})), 0)::float8`,
      })
      .from(p)
      .leftJoin(d, eq(d.prospectId, p.id))
      .where(eq(p.workspaceId, ws))
      .groupBy(p.discoverySource)
      .orderBy(desc(sql`coalesce(sum(${d.wonValue}) filter (where ${d.status} = 'won'), 0)`), desc(sql`count(distinct ${p.id})`)),
    db
      .select({ stage: p.pipelineStage, count: sql<number>`count(*)::int` })
      .from(p)
      .where(eq(p.workspaceId, ws))
      .groupBy(p.pipelineStage),
    db
      .select({
        key: schema.opportunityCategories.key,
        label: schema.opportunityCategories.label,
        count: sql<number>`count(${schema.opportunities.id})::int`,
        avgScore: sql<number | null>`round(avg(${schema.opportunities.score}))::int`,
        value: sql<number>`coalesce(sum(${schema.opportunities.commercialValue}), 0)::float8`,
      })
      .from(schema.opportunityCategories)
      .leftJoin(
        schema.opportunities,
        sql`${schema.opportunities.categoryId} = ${schema.opportunityCategories.id} and ${schema.opportunities.status} <> 'dismissed'`,
      )
      .where(sql`${schema.opportunityCategories.workspaceId} = ${ws} and ${schema.opportunityCategories.active}`)
      .groupBy(schema.opportunityCategories.id)
      .orderBy(schema.opportunityCategories.sortOrder),
  ]);
  const stageMap = new Map(stages.map((s) => [s.stage, s.count]));
  return {
    campaigns,
    sources,
    funnel: PIPELINE_STAGES.map((s) => ({ stage: s, count: stageMap.get(s) ?? 0 })),
    categories,
    generatedFor: todayISO(),
  };
}
