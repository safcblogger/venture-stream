import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { AppError } from "@/lib/errors";
import { clampPage, logActivity, type Page, type Scope } from "./common";
import { assertMember, requireProspect } from "./prospects";

const t = schema.tasks;

export const taskInputSchema = z.object({
  title: z.string().trim().min(1, "Enter a task title").max(300),
  description: z.string().trim().max(4000).nullish(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid due date").nullish().or(z.literal("")),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  assignedUserId: z.string().uuid().nullish(),
  prospectId: z.string().uuid().nullish(),
  campaignId: z.string().uuid().nullish(),
});

export type TaskView = "today" | "upcoming" | "overdue" | "completed" | "all";

export async function createTask(scope: Scope, input: unknown) {
  const parsed = taskInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError("validation", parsed.error.issues[0].message);
  const d = parsed.data;
  let prospectName: string | null = null;
  if (d.prospectId) prospectName = (await requireProspect(scope, d.prospectId)).name;
  if (d.assignedUserId) await assertMember(scope.workspaceId, d.assignedUserId);
  if (d.campaignId) {
    const [camp] = await db
      .select({ id: schema.campaigns.id })
      .from(schema.campaigns)
      .where(and(eq(schema.campaigns.id, d.campaignId), eq(schema.campaigns.workspaceId, scope.workspaceId)));
    if (!camp) throw new AppError("validation", "That campaign was not found.");
  }
  const [row] = await db
    .insert(t)
    .values({
      workspaceId: scope.workspaceId,
      title: d.title,
      description: d.description || null,
      dueDate: d.dueDate || null,
      priority: d.priority,
      assignedUserId: d.assignedUserId ?? scope.userId,
      prospectId: d.prospectId ?? null,
      campaignId: d.campaignId ?? null,
      createdBy: scope.userId,
    })
    .returning();
  await logActivity(scope, {
    type: "task_created",
    summary: `Created task "${row.title}"${prospectName ? ` for ${prospectName}` : ""}`,
    prospectId: row.prospectId,
    campaignId: row.campaignId,
  });
  return row;
}

export async function setTaskStatus(scope: Scope, id: string, status: "open" | "in_progress" | "complete") {
  const [before] = await db.select().from(t).where(and(eq(t.id, id), eq(t.workspaceId, scope.workspaceId)));
  if (!before) throw new AppError("not_found", "That task was not found.");
  if (before.status === status) return before;
  const [row] = await db
    .update(t)
    .set({ status, completedAt: status === "complete" ? new Date() : null })
    .where(eq(t.id, id))
    .returning();
  if (status === "complete") {
    await logActivity(scope, { type: "task_completed", summary: `Completed task "${row.title}"`, prospectId: row.prospectId, campaignId: row.campaignId });
  }
  return row;
}

export async function deleteTask(scope: Scope, id: string) {
  const res = await db.delete(t).where(and(eq(t.id, id), eq(t.workspaceId, scope.workspaceId))).returning({ id: t.id });
  if (res.length === 0) throw new AppError("not_found", "That task was not found.");
}

/** Today's date as YYYY-MM-DD in the server's calendar. Due dates are plain calendar dates, not instants. */
export function todayISO(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  priority: "low" | "medium" | "high";
  status: "open" | "in_progress" | "complete";
  assignedUserId: string | null;
  assignedName: string | null;
  prospectId: string | null;
  prospectName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export async function listTasks(
  scope: Scope,
  f: { view?: TaskView; prospectId?: string; campaignId?: string; assignedUserId?: string; page?: number; pageSize?: number; today?: string } = {},
): Promise<Page<TaskRow>> {
  const { page, pageSize, offset } = clampPage(f.page, f.pageSize, 200);
  const today = f.today ?? todayISO();
  const conds = [eq(t.workspaceId, scope.workspaceId)];
  if (f.prospectId) conds.push(eq(t.prospectId, f.prospectId));
  if (f.campaignId) conds.push(eq(t.campaignId, f.campaignId));
  if (f.assignedUserId) conds.push(eq(t.assignedUserId, f.assignedUserId));
  switch (f.view ?? "all") {
    case "today":
      conds.push(sql`${t.status} <> 'complete'`, sql`${t.dueDate} = ${today}`);
      break;
    case "upcoming":
      conds.push(sql`${t.status} <> 'complete'`, sql`(${t.dueDate} > ${today} or ${t.dueDate} is null)`);
      break;
    case "overdue":
      conds.push(sql`${t.status} <> 'complete'`, sql`${t.dueDate} < ${today}`);
      break;
    case "completed":
      conds.push(eq(t.status, "complete"));
      break;
  }
  const where = and(...conds);
  const completedView = f.view === "completed";
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: t.id,
        title: t.title,
        description: t.description,
        dueDate: t.dueDate,
        priority: t.priority,
        status: t.status,
        assignedUserId: t.assignedUserId,
        assignedName: schema.users.name,
        prospectId: t.prospectId,
        prospectName: schema.prospects.name,
        campaignId: t.campaignId,
        campaignName: schema.campaigns.name,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
      })
      .from(t)
      .leftJoin(schema.users, eq(schema.users.id, t.assignedUserId))
      .leftJoin(schema.prospects, eq(schema.prospects.id, t.prospectId))
      .leftJoin(schema.campaigns, eq(schema.campaigns.id, t.campaignId))
      .where(where)
      .orderBy(
        ...(completedView
          ? [desc(t.completedAt)]
          : [sql`${t.dueDate} asc nulls last`, sql`case ${t.priority} when 'high' then 0 when 'medium' then 1 else 2 end`, asc(t.createdAt)]),
      )
      .limit(pageSize)
      .offset(offset),
    db.select({ total: sql<number>`count(*)::int` }).from(t).where(where),
  ]);
  return { rows, total, page, pageSize };
}

export async function taskCounts(scope: Scope, today = todayISO()) {
  const [r] = await db
    .select({
      today: sql<number>`count(*) filter (where ${t.status} <> 'complete' and ${t.dueDate} = ${today})::int`,
      upcoming: sql<number>`count(*) filter (where ${t.status} <> 'complete' and (${t.dueDate} > ${today} or ${t.dueDate} is null))::int`,
      overdue: sql<number>`count(*) filter (where ${t.status} <> 'complete' and ${t.dueDate} < ${today})::int`,
      completed: sql<number>`count(*) filter (where ${t.status} = 'complete')::int`,
      open: sql<number>`count(*) filter (where ${t.status} <> 'complete')::int`,
    })
    .from(t)
    .where(eq(t.workspaceId, scope.workspaceId));
  return r;
}
