import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { PIPELINE_STAGES } from "@/db/schema";
import type { ToolDefinition } from "@/lib/providers/ai";
import type { Scope } from "@/lib/services/common";
import { listCampaigns } from "@/lib/services/campaigns";
import { listOpportunities } from "@/lib/services/opportunities";
import { getProspect, listActivity, listFacts, listProspects } from "@/lib/services/prospects";
import { reports } from "@/lib/services/reports";
import { listTasks, todayISO } from "@/lib/services/tasks";
import { listContactsForProspect } from "@/lib/services/contacts";
import { listDealsForProspect } from "@/lib/services/deals";

export interface EntityRef {
  type: "prospect" | "campaign";
  id: string;
  name: string;
}

export interface ToolOutput {
  data: unknown;
  entities: EntityRef[];
}

const date = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);

const searchArgs = z.object({
  query: z.string().optional(),
  stage: z.enum(PIPELINE_STAGES).optional(),
  platform: z.string().optional(),
  category_key: z.string().optional(),
  min_score: z.number().int().min(0).max(100).optional(),
  has_decision_maker: z.boolean().optional(),
  contacted: z.boolean().optional(),
  discovered_within_days: z.number().int().min(1).max(365).optional(),
  campaign_id: z.string().uuid().optional(),
  sort: z.enum(["score", "created", "last_contacted", "value"]).default("score"),
  limit: z.number().int().min(1).max(15).default(10),
});

const idArgs = z.object({ prospect_id: z.string().uuid().optional(), name: z.string().optional() });
const oppArgs = z.object({
  category_key: z.string().optional(),
  min_score: z.number().int().min(0).max(100).optional(),
  not_contacted_for_days: z.number().int().min(0).max(365).optional(),
  limit: z.number().int().min(1).max(15).default(10),
});
const taskArgs = z.object({ view: z.enum(["today", "upcoming", "overdue", "completed", "all"]).default("all"), limit: z.number().int().min(1).max(25).default(15) });
const limitArgs = z.object({ limit: z.number().int().min(1).max(25).default(10) });

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "search_prospects",
    description: "Search and rank the workspace's prospects. Use for any question about which prospects match some criteria (best prospects, decision makers, not contacted, discovered recently, by platform, stage or category).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text match on name, domain, industry, location or description" },
        stage: { type: "string", enum: [...PIPELINE_STAGES] },
        platform: { type: "string", description: "Ecommerce platform, e.g. Shopify" },
        category_key: { type: "string", description: "Opportunity category key such as technical_seo, ecommerce_seo, content, organic_visibility, ai_visibility, digital_pr, link_acquisition, conversion, website, analytics" },
        min_score: { type: "integer" },
        has_decision_maker: { type: "boolean", description: "true: only prospects with at least one primary/relevant contact" },
        contacted: { type: "boolean", description: "true: already contacted; false: never contacted" },
        discovered_within_days: { type: "integer" },
        campaign_id: { type: "string" },
        sort: { type: "string", enum: ["score", "created", "last_contacted", "value"] },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "get_prospect",
    description: "Full detail for one prospect: research facts, opportunities, contacts, open tasks and deals. Provide prospect_id (preferred) or name.",
    parameters: { type: "object", properties: { prospect_id: { type: "string" }, name: { type: "string" } } },
  },
  {
    name: "list_opportunities",
    description: "Ranked opportunities across prospects. Use not_contacted_for_days to find opportunities that have not been followed up (prospect never contacted or last contacted longer ago).",
    parameters: {
      type: "object",
      properties: {
        category_key: { type: "string" },
        min_score: { type: "integer" },
        not_contacted_for_days: { type: "integer" },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "list_tasks",
    description: "Tasks in the workspace by view (today, upcoming, overdue, completed, all).",
    parameters: { type: "object", properties: { view: { type: "string", enum: ["today", "upcoming", "overdue", "completed", "all"] }, limit: { type: "integer" } } },
  },
  {
    name: "campaign_performance",
    description: "Every campaign with prospects, contacts, opportunities, proposals, won deals, pipeline value and revenue.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "pipeline_summary",
    description: "Prospect counts per pipeline stage plus total open pipeline value and won revenue.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "source_performance",
    description: "Which prospect discovery sources produce the highest-value opportunities and revenue.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "work_today",
    description: "Inputs for 'what should I work on today': overdue tasks, tasks due today, prospects whose next action is due, and top-scoring uncontacted prospects that have decision makers.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "overdue_followups",
    description: "Prospects with overdue tasks or an overdue next action, including their contacts and top opportunity, for drafting follow-ups.",
    parameters: { type: "object", properties: { limit: { type: "integer" } } },
  },
  {
    name: "recent_activity",
    description: "Most recent activity events in the workspace.",
    parameters: { type: "object", properties: { limit: { type: "integer" } } },
  },
];

const prospectRef = (p: { id: string; name: string }): EntityRef => ({ type: "prospect", id: p.id, name: p.name });

export async function runTool(scope: Scope, name: string, rawArgs: string): Promise<ToolOutput> {
  let args: unknown = {};
  try {
    args = rawArgs?.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return { data: { error: "Invalid tool arguments." }, entities: [] };
  }
  try {
    switch (name) {
      case "search_prospects": {
        const a = searchArgs.parse(args);
        const res = await listProspects(scope, {
          q: a.query,
          stage: a.stage,
          platform: a.platform,
          categoryKey: a.category_key,
          minScore: a.min_score,
          hasDecisionMaker: a.has_decision_maker,
          contacted: a.contacted,
          campaignId: a.campaign_id,
          discoveredSince: a.discovered_within_days ? new Date(Date.now() - a.discovered_within_days * 86_400_000) : undefined,
          sort: a.sort === "last_contacted" ? "last_contacted" : a.sort,
          dir: "desc",
          pageSize: a.limit,
        });
        return {
          data: {
            totalMatching: res.total,
            showing: res.rows.length,
            prospects: res.rows.map((r) => ({
              id: r.id,
              name: r.name,
              domain: r.domain,
              opportunityScore: r.opportunityScore,
              stage: r.pipelineStage,
              ecommercePlatform: r.ecommercePlatform,
              opportunityCategories: r.categories,
              contactCount: r.contactCount,
              lastContacted: date(r.lastContactedAt),
              discovered: date(r.createdAt),
              estimatedValue: r.estimatedValue,
              researched: r.researchStatus === "done",
              link: `/prospects/${r.id}`,
            })),
          },
          entities: res.rows.map(prospectRef),
        };
      }
      case "get_prospect": {
        const a = idArgs.parse(args);
        let id = a.prospect_id;
        if (!id && a.name) {
          const found = await listProspects(scope, { q: a.name, pageSize: 3, sort: "score" });
          const exact = found.rows.find((r) => r.name.toLowerCase() === a.name!.toLowerCase()) ?? found.rows[0];
          id = exact?.id;
        }
        const prospect = id ? await getProspect(scope, id) : null;
        if (!prospect) return { data: { error: "No matching prospect." }, entities: [] };
        const [facts, opps, contacts, tasks, deals] = await Promise.all([
          listFacts(scope, prospect.id),
          listOpportunities(scope, { prospectId: prospect.id, pageSize: 10 }),
          listContactsForProspect(scope, prospect.id),
          listTasks(scope, { prospectId: prospect.id, view: "all", pageSize: 10 }),
          listDealsForProspect(scope, prospect.id),
        ]);
        return {
          data: {
            id: prospect.id,
            name: prospect.name,
            domain: prospect.domain,
            link: `/prospects/${prospect.id}`,
            industry: prospect.industry,
            location: prospect.location,
            description: prospect.description,
            ecommercePlatform: prospect.ecommercePlatform,
            opportunityScore: prospect.opportunityScore,
            stage: prospect.pipelineStage,
            leadStatus: prospect.leadStatus,
            assignedTo: prospect.assignedName,
            lastContacted: date(prospect.lastContactedAt),
            nextAction: prospect.nextAction,
            nextActionDue: prospect.nextActionAt,
            facts: facts.filter((f) => f.value).map((f) => ({ label: f.label, value: f.value, provenance: f.provenance })),
            opportunities: opps.rows.map((o) => ({ category: o.categoryLabel, score: o.score, description: o.description, evidence: o.evidence.map((e) => e.text), recommendedAction: o.recommendedAction })),
            contacts: contacts.map((c) => ({ name: c.name, jobTitle: c.jobTitle, relevance: c.relevance, hasEmail: !!c.email, linkedin: c.linkedinUrl })),
            tasks: tasks.rows.map((t) => ({ title: t.title, status: t.status, due: t.dueDate })),
            deals: deals.map((d) => ({ title: d.title, status: d.status, estimatedValue: d.estimatedValue, proposalValue: d.proposalValue, wonValue: d.wonValue })),
          },
          entities: [prospectRef(prospect)],
        };
      }
      case "list_opportunities": {
        const a = oppArgs.parse(args);
        const res = await listOpportunities(scope, { categoryKey: a.category_key, minScore: a.min_score, pageSize: 100 });
        let rows = res.rows;
        if (a.not_contacted_for_days !== undefined) {
          const ids = [...new Set(rows.map((r) => r.prospectId))];
          const contacted = ids.length
            ? await db
                .select({ id: schema.prospects.id, last: schema.prospects.lastContactedAt })
                .from(schema.prospects)
                .where(and(eq(schema.prospects.workspaceId, scope.workspaceId), inArray(schema.prospects.id, ids)))
            : [];
          const cutoff = Date.now() - a.not_contacted_for_days * 86_400_000;
          const stale = new Set(contacted.filter((c) => !c.last || c.last.getTime() < cutoff).map((c) => c.id));
          rows = rows.filter((r) => stale.has(r.prospectId));
        }
        rows = rows.slice(0, a.limit);
        return {
          data: {
            opportunities: rows.map((o) => ({
              prospect: o.prospectName,
              prospectId: o.prospectId,
              link: `/prospects/${o.prospectId}`,
              category: o.categoryLabel,
              score: o.score,
              description: o.description,
              recommendedAction: o.recommendedAction,
              status: o.status,
            })),
          },
          entities: rows.map((o) => prospectRef({ id: o.prospectId, name: o.prospectName })),
        };
      }
      case "list_tasks": {
        const a = taskArgs.parse(args);
        const res = await listTasks(scope, { view: a.view, pageSize: a.limit });
        return {
          data: {
            today: todayISO(),
            total: res.total,
            tasks: res.rows.map((t) => ({ title: t.title, due: t.dueDate, priority: t.priority, status: t.status, assignedTo: t.assignedName, prospect: t.prospectName, prospectId: t.prospectId, campaign: t.campaignName })),
          },
          entities: res.rows.filter((t) => t.prospectId).map((t) => prospectRef({ id: t.prospectId!, name: t.prospectName! })),
        };
      }
      case "campaign_performance": {
        const rows = await listCampaigns(scope);
        return {
          data: { campaigns: rows.map((c) => ({ id: c.id, name: c.name, status: c.status, link: `/campaigns/${c.id}`, prospects: c.prospects, contacts: c.contacts, opportunities: c.opportunities, proposals: c.proposals, won: c.won, pipelineValue: c.pipelineValue, revenue: c.revenue })) },
          entities: rows.map((c) => ({ type: "campaign" as const, id: c.id, name: c.name })),
        };
      }
      case "pipeline_summary": {
        const r = await reports(scope);
        const [v] = await db
          .select({
            pipeline: sql<number>`coalesce(sum(coalesce(proposal_value, estimated_value, 0)) filter (where status in ('open','proposal')), 0)::float8`,
            revenue: sql<number>`coalesce(sum(won_value) filter (where status = 'won'), 0)::float8`,
          })
          .from(schema.deals)
          .where(eq(schema.deals.workspaceId, scope.workspaceId));
        return { data: { prospectsByStage: r.funnel, openPipelineValue: v.pipeline, wonRevenue: v.revenue }, entities: [] };
      }
      case "source_performance": {
        const r = await reports(scope);
        return { data: { sources: r.sources }, entities: [] };
      }
      case "work_today": {
        const today = todayISO();
        const [overdue, dueToday, nextActions, hot] = await Promise.all([
          listTasks(scope, { view: "overdue", pageSize: 10 }),
          listTasks(scope, { view: "today", pageSize: 10 }),
          db
            .select({ id: schema.prospects.id, name: schema.prospects.name, nextAction: schema.prospects.nextAction, due: schema.prospects.nextActionAt })
            .from(schema.prospects)
            .where(and(eq(schema.prospects.workspaceId, scope.workspaceId), sql`${schema.prospects.nextActionAt} <= ${today}`, sql`${schema.prospects.pipelineStage} not in ('won','lost')`))
            .limit(10),
          listProspects(scope, { minScore: 1, contacted: false, hasDecisionMaker: true, sort: "score", pageSize: 5 }),
        ]);
        const tRow = (t: (typeof overdue.rows)[number]) => ({ title: t.title, due: t.dueDate, priority: t.priority, prospect: t.prospectName, prospectId: t.prospectId });
        return {
          data: {
            today,
            overdueTasks: overdue.rows.map(tRow),
            tasksDueToday: dueToday.rows.map(tRow),
            nextActionsDue: nextActions.map((n) => ({ prospect: n.name, prospectId: n.id, nextAction: n.nextAction, due: n.due })),
            topUncontactedWithDecisionMakers: hot.rows.map((r) => ({ id: r.id, name: r.name, opportunityScore: r.opportunityScore, link: `/prospects/${r.id}` })),
          },
          entities: [
            ...overdue.rows.filter((t) => t.prospectId).map((t) => prospectRef({ id: t.prospectId!, name: t.prospectName! })),
            ...dueToday.rows.filter((t) => t.prospectId).map((t) => prospectRef({ id: t.prospectId!, name: t.prospectName! })),
            ...nextActions.map(prospectRef),
            ...hot.rows.map(prospectRef),
          ],
        };
      }
      case "overdue_followups": {
        const a = limitArgs.parse(args);
        const today = todayISO();
        const ids = await db.execute<{ id: string }>(sql`
          select distinct p.id from prospects p
          where p.workspace_id = ${scope.workspaceId} and p.pipeline_stage not in ('won','lost')
            and (p.next_action_at < ${today}
              or exists (select 1 from tasks t where t.prospect_id = p.id and t.status <> 'complete' and t.due_date < ${today}))
          limit ${a.limit}`);
        const out = [];
        const entities: EntityRef[] = [];
        for (const { id } of ids) {
          const p = await getProspect(scope, id);
          if (!p) continue;
          const [contacts, opps, tasks] = await Promise.all([
            listContactsForProspect(scope, id),
            listOpportunities(scope, { prospectId: id, pageSize: 2 }),
            listTasks(scope, { prospectId: id, view: "overdue", pageSize: 5 }),
          ]);
          entities.push(prospectRef(p));
          out.push({
            id,
            name: p.name,
            link: `/prospects/${id}`,
            stage: p.pipelineStage,
            lastContacted: date(p.lastContactedAt),
            nextAction: p.nextAction,
            nextActionDue: p.nextActionAt,
            overdueTasks: tasks.rows.map((t) => ({ title: t.title, due: t.dueDate })),
            contacts: contacts.slice(0, 3).map((c) => ({ name: c.name, jobTitle: c.jobTitle })),
            topOpportunities: opps.rows.map((o) => ({ category: o.categoryLabel, description: o.description })),
          });
        }
        return { data: { prospects: out }, entities };
      }
      case "recent_activity": {
        const a = limitArgs.parse(args);
        const rows = await listActivity(scope, { limit: a.limit });
        return {
          data: { activity: rows.map((r) => ({ when: date(r.createdAt), type: r.type, summary: r.summary, prospectId: r.prospectId })) },
          entities: rows.filter((r) => r.prospectId && r.prospectName).map((r) => prospectRef({ id: r.prospectId!, name: r.prospectName! })),
        };
      }
      default:
        return { data: { error: `Unknown tool ${name}.` }, entities: [] };
    }
  } catch (err) {
    if (err instanceof z.ZodError) return { data: { error: "Invalid tool arguments: " + err.issues[0].message }, entities: [] };
    console.error("[assistant-tool]", name, err);
    return { data: { error: "That lookup failed." }, entities: [] };
  }
}
