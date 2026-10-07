import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { AppError, toUserMessage } from "@/lib/errors";
import { completeJson } from "@/lib/providers/ai";
import type { SearchResult } from "@/lib/providers/search";
import { logActivity, parseWebsite, type Scope } from "@/lib/services/common";
import { enqueueJob } from "@/lib/jobs/queue";
import type { ResearchDeps } from "./research";

/** Domains that are publishers, directories or social networks rather than the prospect company itself. */
export const NON_COMPANY_DOMAINS = new Set([
  "wikipedia.org", "linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com", "youtube.com", "tiktok.com",
  "reddit.com", "medium.com", "quora.com", "pinterest.com", "trustpilot.com", "glassdoor.com", "indeed.com", "crunchbase.com",
  "forbes.com", "bbc.co.uk", "bbc.com", "theguardian.com", "telegraph.co.uk", "independent.co.uk", "ft.com", "bloomberg.com",
  "techcrunch.com", "wired.com", "g2.com", "capterra.com", "clutch.co", "yell.com", "companieshouse.gov.uk", "gov.uk",
  "shopify.com", "bigcommerce.com", "wordpress.org", "google.com", "amazon.com", "amazon.co.uk", "ebay.com", "ebay.co.uk",
  "econsultancy.com", "searchenginejournal.com", "semrush.com", "ahrefs.com", "moz.com", "builtwith.com", "similarweb.com",
]);

export function isNonCompanyDomain(domain: string) {
  const d = domain.toLowerCase();
  return [...NON_COMPANY_DOMAINS].some((x) => d === x || d.endsWith("." + x));
}

const interpretSchema = z.object({
  summary: z.string(),
  searchQueries: z.array(z.string().min(3)).min(1).max(4),
});

const candidatesSchema = z.object({
  companies: z
    .array(z.object({ name: z.string(), website: z.string(), reason: z.string(), sourceId: z.string() }))
    .default([]),
});

const INTERPRET_RULES = `You turn a sales user's request for prospects into web search queries.
Return {"summary": one sentence restating the target in plain words, "searchQueries": 2-4 distinct, concise web search queries likely to surface pages that list or describe matching companies}.
Do not invent company names. Do not include the user's own company. Respond with one JSON object.`;

const EXTRACT_RULES = `You extract candidate prospect companies from web search results for a sales user.
Strict rules:
- Only return real companies that appear in the supplied sources. Never add companies from your own knowledge.
- "website" must be the company's OWN website domain, and it must appear in the text or URL of the source you cite (sourceId). If it is not stated, skip the company.
- Skip directories, publishers, agencies selling to the user, marketplaces and social networks.
- "reason" is one sentence on why it matches the request, based only on the source.
- Return at most 15 companies. Respond with one JSON object: {"companies":[{"name","website","reason","sourceId"}]}`;

export interface VerifiedCandidate {
  name: string;
  website: string;
  domain: string;
  reason: string;
  sourceUrl: string;
}

/** Keep only candidates whose domain genuinely appears in the cited source. */
export function verifyCandidates(
  candidates: z.infer<typeof candidatesSchema>["companies"],
  sources: { id: string; url: string; content: string; title: string }[],
): VerifiedCandidate[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const out: VerifiedCandidate[] = [];
  for (const c of candidates) {
    const src = byId.get(c.sourceId);
    const site = parseWebsite(c.website);
    if (!src || !site || !c.name.trim()) continue;
    if (isNonCompanyDomain(site.domain) || seen.has(site.domain)) continue;
    const text = `${src.url} ${src.title} ${src.content}`.toLowerCase();
    if (!text.includes(site.domain)) continue;
    seen.add(site.domain);
    out.push({ name: c.name.trim(), website: site.website, domain: site.domain, reason: c.reason.trim(), sourceUrl: src.url });
  }
  return out;
}

export async function createDiscoveryRun(scope: Scope, query: string) {
  const q = query.trim();
  if (q.length < 8) throw new AppError("validation", "Describe the prospects you want in a little more detail.");
  if (q.length > 1000) throw new AppError("validation", "Keep the request under 1,000 characters.");
  const [run] = await db.insert(schema.discoveryRuns).values({ workspaceId: scope.workspaceId, userId: scope.userId, query: q }).returning();
  await enqueueJob({ type: "discovery", workspaceId: scope.workspaceId, payload: { runId: run.id, userId: scope.userId } });
  return run;
}

const MAX_NEW_PER_RUN = 15;
const AUTO_RESEARCH_PER_RUN = 10;

export async function runDiscovery(scope: Scope, runId: string, deps: ResearchDeps) {
  const [run] = await db
    .select()
    .from(schema.discoveryRuns)
    .where(and(eq(schema.discoveryRuns.id, runId), eq(schema.discoveryRuns.workspaceId, scope.workspaceId)));
  if (!run) throw new AppError("not_found", "That discovery run was not found.");
  await db.update(schema.discoveryRuns).set({ status: "running", error: null }).where(eq(schema.discoveryRuns.id, runId));

  try {
    const plan = await completeJson(
      deps.ai,
      [
        { role: "system", content: INTERPRET_RULES },
        { role: "user", content: run.query },
      ],
      interpretSchema,
    );
    await db.update(schema.discoveryRuns).set({ interpreted: plan }).where(eq(schema.discoveryRuns.id, runId));

    const settled = await Promise.allSettled(plan.searchQueries.map((q) => deps.search.search(q, { maxResults: 8 })));
    const failures = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    const results: SearchResult[] = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
    if (results.length === 0) {
      if (failures[0]) throw failures[0].reason;
      throw new AppError("empty_response", "The web search returned no results for that request. Try rephrasing it.");
    }
    const seenUrls = new Set<string>();
    const sources = results
      .filter((r) => (seenUrls.has(r.url) ? false : (seenUrls.add(r.url), true)))
      .slice(0, 20)
      .map((r, i) => ({ id: `S${i + 1}`, url: r.url, title: r.title, content: r.content.slice(0, 900) }));

    const extracted = await completeJson(
      deps.ai,
      [
        { role: "system", content: EXTRACT_RULES },
        { role: "user", content: JSON.stringify({ request: run.query, interpretedAs: plan.summary, sources }) },
      ],
      candidatesSchema,
    );
    const candidates = verifyCandidates(extracted.companies, sources).slice(0, MAX_NEW_PER_RUN);

    let created = 0;
    for (const c of candidates) {
      const [row] = await db
        .insert(schema.prospects)
        .values({
          workspaceId: scope.workspaceId,
          name: c.name,
          website: c.website,
          domain: c.domain,
          description: null,
          discoverySource: "discovery",
          discoveryRunId: runId,
          discoverySourceUrl: c.sourceUrl,
          researchStatus: created < AUTO_RESEARCH_PER_RUN ? "queued" : "none",
          createdBy: scope.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) continue; // already in this workspace
      created++;
      await logActivity(scope, {
        type: "prospect_discovered",
        summary: `Discovered ${c.name} (${c.domain}): ${c.reason}`,
        prospectId: row.id,
        metadata: { runId, sourceUrl: c.sourceUrl },
        attributeToUser: false,
      });
      if (row.researchStatus === "queued") {
        await enqueueJob({ type: "research", workspaceId: scope.workspaceId, payload: { prospectId: row.id, userId: scope.userId } });
      }
    }
    await db
      .update(schema.discoveryRuns)
      .set({ status: "done", resultsCount: created, finishedAt: new Date() })
      .where(eq(schema.discoveryRuns.id, runId));
    return created;
  } catch (err) {
    await db
      .update(schema.discoveryRuns)
      .set({ status: "failed", error: toUserMessage(err).message, finishedAt: new Date() })
      .where(eq(schema.discoveryRuns.id, runId));
    throw err;
  }
}
