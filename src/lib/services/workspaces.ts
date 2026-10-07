import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { AppError } from "@/lib/errors";

/** Opportunity categories are reference data, not sample data. Workspaces can add or deactivate categories later. */
export const DEFAULT_CATEGORIES = [
  { key: "technical_seo", label: "Technical SEO", description: "Crawlability, indexation, site architecture, speed and structured data." },
  { key: "ecommerce_seo", label: "Ecommerce SEO", description: "Category, product and faceted-navigation optimisation for online stores." },
  { key: "content", label: "Content", description: "Content depth, freshness and topical coverage." },
  { key: "organic_visibility", label: "Organic visibility", description: "Gaps between brand strength and search presence." },
  { key: "ai_visibility", label: "AI/LLM visibility", description: "Presence and accuracy in AI answers and generative search." },
  { key: "digital_pr", label: "Digital PR", description: "Earned coverage and brand mentions." },
  { key: "link_acquisition", label: "Link acquisition", description: "Backlink profile strength and gaps." },
  { key: "conversion", label: "Conversion", description: "On-site conversion and UX improvements." },
  { key: "website", label: "Website", description: "Platform, design, performance and build quality." },
  { key: "analytics", label: "Analytics", description: "Tracking, measurement and reporting gaps." },
] as const;

export const registerSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
  password: z.string().min(10, "Password must be at least 10 characters").max(200),
  workspaceName: z.string().trim().min(1, "Enter a workspace name").max(120),
});

export async function createWorkspaceForUser(userId: string, name: string) {
  return db.transaction(async (tx) => {
    const [ws] = await tx.insert(schema.workspaces).values({ name, createdBy: userId }).returning();
    await tx.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId, role: "owner" });
    await tx.insert(schema.opportunityCategories).values(
      DEFAULT_CATEGORIES.map((c, i) => ({ ...c, workspaceId: ws.id, sortOrder: i })),
    );
    return ws;
  });
}

export async function findUserByEmail(email: string) {
  const [u] = await db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email.toLowerCase()}`).limit(1);
  return u ?? null;
}

export async function listMembers(workspaceId: string) {
  return db
    .select({ userId: schema.users.id, name: schema.users.name, email: schema.users.email, role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
    .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
    .orderBy(schema.users.name);
}

export async function addMemberByEmail(workspaceId: string, actorId: string, email: string, role: "admin" | "member") {
  const user = await findUserByEmail(email);
  if (!user) throw new AppError("not_found", "No account exists with that email. Ask them to create an account first, then add them.");
  const [existing] = await db
    .select()
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, user.id)));
  if (existing) throw new AppError("conflict", "That person is already a member of this workspace.");
  await db.insert(schema.workspaceMembers).values({ workspaceId, userId: user.id, role });
  await db.insert(schema.auditLog).values({ workspaceId, userId: actorId, action: "member.added", entityType: "user", entityId: user.id, detail: { role } });
}

export async function removeMember(workspaceId: string, actorId: string, userId: string) {
  const [target] = await db
    .select()
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
  if (!target) throw new AppError("not_found", "That member was not found.");
  if (target.role === "owner") throw new AppError("forbidden", "The workspace owner cannot be removed.");
  await db
    .delete(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
  await db.insert(schema.auditLog).values({ workspaceId, userId: actorId, action: "member.removed", entityType: "user", entityId: userId });
}

export async function listCategories(workspaceId: string) {
  return db
    .select()
    .from(schema.opportunityCategories)
    .where(and(eq(schema.opportunityCategories.workspaceId, workspaceId), eq(schema.opportunityCategories.active, true)))
    .orderBy(schema.opportunityCategories.sortOrder);
}
