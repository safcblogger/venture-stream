import { describe, expect, it } from "vitest";
import { newProspect, newWorkspace } from "./helpers/fixtures";
import { createTask, listTasks, setTaskStatus, taskCounts } from "@/lib/services/tasks";
import { addProspectsToCampaign, createCampaign, listCampaigns } from "@/lib/services/campaigns";
import { createDeal, updateDeal } from "@/lib/services/deals";
import { dashboard, reports } from "@/lib/services/reports";
import { upsertOpportunity } from "@/lib/services/opportunities";
import { registerAccount, checkLoginThrottle, recordLoginFailure, authenticate } from "@/lib/services/accounts";
import { addMemberByEmail } from "@/lib/services/workspaces";
import { listProspects } from "@/lib/services/prospects";

describe("empty workspace", () => {
  it("reports zeros, not fabricated numbers", async () => {
    const s = await newWorkspace();
    const d = await dashboard(s);
    expect(d).toMatchObject({ totalProspects: 0, newProspects: 0, qualifiedProspects: 0, activeOpportunities: 0, openTasks: 0, overdueTasks: 0, pipelineValue: 0, revenue: 0 });
    expect(d.campaigns).toEqual([]);
    expect(d.recentActivity).toEqual([]);
    expect(d.topProspects).toEqual([]);
    const r = await reports(s);
    expect(r.sources).toEqual([]);
    expect(r.funnel.every((f) => f.count === 0)).toBe(true);
  });
});

describe("tasks", () => {
  it("buckets into today / upcoming / overdue / completed", async () => {
    const s = await newWorkspace();
    const today = "2030-06-15";
    await createTask(s, { title: "late", dueDate: "2030-06-14" });
    const dueToday = await createTask(s, { title: "now", dueDate: today });
    await createTask(s, { title: "later", dueDate: "2030-06-20" });
    await createTask(s, { title: "someday" });
    const view = async (v: "today" | "upcoming" | "overdue" | "completed") => (await listTasks(s, { view: v, today })).rows.map((t) => t.title).sort();
    expect(await view("overdue")).toEqual(["late"]);
    expect(await view("today")).toEqual(["now"]);
    expect(await view("upcoming")).toEqual(["later", "someday"]);
    const done = await setTaskStatus(s, dueToday.id, "complete");
    expect(done.completedAt).not.toBeNull();
    expect(await view("completed")).toEqual(["now"]);
    expect(await view("today")).toEqual([]);
    expect((await taskCounts(s, today)).overdue).toBe(1);
  });

  it("shows tasks inside the prospect and rejects foreign prospects", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    const p = await newProspect(a, "Acme");
    await createTask(a, { title: "call", prospectId: p.id });
    expect((await listTasks(a, { prospectId: p.id })).total).toBe(1);
    await expect(createTask(b, { title: "x", prospectId: p.id })).rejects.toThrow(/not found/);
  });
});

describe("campaigns, deals and attribution", () => {
  it("computes campaign metrics and source attribution from stored data", async () => {
    const s = await newWorkspace();
    const p1 = await newProspect(s, "One");
    const p2 = await newProspect(s, "Two");
    await upsertOpportunity(s, p1.id, { categoryKey: "technical_seo", score: 70, description: "d", evidence: [{ text: "e" }], origin: "ai" });
    const camp = await createCampaign(s, { name: "Shopify UK", status: "active" });
    expect(await addProspectsToCampaign(s, camp.id, [p1.id, p2.id])).toBe(2);
    expect(await addProspectsToCampaign(s, camp.id, [p1.id])).toBe(0);

    const won = await createDeal(s, p1.id, { title: "Retainer", estimatedValue: 500000 });
    expect(won.campaignId).toBe(camp.id); // attributed to the prospect's only campaign
    await expect(updateDeal(s, won.id, { status: "won" })).rejects.toThrow(/won value/);
    await updateDeal(s, won.id, { status: "won", wonValue: 480000 });
    await createDeal(s, p2.id, { title: "Audit", estimatedValue: 100000, proposalValue: 120000 });

    const [c] = await listCampaigns(s, { campaignId: camp.id });
    expect(c).toMatchObject({ prospects: 2, opportunities: 1, proposals: 2, won: 1, pipelineValue: 120000, revenue: 480000 });

    const r = await reports(s);
    expect(r.sources[0]).toMatchObject({ source: "manual", deals: 2, revenue: 480000, pipelineValue: 120000 });
    const d = await dashboard(s);
    expect(d).toMatchObject({ pipelineValue: 120000, revenue: 480000, totalProspects: 2, activeOpportunities: 1 });
  });

  it("does not leak campaigns across workspaces", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    await createCampaign(a, { name: "Private" });
    expect(await listCampaigns(b)).toEqual([]);
  });
});

describe("accounts", () => {
  it("registers, authenticates and prevents duplicates", async () => {
    const email = `dup-${Date.now()}@example.test`;
    await registerAccount({ name: "A", email, password: "longenoughpass", workspaceName: "W" });
    await expect(registerAccount({ name: "A", email: email.toUpperCase(), password: "longenoughpass", workspaceName: "W" })).rejects.toThrow(/already exists/);
    await expect(registerAccount({ name: "A", email: "x@example.test", password: "short", workspaceName: "W" })).rejects.toThrow(/at least 10/);
    expect(await authenticate(email, "longenoughpass")).not.toBeNull();
    expect(await authenticate(email, "wrongpassword!")).toBeNull();
    expect(await authenticate("nobody@example.test", "whatever1234")).toBeNull();
  });

  it("throttles repeated failures", () => {
    const key = "throttle-test";
    for (let i = 0; i < 8; i++) recordLoginFailure(key);
    expect(() => checkLoginThrottle(key)).toThrow(/Too many/);
  });

  it("shares a workspace only with explicitly added members", async () => {
    const owner = await newWorkspace("owner");
    const other = await newWorkspace("other");
    const p = await newProspect(owner, "Shared Co");
    expect((await listProspects(other)).total).toBe(0);
    await addMemberByEmail(owner.workspaceId, owner.userId, other.email, "member");
    // The other user's membership in the owner's workspace grants access via that workspace scope.
    expect((await listProspects({ workspaceId: owner.workspaceId, userId: other.userId })).rows[0].id).toBe(p.id);
    await expect(addMemberByEmail(owner.workspaceId, owner.userId, other.email, "member")).rejects.toThrow(/already/);
    await expect(addMemberByEmail(owner.workspaceId, owner.userId, "ghost@example.test", "member")).rejects.toThrow(/No account/);
  });
});
