import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { AppError, toUserMessage } from "@/lib/errors";
import { completeJson } from "@/lib/providers/ai";
import type { SearchProvider, SearchResult } from "@/lib/providers/search";
import { safeFetchText } from "@/lib/net/safe-fetch";
import { logActivity, parseWebsite, type Scope } from "@/lib/services/common";
import { enqueueJob } from "@/lib/jobs/queue";
import { analyseHtml, DETECTABLE_PLATFORMS } from "./inspect";
import type { ResearchDeps } from "./research";

/** Domains that are publishers, directories or social networks rather than the prospect company itself. */
export const NON_COMPANY_DOMAINS = new Set([
  "wikipedia.org", "linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com", "youtube.com", "tiktok.com",
  "reddit.com", "medium.com", "quora.com", "pinterest.com", "trustpilot.com", "glassdoor.com", "indeed.com", "crunchbase.com",
  "forbes.com", "bbc.co.uk", "bbc.com", "theguardian.com", "telegraph.co.uk", "independent.co.uk", "ft.com", "bloomberg.com",
  "techcrunch.com", "wired.com", "g2.com", "capterra.com", "clutch.co", "yell.com", "companieshouse.gov.uk", "gov.uk",
  "shopify.com", "bigcommerce.com", "wordpress.org", "google.com", "amazon.com", "amazon.co.uk", "ebay.com", "ebay.co.uk",
  "econsultancy.com", "searchenginejournal.com", "semrush.com", "ahrefs.com", "moz.com", "builtwith.com", "similarweb.com",
  "similartech.com", "wappalyzer.com", "myip.ms", "hubspot.com", "mailchimp.com", "squarespace.com", "wix.com", "woocommerce.com",
  "magento.com", "adobe.com", "wpbeginner.com", "themeforest.net", "github.com", "stackoverflow.com", "yelp.com", "bing.com",
]);

export function isNonCompanyDomain(domain: string) {
  const d = domain.toLowerCase();
  return [...NON_COMPANY_DOMAINS].some((x) => d === x || d.endsWith("." + x));
}

const interpretSchema = z.object({
  summary: z.string(),
  searchQueries: z.array(z.string().min(3)).min(1).max(8),
  requiredPlatform: z.string().nullish(),
});

const candidatesSchema = z.object({
  companies: z
    .array(z.object({ name: z.string(), website: z.string().nullish(), reason: z.string(), sourceId: z.string() }))
    .default([]),
});
type RawCandidate = z.infer<typeof candidatesSchema>["companies"][number];

const INTERPRET_RULES = `You turn a sales user's request for prospects into web search queries.
Return {"summary": one sentence restating the target, "searchQueries": 5-8 queries, "requiredPlatform": the ecommerce/CMS platform the prospects must currently run (e.g. "WooCommerce", "Shopify") or null}.
Query rules:
- Plain natural language, the way a person would type into Google. NO search operators (no site:, no quotes, no OR).
- The goal is pages that NAME individual companies or are company websites themselves: "best UK outdoor clothing brands", "independent UK furniture online stores", "UK pet supplies retailers", "UK beauty brands that sell direct".
- Spread the queries across different sub-sectors and phrasings so results do not overlap.
- If the request names a technology or platform, do NOT search for technology directories or lists of sites built with it (they are not company websites). Search for the kinds of companies instead; the platform is verified separately by inspecting each site.
- Keep any location, size or maturity constraints from the request.
Do not invent company names. Do not include the user's own company. Respond with one JSON object.`;

const EXTRACT_RULES = `You extract candidate prospect companies from web search results for a sales user.
Strict rules:
- Only return real companies that are named in the supplied sources. Never add companies from your own knowledge.
- "website" is the company's OWN website domain if the source states it (in text or a link); otherwise null. Never guess a domain.
- "sourceId" is the source that names the company.
- Skip directories, publishers, agencies selling to the user, marketplaces and social networks. Skip anything that clearly does not fit the request (wrong country, wrong type of business).
- "reason" is one sentence on why it matches the request, based only on the source.
- Return up to 30 companies. Respond with one JSON object: {"companies":[{"name","website","reason","sourceId"}]}`;

export interface VerifiedCandidate {
  name: string;
  website: string;
  domain: string;
  reason: string;
  sourceUrl: string;
}
export interface UnresolvedCandidate {
  name: string;
  reason: string;
  sourceUrl: string;
}
type Src = { id: string; url: string; content: string; title: string };

/** Separate candidates whose domain genuinely appears in the cited source from ones that still need a domain looked up. */
export function splitCandidates(candidates: RawCandidate[], sources: Src[]) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const verified: VerifiedCandidate[] = [];
  const unresolved: UnresolvedCandidate[] = [];
  for (const c of candidates) {
    const src = byId.get(c.sourceId);
    const name = c.name.trim();
    if (!src || !name) continue;
    const site = c.website ? parseWebsite(c.website) : null;
    if (site) {
      if (isNonCompanyDomain(site.domain) || seen.has(site.domain)) continue;
      const text = `${src.url} ${src.title} ${src.content}`.toLowerCase();
      if (text.includes(site.domain)) {
        seen.add(site.domain);
        verified.push({ name, website: site.website, domain: site.domain, reason: c.reason.trim(), sourceUrl: src.url });
        continue;
      }
    }
    unresolved.push({ name, reason: c.reason.trim(), sourceUrl: src.url });
  }
  return { verified, unresolved };
}

/** Keep only candidates whose domain genuinely appears in the cited source. */
export function verifyCandidates(candidates: RawCandidate[], sources: Src[]): VerifiedCandidate[] {
  return splitCandidates(candidates, sources).verified;
}

const STOP = new Set(["the", "ltd", "limited", "plc", "llp", "uk", "co", "company", "and", "group", "store", "shop", "online"]);
function brandTokens(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t));
}

/** Does this domain plausibly belong to the named company? Used when resolving a domain from search results. */
export function domainMatchesBrand(domain: string, name: string) {
  const label = domain.toLowerCase().replace(/^www\./, "").split(".")[0].replace(/[^a-z0-9]/g, "");
  const tokens = brandTokens(name);
  if (tokens.length === 0 || label.length < 3) return false;
  const joined = tokens.join("");
  return label === joined || label.includes(joined) || joined.includes(label) || (tokens[0].length >= 4 && label.includes(tokens[0]));
}

/** Find a company's own site by searching for it; accepts a result only if its domain matches the brand name. */
export async function resolveDomain(name: string, search: SearchProvider, hint: string) {
  const results = await search.search(`${name} official website ${hint}`.trim(), { maxResults: 6 }).catch(() => [] as SearchResult[]);
  for (const r of results) {
    const site = parseWebsite(r.url);
    if (!site || isNonCompanyDomain(site.domain)) continue;
    if (domainMatchesBrand(site.domain, name)) return { ...site, sourceUrl: r.url };
  }
  return null;
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

async function defaultCheckSite(website: string) {
  const home = await safeFetchText(website, { timeoutMs: 10_000 });
  if (!home || home.status >= 400 || !home.body) return { reachable: false, platform: null as string | null };
  return { reachable: true, platform: analyseHtml(home.body, home.url).platform };
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
const MAX_CANDIDATES = 30;

export interface DiscoveryStats {
  queries: number;
  searchResults: number;
  pagesRead: number;
  candidatesNamed: number;
  domainsFromSource: number;
  domainsResolved: number;
  unresolved: number;
  platformRequired: string | null;
  platformMatched: number;
  platformRejected: number;
  unreachable: number;
  alreadyInWorkspace: number;
  created: number;
}

export async function runDiscovery(scope: Scope, runId: string, deps: ResearchDeps & { checkSite?: typeof defaultCheckSite }) {
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

    // 1. Search
    const settled = await Promise.allSettled(plan.searchQueries.map((q) => deps.search.search(q, { maxResults: 8 })));
    const failures = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    const results: SearchResult[] = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
    if (results.length === 0) {
      if (failures[0]) throw failures[0].reason;
      throw new AppError("empty_response", "The web search returned no results for that request. Try rephrasing it.");
    }
    const seenUrls = new Set<string>();
    const unique = results.filter((r) => (seenUrls.has(r.url) ? false : (seenUrls.add(r.url), true))).slice(0, 30);
    const sources: Src[] = unique.map((r, i) => ({ id: `S${i + 1}`, url: r.url, title: r.title, content: r.content.slice(0, 900) }));

    // 2. Read the full text of list-style pages, which usually name many companies at once.
    const listy = unique.filter((r) => /best|top\b|\d{2}|list|brands|stores|retailers|round-?up|directory/i.test(r.title)).slice(0, 3);
    let pagesRead = 0;
    if (listy.length) {
      const pages = await deps.search.extract(listy.map((r) => r.url)).catch(() => []);
      pages.forEach((p, i) => {
        sources.push({ id: `E${i + 1}`, url: p.url, title: listy.find((l) => l.url === p.url)?.title ?? p.url, content: p.content.slice(0, 7000) });
        pagesRead++;
      });
    }

    // 3. Ask the model who is named
    const extracted = await completeJson(
      deps.ai,
      [
        { role: "system", content: EXTRACT_RULES },
        { role: "user", content: JSON.stringify({ request: run.query, interpretedAs: plan.summary, sources }) },
      ],
      candidatesSchema,
    );
    const { verified, unresolved } = splitCandidates(extracted.companies, sources);

    // 4. Look up the website for companies that were named without one (domain must match the brand name)
    const hint = /\buk\b|united kingdom|british/i.test(run.query) ? "UK" : "";
    const resolved = await inBatches(unresolved.slice(0, 15), 4, async (u) => ({ u, r: await resolveDomain(u.name, deps.search, hint) }));
    const have = new Set(verified.map((v) => v.domain));
    let domainsResolved = 0;
    for (const { u, r } of resolved) {
      if (!r || have.has(r.domain)) continue;
      have.add(r.domain);
      domainsResolved++;
      verified.push({ name: u.name, website: r.website, domain: r.domain, reason: u.reason, sourceUrl: u.sourceUrl });
    }

    // 5. If the request requires a platform, confirm it by looking at each site
    const wanted = plan.requiredPlatform?.trim();
    const canVerify = wanted ? DETECTABLE_PLATFORMS.find((p) => p.toLowerCase() === wanted.toLowerCase()) : undefined;
    let candidates = verified.slice(0, MAX_CANDIDATES);
    let platformRejected = 0;
    let unreachable = 0;
    const platformOf = new Map<string, string | null>();
    if (canVerify) {
      const checked = await inBatches(candidates, 5, async (c) => ({ c, s: await (deps.checkSite ?? defaultCheckSite)(c.website).catch(() => ({ reachable: false, platform: null })) }));
      candidates = [];
      for (const { c, s } of checked) {
        if (!s.reachable) unreachable++;
        else if (s.platform !== canVerify) platformRejected++;
        else {
          platformOf.set(c.domain, s.platform);
          candidates.push({ ...c, reason: `${c.reason} Site runs on ${canVerify}.` });
        }
      }
    }
    const platformMatched = canVerify ? candidates.length : 0;

    // 6. Save
    let created = 0;
    let already = 0;
    for (const c of candidates.slice(0, MAX_NEW_PER_RUN)) {
      const [row] = await db
        .insert(schema.prospects)
        .values({
          workspaceId: scope.workspaceId,
          name: c.name,
          website: c.website,
          domain: c.domain,
          description: null,
          ecommercePlatform: platformOf.get(c.domain) ?? null,
          technology: platformOf.get(c.domain) ? [platformOf.get(c.domain)!] : [],
          discoverySource: "discovery",
          discoveryRunId: runId,
          discoverySourceUrl: c.sourceUrl,
          researchStatus: created < AUTO_RESEARCH_PER_RUN ? "queued" : "none",
          createdBy: scope.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) {
        already++;
        continue;
      }
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
    const stats: DiscoveryStats = {
      queries: plan.searchQueries.length,
      searchResults: results.length,
      pagesRead,
      candidatesNamed: extracted.companies.length,
      domainsFromSource: verified.length - domainsResolved,
      domainsResolved,
      unresolved: unresolved.length - domainsResolved,
      platformRequired: canVerify ?? null,
      platformMatched,
      platformRejected,
      unreachable,
      alreadyInWorkspace: already,
      created,
    };
    await db
      .update(schema.discoveryRuns)
      .set({ status: "done", resultsCount: created, stats, finishedAt: new Date() })
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

export async function listDiscoveryRuns(scope: Scope, limit = 8) {
  const runs = await db
    .select()
    .from(schema.discoveryRuns)
    .where(eq(schema.discoveryRuns.workspaceId, scope.workspaceId))
    .orderBy(desc(schema.discoveryRuns.createdAt))
    .limit(limit);
  if (runs.length === 0) return [];
  const found = await db
    .select({
      id: schema.prospects.id,
      runId: schema.prospects.discoveryRunId,
      name: schema.prospects.name,
      domain: schema.prospects.domain,
      score: schema.prospects.opportunityScore,
      researchStatus: schema.prospects.researchStatus,
      sourceUrl: schema.prospects.discoverySourceUrl,
    })
    .from(schema.prospects)
    .where(and(eq(schema.prospects.workspaceId, scope.workspaceId), inArray(schema.prospects.discoveryRunId, runs.map((r) => r.id))))
    .orderBy(desc(schema.prospects.createdAt));
  return runs.map((r) => ({ ...r, prospects: found.filter((f) => f.runId === r.id) }));
}
