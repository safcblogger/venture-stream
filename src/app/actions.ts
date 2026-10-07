"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { PIPELINE_STAGES, type PipelineStage } from "@/db/schema";
import { requireAdmin, requireContext, type Ctx } from "@/lib/auth";
import { toUserMessage } from "@/lib/errors";
import { parseMoneyInput } from "@/lib/format";
import { enqueueJob } from "@/lib/jobs/queue";
import { getAiProvider } from "@/lib/providers/ai";
import { createDiscoveryRun } from "@/lib/research/discovery";
import { addProspectsToCampaign, createCampaign, deleteCampaign, removeProspectFromCampaign, updateCampaign } from "@/lib/services/campaigns";
import { addContact, deleteContact } from "@/lib/services/contacts";
import { createDeal, deleteDeal, updateDeal } from "@/lib/services/deals";
import { setOpportunityStatus, upsertOpportunity } from "@/lib/services/opportunities";
import { deleteDraft, generateOutreach, updateDraft } from "@/lib/services/outreach";
import {
  addNote, bulkUpdate, createProspect, deleteProspects, markContacted, requireProspect, setStage, updateProspect,
} from "@/lib/services/prospects";
import { createTask, deleteTask, setTaskStatus } from "@/lib/services/tasks";
import { addMemberByEmail, removeMember } from "@/lib/services/workspaces";
import { AppError } from "@/lib/errors";

export type ActionResult = { ok: true; message?: string; id?: string; data?: unknown } | { ok: false; error: string };

async function run(fn: (ctx: Ctx, scope: { workspaceId: string; userId: string }) => Promise<Omit<Extract<ActionResult, { ok: true }>, "ok"> | void>): Promise<ActionResult> {
  try {
    const ctx = await requireContext();
    const out = await fn(ctx, { workspaceId: ctx.workspace.id, userId: ctx.user.id });
    return { ok: true, ...(out ?? {}) };
  } catch (err) {
    if (isRedirect(err)) throw err;
    return { ok: false, error: toUserMessage(err).message };
  }
}

function isRedirect(err: unknown) {
  return typeof err === "object" && err !== null && "digest" in err && String((err as { digest: unknown }).digest).startsWith("NEXT_REDIRECT");
}

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const optStr = (fd: FormData, k: string) => str(fd, k) || null;
function money(fd: FormData, k: string, label: string): number | null {
  const v = parseMoneyInput(fd.get(k));
  if (Number.isNaN(v)) throw new AppError("validation", `${label} must be an amount like 2500 or 2500.50.`);
  return v;
}

/* ---- prospects ---- */

export async function createProspectAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return run(async (_c, scope) => {
    const p = await createProspect(scope, {
      name: str(fd, "name"),
      website: str(fd, "website"),
      industry: str(fd, "industry") || undefined,
      location: str(fd, "location") || undefined,
      description: str(fd, "description") || undefined,
    });
    return { id: p.id, message: "Prospect added." };
  });
}

export async function updateProspectAction(id: string, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return run(async (_c, scope) => {
    await updateProspect(scope, id, {
      name: str(fd, "name") || undefined,
      industry: optStr(fd, "industry"),
      location: optStr(fd, "location"),
      description: optStr(fd, "description"),
      companySize: optStr(fd, "companySize"),
      leadStatus: str(fd, "leadStatus") || undefined,
      assignedUserId: optStr(fd, "assignedUserId"),
      nextAction: optStr(fd, "nextAction"),
      nextActionAt: optStr(fd, "nextActionAt"),
      estimatedValue: money(fd, "estimatedValue", "Estimated value"),
    });
    return { message: "Saved." };
  });
}

export async function setStageAction(id: string, stage: string): Promise<ActionResult> {
  return run(async (_c, scope) => {
    if (!PIPELINE_STAGES.includes(stage as PipelineStage)) throw new AppError("validation", "Unknown pipeline stage.");
    await setStage(scope, id, stage as PipelineStage);
  });
}

export async function bulkAction(ids: string[], action: { type: "stage"; stage: PipelineStage } | { type: "assign"; userId: string | null } | { type: "status"; leadStatus: "new" | "working" | "nurturing" | "unqualified" } | { type: "campaign"; campaignId: string } | { type: "research" } | { type: "delete" }): Promise<ActionResult> {
  return run(async (_c, scope) => {
    let n = 0;
    if (action.type === "campaign") n = await addProspectsToCampaign(scope, action.campaignId, ids);
    else if (action.type === "delete") n = await deleteProspects(scope, ids);
    else if (action.type === "research") {
      for (const id of ids.slice(0, 50)) n += (await queueResearch(scope, id)) ? 1 : 0;
    } else n = await bulkUpdate(scope, ids, action);
    return { message: `${n} prospect${n === 1 ? "" : "s"} updated.` };
  });
}

async function queueResearch(scope: { workspaceId: string; userId: string }, id: string) {
  const p = await requireProspect(scope, id);
  if (p.researchStatus === "queued" || p.researchStatus === "running") return false;
  await db.update(schema.prospects).set({ researchStatus: "queued", researchError: null }).where(and(eq(schema.prospects.id, id), eq(schema.prospects.workspaceId, scope.workspaceId)));
  await enqueueJob({ type: "research", workspaceId: scope.workspaceId, payload: { prospectId: id, userId: scope.userId } });
  return true;
}

export async function researchProspectAction(id: string): Promise<ActionResult> {
  return run(async (_c, scope) => {
    const queued = await queueResearch(scope, id);
    return { message: queued ? "Research started. This usually takes under a minute." : "Research is already in progress." };
  });
}

export async function markContactedAction(id: string, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return run(async (_c, scope) => {
    await markContacted(scope, id, str(fd, "note"));
    return { message: "Logged as contacted." };
  });
}

export async function addNoteAction(id: string, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return run(async (_c, scope) => {
    await addNote(scope, id, str(fd, "body"));
    return { message: "Note added." };
  });
}

/* ---- contacts ---- */

export async function addContactAction(prospectId: string, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return run(async (_c, scope) => {
    await addContact(scope, prospectId, {
      name: str(fd, "name"),
      jobTitle: str(fd, "jobTitle"),
      email: str(fd, "email"),
      linkedinUrl: str(fd, "linkedinUrl"),
    });
    return { message: "Contact added." };
  });
}

export async function deleteContactAction(id: string): Promise<ActionResult> {
  return run(async (_c, scope) => deleteContact(scope, id));
}

export async function findContactsAction(prospectId: string): Promise<ActionResult> {
  return run(async (_c, scope) => {
    await requireProspect(scope, prospectId);
    await enqueueJob({ type: "contacts", workspaceId: scope.workspaceId, payload: { prospectId, userId: scope.userId } });
    return { message: "Searching for decision makers. Refresh in a moment to see what was found." };
  });
}

/* ---- opportunities ---- */

export async function setOpportunityStatusAction(id: string, status: "identified" | "pursuing" | "dismissed"): Promise<ActionResult> {
  return run(async (_c, scope) => {
    await setOpportunityStatus(scope, id, status);
  });
}

export async function createOpportunityAction(prospectId: string, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return run(async (_c, scope) => {
    const score = Number(str(fd, "score"));
    await upsertOpportunity(scope, prospectId, {
      categoryKey: str(fd, "categoryKey"),
      score: Number.isFinite(score) ? Math.round(score) : -1,
      description: str(fd, "description"),
      evidence: [{ text: str(fd, "evidence") || "Recorded manually" }],
      importance: str(fd, "importance") || "medium",
      recommendedAction: optStr(fd, "recommendedAction"),
      commercialValue: money(fd, "commercialValue", "Commercial value"),
      origin: "manual",
    });
    return { message: "Opportunity saved." };
  });
}

/* ---- tasks ---- */

export async function createTaskAction(defaults: { prospectId?: string; campaignId?: string }, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return run(async (_c, scope) => {
    await createTask(scope, {
      title: str(fd, "title"),
      description: optStr(fd, "description"),
      dueDate: str(fd, "dueDate"),
      priority: str(fd, "priority") || "medium",
      assignedUserId: optStr(fd, "assignedUserId"),
      prospectId: optStr(fd, "prospectId") ?? defaults.prospectId ?? null,
      campaignId: defaults.campaignId ?? null,
    });
    return { message: "Task created." };
  });
}

export async function setTaskStatusAction(id: string, status: "open" | "in_progress" | "complete"): Promise<ActionResult> {
  return run(async (_c, scope) => {
    await setTaskStatus(scope, id, status);
  });
}

export async function deleteTaskAction(id: string): Promise<ActionResult> {
  return run(async (_c, scope) => deleteTask(scope, id));
}

/* ---- campaigns & deals ---- */

export async function createCampaignAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return run(async (_c, scope) => {
    const c = await createCampaign(scope, {
      name: str(fd, "name"),
      description: optStr(fd, "description"),
      status: str(fd, "status") || "draft",
      targetCriteria: optStr(fd, "targetCriteria"),
      revenueTarget: money(fd, "revenueTarget", "Revenue target"),
    });
    return { id: c.id, message: "Campaign created." };
  });
}

export async function setCampaignStatusAction(id: string, status: "draft" | "active" | "paused" | "completed"): Promise<ActionResult> {
  return run(async (_c, scope) => {
    await updateCampaign(scope, id, { status });
  });
}

export async function deleteCampaignAction(id: string): Promise<ActionResult> {
  return run(async (_c, scope) => {
    await deleteCampaign(scope, id);
    redirect("/campaigns");
  });
}

export async function addToCampaignAction(prospectId: string, campaignId: string): Promise<ActionResult> {
  return run(async (_c, scope) => {
    const n = await addProspectsToCampaign(scope, campaignId, [prospectId]);
    return { message: n ? "Added to campaign." : "Already in that campaign." };
  });
}

export async function removeFromCampaignAction(campaignId: string, prospectId: string): Promise<ActionResult> {
  return run(async (_c, scope) => removeProspectFromCampaign(scope, campaignId, prospectId));
}

export async function createDealAction(prospectId: string, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return run(async (_c, scope) => {
    await createDeal(scope, prospectId, {
      title: str(fd, "title"),
      campaignId: optStr(fd, "campaignId"),
      estimatedValue: money(fd, "estimatedValue", "Estimated value"),
      proposalValue: money(fd, "proposalValue", "Proposal value"),
    });
    return { message: "Deal created." };
  });
}

export async function updateDealAction(id: string, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return run(async (_c, scope) => {
    await updateDeal(scope, id, {
      status: str(fd, "status") || undefined,
      estimatedValue: money(fd, "estimatedValue", "Estimated value"),
      proposalValue: money(fd, "proposalValue", "Proposal value"),
      wonValue: money(fd, "wonValue", "Won value"),
    });
    return { message: "Deal updated." };
  });
}

export async function deleteDealAction(id: string): Promise<ActionResult> {
  return run(async (_c, scope) => deleteDeal(scope, id));
}

/* ---- AI ---- */

export async function startDiscoveryAction(query: string): Promise<ActionResult> {
  return run(async (_c, scope) => {
    getAiProvider(); // fail fast with a clear message if keys are missing
    const { getSearchProvider } = await import("@/lib/providers/search");
    getSearchProvider();
    const r = await createDiscoveryRun(scope, query);
    return { id: r.id };
  });
}

export async function generateOutreachAction(prospectId: string, input: { instruction: string; contactId?: string | null; draftId?: string | null }): Promise<ActionResult> {
  return run(async (_c, scope) => {
    const draft = await generateOutreach(scope, prospectId, input, getAiProvider());
    return { id: draft.id, data: { subject: draft.subject, body: draft.body, id: draft.id } };
  });
}

export async function updateDraftAction(id: string, input: { subject?: string; body: string }): Promise<ActionResult> {
  return run(async (_c, scope) => {
    await updateDraft(scope, id, input);
    return { message: "Draft saved." };
  });
}

export async function deleteDraftAction(id: string): Promise<ActionResult> {
  return run(async (_c, scope) => deleteDraft(scope, id));
}

/* ---- team ---- */

export async function addMemberAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return run(async (ctx) => {
    requireAdmin(ctx);
    await addMemberByEmail(ctx.workspace.id, ctx.user.id, str(fd, "email").toLowerCase(), str(fd, "role") === "admin" ? "admin" : "member");
    return { message: "Member added." };
  });
}

export async function removeMemberAction(userId: string): Promise<ActionResult> {
  return run(async (ctx) => {
    requireAdmin(ctx);
    await removeMember(ctx.workspace.id, ctx.user.id, userId);
  });
}
