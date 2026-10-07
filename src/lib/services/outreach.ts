import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { AppError } from "@/lib/errors";
import { completeJson, type AiProvider } from "@/lib/providers/ai";
import { logActivity, type Scope } from "./common";
import { listContactsForProspect } from "./contacts";
import { listOpportunities } from "./opportunities";
import { listFacts, requireProspect } from "./prospects";

const outputSchema = z.object({ subject: z.string().min(1).max(200), body: z.string().min(1).max(4000) });

export const OUTREACH_RULES = `You write sales outreach for a user, using ONLY the supplied prospect data.
Strict rules:
- Do not invent or imply any company facts, personal details, achievements, technologies, problems, results or relationships that are not in the supplied data.
- Refer to a problem only if it appears in the supplied opportunities or website observations. Describe it plainly and honestly.
- Do not claim the user has worked with, spoken to, or met the recipient. Do not mention case studies, clients or results.
- Address the named contact if one is supplied, otherwise use a neutral greeting. Use their name and job title only as supplied.
- Do not include placeholders such as [Your Name]; end with a plain sign-off line without a name.
- Keep it concise and follow the user's instruction on tone and length.
Respond with one JSON object: {"subject","body"}`;

export async function generateOutreach(
  scope: Scope,
  prospectId: string,
  input: { instruction: string; contactId?: string | null; draftId?: string | null },
  ai: AiProvider,
) {
  const instruction = input.instruction.trim();
  if (instruction.length < 5) throw new AppError("validation", "Tell the assistant what the message should say.");
  if (instruction.length > 1000) throw new AppError("validation", "Keep the instruction under 1,000 characters.");
  const prospect = await requireProspect(scope, prospectId);
  const [contacts, opps, facts] = await Promise.all([
    listContactsForProspect(scope, prospectId),
    listOpportunities(scope, { prospectId, pageSize: 6 }),
    listFacts(scope, prospectId),
  ]);
  const contact = input.contactId ? contacts.find((c) => c.id === input.contactId) : undefined;
  if (input.contactId && !contact) throw new AppError("validation", "That contact does not belong to this prospect.");
  if (opps.rows.length === 0 && facts.filter((f) => f.provenance === "sourced").length === 0) {
    throw new AppError("validation", "There is no researched information about this prospect yet. Run research first so the message can be based on real findings.");
  }

  const out = await completeJson(
    ai,
    [
      { role: "system", content: OUTREACH_RULES },
      {
        role: "user",
        content: JSON.stringify({
          instruction,
          prospect: { name: prospect.name, website: prospect.website, industry: prospect.industry, location: prospect.location, description: prospect.description, ecommercePlatform: prospect.ecommercePlatform },
          recipient: contact ? { name: contact.name, jobTitle: contact.jobTitle } : null,
          opportunities: opps.rows.map((o) => ({ category: o.categoryLabel, description: o.description, evidence: o.evidence.map((e) => e.text), recommendedAction: o.recommendedAction })),
          websiteObservations: facts.filter((f) => f.provenance === "sourced" && f.value).map((f) => ({ label: f.label, value: f.value })),
        }),
      },
    ],
    outputSchema,
  );

  const values = { instruction, subject: out.subject.trim(), body: out.body.trim(), contactId: contact?.id ?? null, updatedAt: new Date() };
  if (input.draftId) {
    const [row] = await db
      .update(schema.outreachDrafts)
      .set(values)
      .where(and(eq(schema.outreachDrafts.id, input.draftId), eq(schema.outreachDrafts.workspaceId, scope.workspaceId), eq(schema.outreachDrafts.prospectId, prospectId)))
      .returning();
    if (row) return row;
  }
  const [row] = await db
    .insert(schema.outreachDrafts)
    .values({ workspaceId: scope.workspaceId, prospectId, userId: scope.userId, ...values })
    .returning();
  await logActivity(scope, { type: "outreach_generated", summary: `Generated outreach draft for ${prospect.name}`, prospectId });
  return row;
}

export async function updateDraft(scope: Scope, id: string, input: { subject?: string; body: string }) {
  const body = input.body.trim();
  if (!body) throw new AppError("validation", "The message cannot be empty.");
  const [row] = await db
    .update(schema.outreachDrafts)
    .set({ body: body.slice(0, 8000), subject: input.subject?.trim().slice(0, 200) ?? undefined, updatedAt: new Date() })
    .where(and(eq(schema.outreachDrafts.id, id), eq(schema.outreachDrafts.workspaceId, scope.workspaceId)))
    .returning();
  if (!row) throw new AppError("not_found", "That draft was not found.");
  return row;
}

export async function listDrafts(scope: Scope, prospectId: string) {
  return db
    .select()
    .from(schema.outreachDrafts)
    .where(and(eq(schema.outreachDrafts.prospectId, prospectId), eq(schema.outreachDrafts.workspaceId, scope.workspaceId)))
    .orderBy(desc(schema.outreachDrafts.updatedAt))
    .limit(10);
}

export async function deleteDraft(scope: Scope, id: string) {
  await db.delete(schema.outreachDrafts).where(and(eq(schema.outreachDrafts.id, id), eq(schema.outreachDrafts.workspaceId, scope.workspaceId)));
}
