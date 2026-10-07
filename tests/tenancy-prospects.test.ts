import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { newProspect, newWorkspace } from "./helpers/fixtures";
import {
  addNote, bulkUpdate, createProspect, deleteProspects, getProspect, listActivity, listProspects, markContacted, setStage, updateProspect,
} from "@/lib/services/prospects";
import { addContact } from "@/lib/services/contacts";
import { upsertOpportunity } from "@/lib/services/opportunities";

describe("tenancy", () => {
  it("never exposes one workspace's prospects to another", async () => {
    const a = await newWorkspace("a");
    const b = await newWorkspace("b");
    const p = await newProspect(a, "Alpha Ltd");
    expect(await getProspect(b, p.id)).toBeNull();
    expect((await listProspects(b)).total).toBe(0);
    await expect(setStage(b, p.id, "qualified")).rejects.toBeInstanceOf(AppError);
    expect(await deleteProspects(b, [p.id])).toBe(0);
    expect(await getProspect(a, p.id)).not.toBeNull();
  });

  it("rejects assigning a user from another workspace", async () => {
    const a = await newWorkspace("a");
    const b = await newWorkspace("b");
    const p = await newProspect(a, "Alpha Ltd");
    await expect(updateProspect(a, p.id, { assignedUserId: b.userId })).rejects.toThrow(/not a member/);
  });
});

describe("prospects", () => {
  it("starts empty and rejects duplicate domains", async () => {
    const s = await newWorkspace();
    expect((await listProspects(s)).total).toBe(0);
    await createProspect(s, { name: "Dup", website: "https://www.dup-example.co.uk/shop" });
    await expect(createProspect(s, { name: "Dup 2", website: "dup-example.co.uk" })).rejects.toThrow(/already exists/);
    await expect(createProspect(s, { name: "Bad", website: "not a url" })).rejects.toThrow(/valid website/);
  });

  it("filters, sorts and paginates", async () => {
    const s = await newWorkspace();
    const names = ["Zeta", "Alpha", "Mid"];
    const ps = [];
    for (const n of names) ps.push(await newProspect(s, n));
    await upsertOpportunity(s, ps[1].id, { categoryKey: "technical_seo", score: 80, description: "d", evidence: [{ text: "e" }], origin: "ai" });
    await upsertOpportunity(s, ps[2].id, { categoryKey: "content", score: 50, description: "d", evidence: [{ text: "e" }], origin: "ai" });
    const bySort = await listProspects(s, { sort: "score", dir: "desc" });
    expect(bySort.rows.map((r) => r.name).slice(0, 2)).toEqual(["Alpha", "Mid"]);
    expect((await listProspects(s, { categoryKey: "technical_seo" })).rows.map((r) => r.name)).toEqual(["Alpha"]);
    expect((await listProspects(s, { minScore: 60 })).total).toBe(1);
    expect((await listProspects(s, { q: "zet" })).rows[0].name).toBe("Zeta");
    expect((await listProspects(s, { q: "%" })).total).toBe(0); // wildcard is escaped
    const page = await listProspects(s, { sort: "name", dir: "asc", pageSize: 2, page: 2 });
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it("records activity for stage changes, notes and contact", async () => {
    const s = await newWorkspace();
    const p = await newProspect(s, "Acme");
    await setStage(s, p.id, "qualified");
    await addNote(s, p.id, "Spoke to reception");
    await markContacted(s, p.id);
    const types = (await listActivity(s, { prospectId: p.id })).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(["prospect_added", "stage_changed", "note_added", "prospect_contacted"]));
    expect((await getProspect(s, p.id))!.lastContactedAt).not.toBeNull();
  });

  it("supports decision-maker filter and bulk updates", async () => {
    const s = await newWorkspace();
    const a = await newProspect(s, "A");
    const b = await newProspect(s, "B");
    await addContact(s, a.id, { name: "Jane Doe", jobTitle: "Head of Ecommerce" });
    expect((await listProspects(s, { hasDecisionMaker: true })).rows.map((r) => r.name)).toEqual(["A"]);
    expect((await listProspects(s, { hasDecisionMaker: false })).rows.map((r) => r.name)).toEqual(["B"]);
    expect(await bulkUpdate(s, [a.id, b.id], { type: "stage", stage: "contacted" })).toBe(2);
    expect(await bulkUpdate(s, [a.id, b.id], { type: "assign", userId: s.userId })).toBe(2);
    expect((await listProspects(s, { stage: "contacted", assignedUserId: s.userId })).total).toBe(2);
  });
});
