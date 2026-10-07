import { and, asc, desc, eq, exists, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { PIPELINE_STAGES } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { clampPage, likePattern, logActivity, parseWebsite, type Page, type Scope } from "./common";

const p = schema.prospects;

export const prospectFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  stage: z.enum(PIPELINE_STAGES).optional(),
  leadStatus: z.enum(["new", "working", "nurturing", "unqualified"]).optional(),
  assignedUserId: z.string().uuid().optional(),
  unassigned: z.boolean().optional(),
  platform: z.string().trim().max(80).optional(),
  categoryKey: z.string().trim().max(60).optional(),
  campaignId: z.string().uuid().optional(),
  source: z.string().trim().max(60).optional(),
  minScore: z.number().int().min(0).max(100).optional(),
  researched: z.boolean().optional(),
  hasDecisionMaker: z.boolean().optional(),
  contacted: z.boolean().optional(),
  discoveredSince: z.date().optional(),
  sort: z.enum(["score", "name", "created", "updated", "stage", "last_contacted", "value"]).default("created"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().int().optional(),
  pageSize: z.number().int().optional(),
});
export type ProspectFilters = z.input<typeof prospectFiltersSchema>;

function whereFor(scope: Scope, f: z.output<typeof prospectFiltersSchema>): SQL {
  const conds: (SQL | undefined)[] = [eq(p.workspaceId, scope.workspaceId)];
  if (f.q) {
    const like = likePattern(f.q);
    conds.push(or(ilike(p.name, like), ilike(p.domain, like), ilike(p.industry, like), ilike(p.location, like), ilike(p.description, like)));
  }
  if (f.stage) conds.push(eq(p.pipelineStage, f.stage));
  if (f.leadStatus) conds.push(eq(p.leadStatus, f.leadStatus));
  if (f.assignedUserId) conds.push(eq(p.assignedUserId, f.assignedUserId));
  if (f.unassigned) conds.push(sql`${p.assignedUserId} is null`);
  if (f.platform) conds.push(ilike(p.ecommercePlatform, likePattern(f.platform)));
  if (f.source) conds.push(eq(p.discoverySource, f.source));
  if (f.minScore !== undefined) conds.push(sql`${p.opportunityScore} >= ${f.minScore}`);
  if (f.researched !== undefined) conds.push(f.researched ? eq(p.researchStatus, "done") : sql`${p.researchStatus} <> 'done'`);
  if (f.discoveredSince) conds.push(sql`${p.discoveredAt} >= ${f.discoveredSince.toISOString()}::timestamptz`);
  if (f.contacted !== undefined) conds.push(f.contacted ? sql`${p.lastContactedAt} is not null` : sql`${p.lastContactedAt} is null`);
  if (f.categoryKey) {
    conds.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(schema.opportunities)
          .innerJoin(schema.opportunityCategories, eq(schema.opportunityCategories.id, schema.opportunities.categoryId))
          .where(
            and(
              eq(schema.opportunities.prospectId, p.id),
              eq(schema.opportunityCategories.key, f.categoryKey),
              sql`${schema.opportunities.status} <> 'dismissed'`,
            ),
          ),
      ),
    );
  }
  if (f.campaignId) {
    conds.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(schema.campaignProspects)
          .where(and(eq(schema.campaignProspects.prospectId, p.id), eq(schema.campaignProspects.campaignId, f.campaignId))),
      ),
    );
  }
  if (f.hasDecisionMaker !== undefined) {
    const sub = exists(
      db
        .select({ one: sql`1` })
        .from(schema.contacts)
        .where(and(eq(schema.contacts.prospectId, p.id), inArray(schema.contacts.relevance, ["primary", "relevant"]))),
    );
    conds.push(f.hasDecisionMaker ? sub : sql`not ${sub}`);
  }
  return and(...conds)!;
}

const SORTS = {
  score: sql`${p.opportunityScore}`,
  name: sql`lower(${p.name})`,
  created: sql`${p.createdAt}`,
  updated: sql`${p.updatedAt}`,
  stage: sql`${p.pipelineStage}`,
  last_contacted: sql`${p.lastContactedAt}`,
  value: sql`${p.estimatedValue}`,
} as const;

export async function listProspects(scope: Scope, filters: ProspectFilters = {}): Promise<Page<ProspectRow>> {
  const f = prospectFiltersSchema.parse(filters);
  const { page, pageSize, offset } = clampPage(f.page, f.pageSize);
  const where = whereFor(scope, f);
  const dir = f.dir === "asc" ? asc : desc;
  const order = [sql`${dir(SORTS[f.sort])} nulls last`, desc(p.createdAt)];

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: p.id,
        name: p.name,
        domain: p.domain,
        website: p.website,
        industry: p.industry,
        location: p.location,
        ecommercePlatform: p.ecommercePlatform,
        opportunityScore: p.opportunityScore,
        pipelineStage: p.pipelineStage,
        leadStatus: p.leadStatus,
        assignedUserId: p.assignedUserId,
        assignedName: schema.users.name,
        lastContactedAt: p.lastContactedAt,
        nextAction: p.nextAction,
        nextActionAt: p.nextActionAt,
        estimatedValue: p.estimatedValue,
        researchStatus: p.researchStatus,
        createdAt: p.createdAt,
        categories: sql<string[]>`coalesce((select array_agg(c.label order by o.score desc) from opportunities o join opportunity_categories c on c.id = o.category_id where o.prospect_id = ${p.id} and o.status <> 'dismissed'), '{}')`,
        contactCount: sql<number>`(select count(*)::int from contacts ct where ct.prospect_id = ${p.id})`,
      })
      .from(p)
      .leftJoin(schema.users, eq(schema.users.id, p.assignedUserId))
      .where(where)
      .orderBy(...order)
      .limit(pageSize)
      .offset(offset),
    db.select({ total: sql<number>`count(*)::int` }).from(p).where(where),
  ]);
  return { rows, total, page, pageSize };
}

export type ProspectRow = {
  id: string;
  name: string;
  domain: string;
  website: string | null;
  industry: string | null;
  location: string | null;
  ecommercePlatform: string | null;
  opportunityScore: number | null;
  pipelineStage: (typeof PIPELINE_STAGES)[number];
  leadStatus: "new" | "working" | "nurturing" | "unqualified";
  assignedUserId: string | null;
  assignedName: string | null;
  lastContactedAt: Date | null;
  nextAction: string | null;
  nextActionAt: string | null;
  estimatedValue: number | null;
  researchStatus: "none" | "queued" | "running" | "done" | "failed";
  createdAt: Date;
  categories: string[];
  contactCount: number;
};

export async function getProspect(scope: Scope, id: string) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const [row] = await db
    .select({ prospect: p, assignedName: schema.users.name })
    .from(p)
    .leftJoin(schema.users, eq(schema.users.id, p.assignedUserId))
    .where(and(eq(p.id, id), eq(p.workspaceId, scope.workspaceId)))
    .limit(1);
  return row ? { ...row.prospect, assignedName: row.assignedName } : null;
}

export async function requireProspect(scope: Scope, id: string) {
  const row = await getProspect(scope, id);
  if (!row) throw new AppError("not_found", "That prospect was not found.");
  return row;
}

export const createProspectSchema = z.object({
  name: z.string().trim().min(1, "Enter the company name").max(200),
  website: z.string().trim().min(1, "Enter the company website").max(300),
  industry: z.string().trim().max(200).optional(),
  location: z.string().trim().max(200).optional(),
  description: z.string().trim().max(4000).optional(),
});

export async function createProspect(scope: Scope, input: unknown) {
  const data = createProspectSchema.safeParse(input);
  if (!data.success) throw new AppError("validation", data.error.issues[0].message);
  const site = parseWebsite(data.data.website);
  if (!site) throw new AppError("validation", "Enter a valid website address, for example example.co.uk.");
  const [existing] = await db
    .select({ id: p.id })
    .from(p)
    .where(and(eq(p.workspaceId, scope.workspaceId), eq(p.domain, site.domain)));
  if (existing) throw new AppError("conflict", "A prospect with that website already exists in this workspace.");
  const [row] = await db
    .insert(p)
    .values({
      workspaceId: scope.workspaceId,
      name: data.data.name,
      website: site.website,
      domain: site.domain,
      industry: data.data.industry || null,
      location: data.data.location || null,
      description: data.data.description || null,
      discoverySource: "manual",
      createdBy: scope.userId,
    })
    .returning();
  await logActivity(scope, { type: "prospect_added", summary: `Added ${row.name} manually`, prospectId: row.id });
  return row;
}

export const updateProspectSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  industry: z.string().trim().max(200).nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  companySize: z.string().trim().max(100).nullable().optional(),
  leadStatus: z.enum(["new", "working", "nurturing", "unqualified"]).optional(),
  assignedUserId: z.string().uuid().nullable().optional(),
  nextAction: z.string().trim().max(300).nullable().optional(),
  nextActionAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  estimatedValue: z.number().int().min(0).nullable().optional(),
});

export async function assertMember(workspaceId: string, userId: string) {
  const [m] = await db
    .select({ userId: schema.workspaceMembers.userId })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
  if (!m) throw new AppError("validation", "That user is not a member of this workspace.");
}

export async function updateProspect(scope: Scope, id: string, input: unknown) {
  const data = updateProspectSchema.safeParse(input);
  if (!data.success) throw new AppError("validation", data.error.issues[0].message);
  const before = await requireProspect(scope, id);
  if (data.data.assignedUserId) await assertMember(scope.workspaceId, data.data.assignedUserId);
  const [row] = await db
    .update(p)
    .set({ ...data.data, updatedAt: new Date() })
    .where(and(eq(p.id, id), eq(p.workspaceId, scope.workspaceId)))
    .returning();
  if (data.data.assignedUserId !== undefined && data.data.assignedUserId !== before.assignedUserId) {
    await logActivity(scope, { type: "prospect_assigned", summary: `Changed assignment on ${row.name}`, prospectId: id });
  }
  return row;
}

export async function setStage(scope: Scope, id: string, stage: (typeof PIPELINE_STAGES)[number]) {
  if (!PIPELINE_STAGES.includes(stage)) throw new AppError("validation", "Unknown pipeline stage.");
  const before = await requireProspect(scope, id);
  if (before.pipelineStage === stage) return before;
  const [row] = await db
    .update(p)
    .set({ pipelineStage: stage, updatedAt: new Date() })
    .where(and(eq(p.id, id), eq(p.workspaceId, scope.workspaceId)))
    .returning();
  await logActivity(scope, {
    type: "stage_changed",
    summary: `Moved ${row.name} from ${before.pipelineStage} to ${stage}`,
    prospectId: id,
    metadata: { from: before.pipelineStage, to: stage },
  });
  if (stage === "won") await logActivity(scope, { type: "deal_won", summary: `${row.name} marked as won`, prospectId: id });
  return row;
}

export async function markContacted(scope: Scope, id: string, note?: string) {
  const before = await requireProspect(scope, id);
  const now = new Date();
  await db.update(p).set({ lastContactedAt: now, updatedAt: now }).where(and(eq(p.id, id), eq(p.workspaceId, scope.workspaceId)));
  await logActivity(scope, {
    type: "prospect_contacted",
    summary: note?.trim() ? `Contacted ${before.name}: ${note.trim().slice(0, 200)}` : `Contacted ${before.name}`,
    prospectId: id,
  });
}

export async function deleteProspects(scope: Scope, ids: string[]) {
  if (ids.length === 0) return 0;
  const res = await db
    .delete(p)
    .where(and(eq(p.workspaceId, scope.workspaceId), inArray(p.id, ids)))
    .returning({ id: p.id });
  return res.length;
}

export async function bulkUpdate(
  scope: Scope,
  ids: string[],
  action:
    | { type: "stage"; stage: (typeof PIPELINE_STAGES)[number] }
    | { type: "assign"; userId: string | null }
    | { type: "status"; leadStatus: "new" | "working" | "nurturing" | "unqualified" },
) {
  const valid = ids.filter((i) => z.string().uuid().safeParse(i).success).slice(0, 500);
  if (valid.length === 0) return 0;
  if (action.type === "stage") {
    let n = 0;
    for (const id of valid) {
      try {
        await setStage(scope, id, action.stage);
        n++;
      } catch (e) {
        if (!(e instanceof AppError && e.kind === "not_found")) throw e;
      }
    }
    return n;
  }
  const set =
    action.type === "assign"
      ? (action.userId && (await assertMember(scope.workspaceId, action.userId)), { assignedUserId: action.userId })
      : { leadStatus: action.leadStatus };
  const res = await db
    .update(p)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(p.workspaceId, scope.workspaceId), inArray(p.id, valid)))
    .returning({ id: p.id });
  return res.length;
}

/** Recompute a prospect's overall score from its active opportunities (highest score weighted with breadth). */
export async function recomputeScore(workspaceId: string, prospectId: string) {
  const opps = await db
    .select({ score: schema.opportunities.score })
    .from(schema.opportunities)
    .where(and(eq(schema.opportunities.prospectId, prospectId), sql`${schema.opportunities.status} <> 'dismissed'`))
    .orderBy(desc(schema.opportunities.score));
  const score = opps.length === 0 ? null : Math.min(100, Math.round(opps[0].score + (opps.slice(1, 4).reduce((a, o) => a + o.score, 0) / 100) * 4));
  await db.update(p).set({ opportunityScore: score, updatedAt: new Date() }).where(and(eq(p.id, prospectId), eq(p.workspaceId, workspaceId)));
  return score;
}

export async function listFacts(scope: Scope, prospectId: string) {
  return db
    .select()
    .from(schema.prospectFacts)
    .where(and(eq(schema.prospectFacts.prospectId, prospectId), eq(schema.prospectFacts.workspaceId, scope.workspaceId)))
    .orderBy(schema.prospectFacts.label);
}

export async function addNote(scope: Scope, prospectId: string, body: string) {
  const text = body.trim();
  if (!text) throw new AppError("validation", "Write a note first.");
  if (text.length > 5000) throw new AppError("validation", "Notes can be up to 5,000 characters.");
  const prospect = await requireProspect(scope, prospectId);
  await db.insert(schema.notes).values({ workspaceId: scope.workspaceId, prospectId, userId: scope.userId, body: text });
  await logActivity(scope, { type: "note_added", summary: `Added a note on ${prospect.name}`, prospectId });
}

export async function listNotes(scope: Scope, prospectId: string) {
  return db
    .select({ id: schema.notes.id, body: schema.notes.body, createdAt: schema.notes.createdAt, author: schema.users.name })
    .from(schema.notes)
    .leftJoin(schema.users, eq(schema.users.id, schema.notes.userId))
    .where(and(eq(schema.notes.prospectId, prospectId), eq(schema.notes.workspaceId, scope.workspaceId)))
    .orderBy(desc(schema.notes.createdAt));
}

export async function listActivity(scope: Scope, opts: { prospectId?: string; campaignId?: string; limit?: number; offset?: number }) {
  const conds = [eq(schema.activities.workspaceId, scope.workspaceId)];
  if (opts.prospectId) conds.push(eq(schema.activities.prospectId, opts.prospectId));
  if (opts.campaignId) conds.push(eq(schema.activities.campaignId, opts.campaignId));
  return db
    .select({
      id: schema.activities.id,
      type: schema.activities.type,
      summary: schema.activities.summary,
      prospectId: schema.activities.prospectId,
      prospectName: p.name,
      createdAt: schema.activities.createdAt,
      userName: schema.users.name,
    })
    .from(schema.activities)
    .leftJoin(schema.users, eq(schema.users.id, schema.activities.userId))
    .leftJoin(p, eq(p.id, schema.activities.prospectId))
    .where(and(...conds))
    .orderBy(desc(schema.activities.createdAt))
    .limit(Math.min(opts.limit ?? 50, 200))
    .offset(opts.offset ?? 0);
}

export async function distinctPlatforms(scope: Scope) {
  const rows = await db
    .selectDistinct({ v: p.ecommercePlatform })
    .from(p)
    .where(and(eq(p.workspaceId, scope.workspaceId), sql`${p.ecommercePlatform} is not null`))
    .orderBy(p.ecommercePlatform);
  return rows.map((r) => r.v!).filter(Boolean);
}
