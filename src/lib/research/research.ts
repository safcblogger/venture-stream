import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { AppError, toUserMessage } from "@/lib/errors";
import { completeJson, type AiProvider } from "@/lib/providers/ai";
import type { SearchProvider, SearchResult } from "@/lib/providers/search";
import { listCategories } from "@/lib/services/workspaces";
import { logActivity, type Scope } from "@/lib/services/common";
import { addContact } from "@/lib/services/contacts";
import { requireProspect } from "@/lib/services/prospects";
import { upsertOpportunity } from "@/lib/services/opportunities";
import { inspectSite, type Observation, type SiteInspection } from "./inspect";

export interface ResearchDeps {
  search: SearchProvider;
  ai: AiProvider;
  inspect?: (website: string) => Promise<SiteInspection>;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

const sourced = z.object({ value: z.string().nullable(), sourceId: z.string().nullable() }).nullish();

const analysisSchema = z.object({
  description: sourced,
  industry: sourced,
  location: sourced,
  companySize: sourced,
  opportunities: z
    .array(
      z.object({
        categoryKey: z.string(),
        score: z.number(),
        description: z.string(),
        evidence: z.array(z.object({ text: z.string(), observationKey: z.string().nullish(), sourceId: z.string().nullish() })),
        importance: z.enum(["low", "medium", "high"]).catch("medium"),
        potentialImpact: z.string().nullish(),
        recommendedAction: z.string().nullish(),
      }),
    )
    .default([]),
});

export const ANALYSIS_RULES = `You are a research analyst for a sales team that sells SEO and digital marketing services.
You receive ONLY the material gathered for one company: direct observations of its website and snippets from web sources.
Strict rules:
- Use nothing but the supplied material. Do not use background knowledge about the company.
- If a field is not stated in the material, return null for it. Never guess.
- For description, industry, location and companySize return {"value", "sourceId"}; sourceId must be the id of the source that states it (e.g. "S2"), or null if you are inferring it.
- Opportunities must be real, evidenced weaknesses or gaps relevant to the supplied categories. Each opportunity needs 1-4 evidence items. Each evidence item must cite an observationKey from the website observations OR a sourceId from the sources, and "text" must restate what that item actually says.
- Do not claim anything about search rankings, traffic, backlinks or revenue unless a source states it.
- score is 0-100 and reflects how strong and commercially relevant the evidenced gap is. Do not output opportunities you cannot evidence.
- potentialImpact and recommendedAction are short, concrete and grounded in the evidence.
Respond with one JSON object: {"description","industry","location","companySize","opportunities":[{"categoryKey","score","description","evidence":[{"text","observationKey","sourceId"}],"importance","potentialImpact","recommendedAction"}]}`;

interface Source {
  id: string;
  url: string;
  title: string;
  content: string;
}

function toSources(results: SearchResult[], prefix = "S", limit = 8): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const r of results) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({ id: `${prefix}${out.length + 1}`, url: r.url, title: r.title, content: r.content });
    if (out.length >= limit) break;
  }
  return out;
}

async function upsertFact(
  scope: Scope,
  prospectId: string,
  fact: { key: string; label: string; value: string | null; provenance: "sourced" | "inferred" | "unknown"; sourceUrl?: string | null },
) {
  await db
    .insert(schema.prospectFacts)
    .values({ workspaceId: scope.workspaceId, prospectId, ...fact, sourceUrl: fact.sourceUrl ?? null })
    .onConflictDoUpdate({
      target: [schema.prospectFacts.prospectId, schema.prospectFacts.key],
      set: { value: fact.value, provenance: fact.provenance, sourceUrl: fact.sourceUrl ?? null, label: fact.label },
    });
}

/** Turn the model's cited evidence into verified evidence; anything that doesn't point at supplied material is dropped. */
export function verifyEvidence(
  evidence: { text: string; observationKey?: string | null; sourceId?: string | null }[],
  observations: Observation[],
  sources: Source[],
  siteUrl: string | null,
) {
  const obsKeys = new Set(observations.map((o) => o.key));
  const byId = new Map(sources.map((s) => [s.id, s]));
  const out: { text: string; sourceUrl: string | null }[] = [];
  for (const e of evidence) {
    const text = e.text?.trim();
    if (!text) continue;
    if (e.observationKey && obsKeys.has(e.observationKey)) out.push({ text, sourceUrl: siteUrl });
    else if (e.sourceId && byId.has(e.sourceId)) out.push({ text, sourceUrl: byId.get(e.sourceId)!.url });
  }
  return out;
}

/** Score ceiling grows with the amount of verified evidence, so thin evidence can never produce a high score. */
export function capScore(score: number, verifiedEvidenceCount: number) {
  const ceiling = Math.min(95, 25 + 15 * verifiedEvidenceCount);
  return Math.max(0, Math.min(Math.round(score), ceiling));
}

export async function researchProspect(scope: Scope, prospectId: string, deps: ResearchDeps) {
  const prospect = await requireProspect(scope, prospectId);
  const sys = { workspaceId: scope.workspaceId, userId: scope.userId };
  await db.update(schema.prospects).set({ researchStatus: "running", researchError: null }).where(eq(schema.prospects.id, prospectId));

  try {
    const inspection = await (deps.inspect ?? inspectSite)(prospect.website ?? `https://${prospect.domain}`);
    const observations: Observation[] = inspection.reachable
      ? inspection.observations
      : [{ key: "website_unreachable", label: "Website", value: "The homepage could not be fetched during research" }];
    const siteUrl = inspection.finalUrl ?? prospect.website;

    const searchResults = await deps.search.search(`${prospect.name} ${prospect.domain}`, { maxResults: 6 }).catch((e) => {
      if (e instanceof AppError && ["provider_auth", "not_configured"].includes(e.kind)) throw e;
      return [] as SearchResult[];
    });
    const sources = toSources(searchResults);
    const categories = await listCategories(scope.workspaceId);

    const analysis = await completeJson(
      deps.ai,
      [
        { role: "system", content: ANALYSIS_RULES },
        {
          role: "user",
          content: JSON.stringify({
            company: { name: prospect.name, domain: prospect.domain, website: prospect.website },
            websiteObservations: observations,
            sources: sources.map((s) => ({ id: s.id, url: s.url, title: s.title, content: clip(s.content, 1200) })),
            categories: categories.map((c) => ({ key: c.key, label: c.label, description: c.description })),
          }),
        },
      ],
      analysisSchema,
    );

    // 1. Directly observed facts.
    for (const o of observations) {
      await upsertFact(scope, prospectId, { key: o.key, label: o.label, value: o.value, provenance: "sourced", sourceUrl: siteUrl });
    }
    await upsertFact(scope, prospectId, {
      key: "ecommerce_platform",
      label: "Ecommerce platform",
      value: inspection.platform,
      provenance: inspection.platform ? "sourced" : "unknown",
      sourceUrl: inspection.platform ? siteUrl : null,
    });

    // 2. Descriptive fields: sourced only when the model cited a supplied source.
    const sourceById = new Map(sources.map((s) => [s.id, s]));
    const patch: Partial<typeof schema.prospects.$inferInsert> = {};
    const fields = [
      { key: "description", label: "Description", v: analysis.description, column: "description" },
      { key: "industry", label: "Industry", v: analysis.industry, column: "industry" },
      { key: "location", label: "Location", v: analysis.location, column: "location" },
      { key: "company_size", label: "Company size", v: analysis.companySize, column: "companySize" },
    ] as const;
    for (const f of fields) {
      const value = f.v?.value?.trim() || null;
      const src = f.v?.sourceId ? sourceById.get(f.v.sourceId) : undefined;
      await upsertFact(scope, prospectId, {
        key: f.key,
        label: f.label,
        value,
        provenance: !value ? "unknown" : src ? "sourced" : "inferred",
        sourceUrl: src?.url ?? null,
      });
      const current = prospect[f.column];
      if (value && (!current || src)) (patch as Record<string, unknown>)[f.column] = value;
    }
    if (inspection.platform) patch.ecommercePlatform = inspection.platform;
    patch.technology = inspection.technologies;

    // 3. Opportunities that survive evidence verification.
    let created = 0;
    for (const o of analysis.opportunities) {
      const evidence = verifyEvidence(o.evidence, observations, sources, siteUrl);
      if (evidence.length === 0) continue;
      if (!categories.some((c) => c.key === o.categoryKey)) continue;
      await upsertOpportunity(
        sys,
        prospectId,
        {
          categoryKey: o.categoryKey,
          score: capScore(o.score, evidence.length),
          description: o.description,
          evidence,
          importance: o.importance,
          potentialImpact: o.potentialImpact ?? null,
          recommendedAction: o.recommendedAction ?? null,
          origin: "ai",
        },
        { attributeToUser: false },
      );
      created++;
    }

    await db
      .update(schema.prospects)
      .set({ ...patch, researchStatus: "done", researchedAt: new Date(), researchError: null, updatedAt: new Date() })
      .where(and(eq(schema.prospects.id, prospectId), eq(schema.prospects.workspaceId, scope.workspaceId)));
    await logActivity(sys, {
      type: "prospect_researched",
      summary: `Researched ${prospect.name}: ${observations.length} website observations, ${created} opportunit${created === 1 ? "y" : "ies"} identified`,
      prospectId,
      attributeToUser: false,
    });

    // Decision makers are best-effort and must not fail the research run.
    await findDecisionMakers(scope, prospectId, deps).catch((e) => console.error("[research] decision-maker search failed", e));
  } catch (err) {
    const { message } = toUserMessage(err);
    await db
      .update(schema.prospects)
      .set({ researchStatus: "failed", researchError: message, updatedAt: new Date() })
      .where(eq(schema.prospects.id, prospectId));
    throw err;
  }
}

/* ---------- Decision makers ---------- */

const peopleSchema = z.object({
  people: z
    .array(
      z.object({
        name: z.string(),
        jobTitle: z.string(),
        sourceId: z.string(),
        email: z.string().nullish(),
        linkedinUrl: z.string().nullish(),
      }),
    )
    .default([]),
});

export const PEOPLE_RULES = `You extract named people who work at ONE specific company from supplied web source snippets.
Strict rules:
- Only return people whose full name AND job title are explicitly stated in a supplied source, in connection with the company.
- Only target decision-relevant roles: founder, CEO, managing director, marketing director, head of marketing, digital director, ecommerce manager, head of ecommerce, SEO manager (or very close equivalents).
- sourceId must be the source that states the person. Never invent names, titles, emails or LinkedIn URLs. If an email or LinkedIn URL is not literally written in the source, return null for it.
- If no one qualifies return {"people": []}.
Respond with one JSON object: {"people":[{"name","jobTitle","sourceId","email","linkedinUrl"}]}`;

export interface VerifiedPerson {
  name: string;
  jobTitle: string;
  email: string | null;
  linkedinUrl: string | null;
  sourceUrl: string;
  confidence: "low" | "medium" | "high";
}

/** Reject any model-proposed person the sources do not actually support. Pure and unit-tested. */
export function verifyPeople(
  candidates: z.infer<typeof peopleSchema>["people"],
  sources: Source[],
  company: { name: string; domain: string },
): VerifiedPerson[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const out: VerifiedPerson[] = [];
  for (const c of candidates) {
    const src = byId.get(c.sourceId);
    if (!src) continue;
    const name = c.name.trim();
    const title = c.jobTitle.trim();
    if (name.split(/\s+/).length < 2 || !title) continue;
    const haystack = norm(`${src.title} ${src.content}`);
    if (!haystack.includes(norm(name))) continue;
    if (!haystack.includes(norm(title))) continue;
    const companyMentioned = haystack.includes(norm(company.name)) || haystack.includes(company.domain) || src.url.includes(company.domain);
    if (!companyMentioned) continue;

    const nameAt = haystack.indexOf(norm(name));
    const titleAt = haystack.indexOf(norm(title), Math.max(0, nameAt - 160));
    const close = titleAt >= 0 && Math.abs(titleAt - nameAt) <= 160;
    const isProfile = /linkedin\.com\/in\//i.test(src.url);

    const email = c.email?.trim();
    const emailOk = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && src.content.toLowerCase().includes(email.toLowerCase());
    let linkedinUrl: string | null = null;
    if (isProfile) linkedinUrl = src.url;
    else if (c.linkedinUrl && /linkedin\.com\/in\//i.test(c.linkedinUrl) && src.content.includes(c.linkedinUrl.replace(/\/$/, ""))) linkedinUrl = c.linkedinUrl;

    out.push({
      name,
      jobTitle: title,
      email: emailOk ? email! : null,
      linkedinUrl,
      sourceUrl: src.url,
      confidence: isProfile && close ? "high" : close ? "medium" : "low",
    });
  }
  return out;
}

export async function findDecisionMakers(scope: Scope, prospectId: string, deps: ResearchDeps) {
  const prospect = await requireProspect(scope, prospectId);
  const roles = "founder OR CEO OR \"managing director\" OR \"marketing director\" OR \"head of marketing\" OR \"head of ecommerce\" OR \"ecommerce manager\" OR \"SEO manager\"";
  const [general, linkedin] = await Promise.all([
    deps.search.search(`"${prospect.name}" ${prospect.domain} ${roles}`, { maxResults: 6 }),
    deps.search.search(`"${prospect.name}" ${roles}`, { maxResults: 6, includeDomains: ["linkedin.com"] }).catch(() => [] as SearchResult[]),
  ]);
  const sources = toSources([...general, ...linkedin], "P", 12);
  if (sources.length === 0) return 0;
  const { people } = await completeJson(
    deps.ai,
    [
      { role: "system", content: PEOPLE_RULES },
      {
        role: "user",
        content: JSON.stringify({
          company: { name: prospect.name, domain: prospect.domain },
          sources: sources.map((s) => ({ id: s.id, url: s.url, title: s.title, content: clip(s.content, 1000) })),
        }),
      },
    ],
    peopleSchema,
  );
  let added = 0;
  for (const v of verifyPeople(people, sources, { name: prospect.name, domain: prospect.domain })) {
    try {
      await addContact(
        { workspaceId: scope.workspaceId, userId: scope.userId },
        prospectId,
        { name: v.name, jobTitle: v.jobTitle, email: v.email ?? "", linkedinUrl: v.linkedinUrl ?? "", sourceType: "research", sourceUrl: v.sourceUrl, confidence: v.confidence },
        { attributeToUser: false },
      );
      added++;
    } catch (e) {
      if (!(e instanceof AppError && e.kind === "conflict")) throw e;
    }
  }
  return added;
}
