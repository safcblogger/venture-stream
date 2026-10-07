import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { newProspect, newWorkspace } from "./helpers/fixtures";
import { analyseHtml } from "@/lib/research/inspect";
import { isBlockedIp, assertPublicUrl } from "@/lib/net/safe-fetch";
import { capScore, researchProspect, verifyEvidence, verifyPeople, type ResearchDeps } from "@/lib/research/research";
import { createDiscoveryRun, runDiscovery, verifyCandidates } from "@/lib/research/discovery";
import { processNextJob } from "@/lib/jobs/worker";
import { getProspect, listFacts } from "@/lib/services/prospects";
import { listOpportunities, upsertOpportunity } from "@/lib/services/opportunities";
import { listContactsForProspect } from "@/lib/services/contacts";
import type { AiProvider, CompletionRequest } from "@/lib/providers/ai";
import { TavilyProvider } from "@/lib/providers/search";
import { generateOutreach } from "@/lib/services/outreach";
import { ask, sanitizeLinks } from "@/lib/assistant/chat";
import { runTool } from "@/lib/assistant/tools";
import { AppError } from "@/lib/errors";
import { db, schema } from "@/db";

type Scripted = { content?: string | null; toolCalls?: { id: string; name: string; arguments: string }[] };

/** Scripted stand-in for the LLM. Only used in tests. */
function fakeAi(handler: (req: CompletionRequest, call: number) => Scripted): AiProvider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    name: "fake",
    calls,
    async complete(req) {
      calls.push(req);
      const r = handler(req, calls.length);
      return { content: r.content ?? null, toolCalls: r.toolCalls ?? [] };
    },
  };
}

const HTML = `<html><head><title>Shop</title><meta name="viewport" content="width=device-width">
<script src="https://cdn.shopify.com/s/files/x.js"></script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization"}</script></head>
<body><img src="a.png"><img src="b.png" alt="b"></body></html>`;

describe("site inspection", () => {
  it("reports only what is observable in the markup", () => {
    const r = analyseHtml(HTML, "https://shop.example/");
    const get = (k: string) => r.observations.find((o) => o.key === k)?.value;
    expect(r.platform).toBe("Shopify");
    expect(get("meta_description")).toMatch(/Missing/);
    expect(get("h1_count")).toBe("None found");
    expect(get("canonical")).toMatch(/Not found/);
    expect(get("structured_data")).toBe("Organization");
    expect(get("image_alt")).toBe("1 of 2");
    expect(get("viewport")).toBe("Present");
  });

  it("blocks private and loopback addresses (SSRF)", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    await expect(assertPublicUrl("http://localhost:3000")).rejects.toThrow();
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow();
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow();
  });
});

describe("evidence and score integrity", () => {
  const obs = [{ key: "meta_description", label: "x", value: "Missing" }];
  const sources = [{ id: "S1", url: "https://src.test/a", title: "t", content: "c" }];
  it("keeps only evidence that points at supplied material", () => {
    const v = verifyEvidence(
      [
        { text: "no meta description", observationKey: "meta_description" },
        { text: "from source", sourceId: "S1" },
        { text: "made up", observationKey: "made_up_key" },
        { text: "also made up", sourceId: "S9" },
      ],
      obs,
      sources,
      "https://site.test/",
    );
    expect(v).toEqual([
      { text: "no meta description", sourceUrl: "https://site.test/" },
      { text: "from source", sourceUrl: "https://src.test/a" },
    ]);
  });
  it("caps scores by amount of verified evidence", () => {
    expect(capScore(95, 1)).toBe(40);
    expect(capScore(95, 2)).toBe(55);
    expect(capScore(30, 3)).toBe(30);
    expect(capScore(100, 10)).toBe(95);
    expect(capScore(-5, 1)).toBe(0);
  });
});

describe("decision-maker verification", () => {
  const sources = [
    { id: "P1", url: "https://www.linkedin.com/in/jane-doe", title: "Jane Doe - Head of Ecommerce - Acme Outdoor | LinkedIn", content: "Jane Doe is Head of Ecommerce at Acme Outdoor." },
    { id: "P2", url: "https://news.test/acme", title: "Acme Outdoor expands", content: "Acme Outdoor (acme-outdoor.co.uk) said founder Tom Smith will lead growth. Contact press@acme-outdoor.co.uk" },
    { id: "P3", url: "https://other.test/x", title: "Unrelated", content: "Bob Jones is CEO of Another Company." },
  ];
  const company = { name: "Acme Outdoor", domain: "acme-outdoor.co.uk" };
  it("accepts supported people and rejects fabricated ones", () => {
    const out = verifyPeople(
      [
        { name: "Jane Doe", jobTitle: "Head of Ecommerce", sourceId: "P1", email: "jane.doe@acme-outdoor.co.uk" },
        { name: "Tom Smith", jobTitle: "founder", sourceId: "P2", email: "press@acme-outdoor.co.uk" },
        { name: "Invented Person", jobTitle: "CEO", sourceId: "P2" },
        { name: "Bob Jones", jobTitle: "CEO", sourceId: "P3" },
        { name: "Tom Smith", jobTitle: "CEO", sourceId: "P2" },
        { name: "Nobody", jobTitle: "CEO", sourceId: "nope" },
      ],
      sources,
      company,
    );
    expect(out.map((p) => p.name)).toEqual(["Jane Doe", "Tom Smith"]);
    expect(out[0].email).toBeNull();
    expect(out[0].linkedinUrl).toBe("https://www.linkedin.com/in/jane-doe");
    expect(out[0].confidence).toBe("high");
    expect(out[1].email).toBe("press@acme-outdoor.co.uk");
  });
});

describe("discovery candidate verification", () => {
  it("requires the domain to appear in the cited source and drops publishers", () => {
    const sources = [{ id: "S1", url: "https://list.test/a", title: "UK shops", content: "Visit examplestore.co.uk or forbes.com for more" }];
    const out = verifyCandidates(
      [
        { name: "Example Store", website: "https://examplestore.co.uk", reason: "r", sourceId: "S1" },
        { name: "Forbes", website: "forbes.com", reason: "r", sourceId: "S1" },
        { name: "Ghost", website: "ghostcompany.com", reason: "r", sourceId: "S1" },
        { name: "Example Store dup", website: "www.examplestore.co.uk", reason: "r", sourceId: "S1" },
      ],
      sources,
    );
    expect(out.map((c) => c.domain)).toEqual(["examplestore.co.uk"]);
  });
});

describe("research pipeline", () => {
  const search = {
    name: "fake",
    search: vi.fn(async (q: string) => [{ title: "Acme Outdoor - About", url: "https://acme-outdoor.co.uk/about", content: `Acme Outdoor sells camping gear in Leeds. ${q}` }]),
    extract: vi.fn(async () => []),
  };

  it("stores sourced / inferred / unknown facts and verified opportunities only", async () => {
    const s = await newWorkspace();
    const p = await newProspect(s, "Acme Outdoor", "acme-outdoor.co.uk");
    const ai = fakeAi((req) => {
      const sys = req.messages[0].content as string;
      if (sys.startsWith("You extract named people")) return { content: JSON.stringify({ people: [] }) };
      return {
        content: JSON.stringify({
          description: { value: "Camping gear retailer", sourceId: "S1" },
          industry: { value: "Outdoor retail", sourceId: null },
          location: null,
          companySize: { value: null, sourceId: null },
          opportunities: [
            { categoryKey: "technical_seo", score: 99, description: "Missing meta description", evidence: [{ text: "Homepage has no meta description", observationKey: "meta_description" }], importance: "high", potentialImpact: "i", recommendedAction: "a" },
            { categoryKey: "content", score: 90, description: "Unevidenced claim", evidence: [{ text: "invented", observationKey: "nope" }], importance: "low" },
            { categoryKey: "not_a_category", score: 50, description: "x", evidence: [{ text: "y", observationKey: "meta_description" }], importance: "low" },
          ],
        }),
      };
    });
    const deps: ResearchDeps = {
      search,
      ai,
      inspect: async () => ({ reachable: true, finalUrl: "https://acme-outdoor.co.uk/", platform: "Shopify", technologies: ["Shopify"], observations: [{ key: "meta_description", label: "Meta description", value: "Missing on the homepage" }] }),
    };
    await researchProspect(s, p.id, deps);

    const after = (await getProspect(s, p.id))!;
    expect(after.researchStatus).toBe("done");
    expect(after.ecommercePlatform).toBe("Shopify");
    expect(after.description).toBe("Camping gear retailer");
    const facts = Object.fromEntries((await listFacts(s, p.id)).map((f) => [f.key, f.provenance]));
    expect(facts).toMatchObject({ description: "sourced", industry: "inferred", location: "unknown", company_size: "unknown", ecommerce_platform: "sourced", meta_description: "sourced" });
    const opps = await listOpportunities(s, { prospectId: p.id });
    expect(opps.rows).toHaveLength(1);
    expect(opps.rows[0]).toMatchObject({ categoryKey: "technical_seo", score: 40 });
    expect(after.opportunityScore).toBe(40);
    expect(await listContactsForProspect(s, p.id)).toEqual([]);
  });

  it("marks research as failed with a safe message when the AI fails", async () => {
    const s = await newWorkspace();
    const p = await newProspect(s, "Broken Co", "broken-co.co.uk");
    const ai = fakeAi(() => ({ content: "not json" }));
    const inspect = async () => ({ reachable: false, finalUrl: null, platform: null, technologies: [], observations: [] });
    await expect(researchProspect(s, p.id, { search, ai, inspect })).rejects.toThrow(/could not be understood/);
    const after = (await getProspect(s, p.id))!;
    expect(after.researchStatus).toBe("failed");
    expect(after.researchError).toMatch(/could not be understood/);
  });
});

describe("discovery run via job queue", () => {
  it("creates prospects only from verified candidates and queues research", async () => {
    const s = await newWorkspace();
    const run = await createDiscoveryRun(s, "UK ecommerce companies using Shopify that need technical SEO help");
    const search = {
      name: "fake",
      search: async () => [{ title: "Top UK Shopify stores", url: "https://list.test/uk", content: "Notable stores: bikesrus.co.uk sells bicycles." }],
      extract: async () => [],
    };
    const ai = fakeAi((req) => {
      const sys = req.messages[0].content as string;
      if (sys.startsWith("You turn")) return { content: JSON.stringify({ summary: "UK Shopify stores", searchQueries: ["uk shopify stores"] }) };
      return {
        content: JSON.stringify({
          companies: [
            { name: "Bikes R Us", website: "bikesrus.co.uk", reason: "Bicycle shop", sourceId: "S1" },
            { name: "Phantom", website: "phantom.com", reason: "?", sourceId: "S1" },
          ],
        }),
      };
    });
    const created = await runDiscovery(s, run.id, { search, ai });
    expect(created).toBe(1);
    const [r] = await db.select().from(schema.discoveryRuns).where(eq(schema.discoveryRuns.id, run.id));
    expect(r.status).toBe("done");
    const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.workspaceId, s.workspaceId));
    expect(jobs.filter((j) => j.type === "research")).toHaveLength(1);
  });

  it("worker records a user-safe failure when search is rate limited", async () => {
    const s = await newWorkspace();
    const run = await createDiscoveryRun(s, "this will fail because search is down");
    const ai = fakeAi(() => ({ content: JSON.stringify({ summary: "x", searchQueries: ["q query"] }) }));
    const search = {
      name: "fake",
      search: async () => {
        throw new AppError("rate_limit", "Tavily web search is rate limiting requests. Please wait a moment and try again.");
      },
      extract: async () => [],
    };
    // Rate limits are retryable: 2 attempts with backoff, so force the retry due immediately.
    for (let attempt = 0; attempt < 2; attempt++) {
      await db.update(schema.jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(schema.jobs.workspaceId, s.workspaceId));
      await processNextJob(() => ({ ai, search }));
    }
    const [after] = await db.select().from(schema.discoveryRuns).where(eq(schema.discoveryRuns.id, run.id));
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/rate limiting/);
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.workspaceId, s.workspaceId));
    expect(job.status).toBe("failed");
  });
});

describe("Tavily adapter error mapping", () => {
  afterEach(() => vi.unstubAllGlobals());
  const provider = new TavilyProvider("k");
  const respond = (status: number, body: string) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));

  it("maps auth, rate limit, API, invalid and empty responses", async () => {
    respond(401, "");
    await expect(provider.search("q")).rejects.toMatchObject({ kind: "provider_auth" });
    respond(429, "");
    await expect(provider.search("q")).rejects.toMatchObject({ kind: "rate_limit" });
    respond(500, "boom");
    await expect(provider.search("q")).rejects.toMatchObject({ kind: "provider_api" });
    respond(200, "<html>");
    await expect(provider.search("q")).rejects.toMatchObject({ kind: "invalid_response" });
    respond(200, "");
    await expect(provider.search("q")).rejects.toMatchObject({ kind: "empty_response" });
    respond(200, JSON.stringify({ nope: 1 }));
    await expect(provider.search("q")).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("maps network failure and timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(provider.search("q")).rejects.toMatchObject({ kind: "network" });
    vi.stubGlobal("fetch", vi.fn(async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }));
    await expect(provider.search("q")).rejects.toMatchObject({ kind: "timeout" });
  });

  it("returns parsed results", async () => {
    respond(200, JSON.stringify({ results: [{ title: "T", url: "https://a.test", content: "c" }, { url: "" }] }));
    expect(await provider.search("q")).toEqual([{ title: "T", url: "https://a.test", content: "c" }]);
  });
});

describe("outreach", () => {
  it("refuses to write about an unresearched prospect", async () => {
    const s = await newWorkspace();
    const p = await newProspect(s, "Blank Co");
    await expect(generateOutreach(s, p.id, { instruction: "Write a short intro" }, fakeAi(() => ({ content: "{}" })))).rejects.toThrow(/Run research first/);
  });

  it("passes only stored facts to the model and saves an unsent draft", async () => {
    const s = await newWorkspace();
    const p = await newProspect(s, "Acme");
    await upsertOpportunity(s, p.id, { categoryKey: "technical_seo", score: 60, description: "No meta description", evidence: [{ text: "Homepage lacks a meta description" }], origin: "ai" });
    const ai = fakeAi(() => ({ content: JSON.stringify({ subject: "Quick note", body: "Hello, I noticed the homepage has no meta description." }) }));
    const d = await generateOutreach(s, p.id, { instruction: "Write a short introduction about the technical SEO opportunity" }, ai);
    expect(d.body).toMatch(/meta description/);
    const sent = JSON.parse(ai.calls[0].messages[1].content as string);
    expect(sent.opportunities[0].description).toBe("No meta description");
    expect(Object.keys(d)).not.toContain("sentAt");
  });
});

describe("AI assistant grounding", () => {
  it("sanitises links to records it never retrieved", () => {
    const allowed = new Map([["11111111-1111-1111-1111-111111111111", "Real Co"]]);
    const text = "[Real Co](/prospects/11111111-1111-1111-1111-111111111111), [Fake](/prospects/22222222-2222-2222-2222-222222222222), [Out](https://evil.test)";
    expect(sanitizeLinks(text, allowed)).toBe("[Real Co](/prospects/11111111-1111-1111-1111-111111111111), Fake, Out");
  });

  it("queries real data via tools, links real prospects, and carries context to follow-ups", async () => {
    const s = await newWorkspace();
    const real = await newProspect(s, "Shopify Shop");
    await upsertOpportunity(s, real.id, { categoryKey: "technical_seo", score: 77, description: "d", evidence: [{ text: "e" }], origin: "ai" });
    await db.update(schema.prospects).set({ ecommercePlatform: "Shopify" }).where(eq(schema.prospects.id, real.id));

    const ai = fakeAi((req, n) => {
      const last = req.messages[req.messages.length - 1];
      if (last.role === "tool") {
        const data = JSON.parse(last.content);
        const first = data.prospects[0];
        return { content: `Top Shopify opportunities\n- [${first.name}](${first.link}) — score **${first.opportunityScore}**\n- [Invented Co](/prospects/99999999-9999-9999-9999-999999999999)` };
      }
      return { toolCalls: [{ id: `c${n}`, name: "search_prospects", arguments: JSON.stringify({ platform: "Shopify", sort: "score" }) }] };
    });
    const first = await ask(s, "WS", { message: "Show me my best Shopify prospects" }, ai);
    expect(first.reply).toContain(`[Shopify Shop](/prospects/${real.id})`);
    expect(first.reply).toContain("**77**");
    expect(first.reply).not.toContain("/prospects/99999999");
    expect(first.reply).toContain("Invented Co");

    const ai2 = fakeAi(() => ({ content: "ok" }));
    await ask(s, "WS", { conversationId: first.conversationId, message: "Which of those have decision makers?" }, ai2);
    const joined = ai2.calls[0].messages.map((m) => ("content" in m ? m.content : "")).join("\n");
    expect(joined).toContain(`Shopify Shop (prospect id ${real.id})`);
    expect(joined).toContain("Which of those have decision makers?");
  });

  it("cannot read another user's conversation", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    const ai = fakeAi(() => ({ content: "hi" }));
    const { conversationId } = await ask(a, "A", { message: "hello there" }, ai);
    await expect(ask(b, "B", { conversationId, message: "peek" }, ai)).rejects.toThrow(/not found/);
  });

  it("tool results never include other workspaces' records", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    await newProspect(b, "Secret Competitor");
    const out = await runTool(a, "search_prospects", "{}");
    expect((out.data as { totalMatching: number }).totalMatching).toBe(0);
    const byName = await runTool(a, "get_prospect", JSON.stringify({ name: "Secret Competitor" }));
    expect(byName.entities).toEqual([]);
  });
});

describe("discovery v2: resolving websites and verifying platforms", () => {
  it("matches brand names to domains sensibly", async () => {
    const { domainMatchesBrand } = await import("@/lib/research/discovery");
    expect(domainMatchesBrand("rab.equipment", "Rab Equipment")).toBe(true);
    expect(domainMatchesBrand("www.fatface.com", "FatFace")).toBe(true);
    expect(domainMatchesBrand("the-white-company.co.uk", "The White Company")).toBe(true);
    expect(domainMatchesBrand("randomblog.com", "Rab Equipment")).toBe(false);
    expect(domainMatchesBrand("ab.com", "Rab")).toBe(false);
  });

  it("finds sites for named companies, then keeps only those on the required platform", async () => {
    const s = await newWorkspace();
    const run = await createDiscoveryRun(s, "UK retailers using WooCommerce that could move to Shopify");
    const search = {
      name: "fake",
      search: async (q: string) => {
        if (/official website/.test(q)) {
          if (/Alpha Outdoors/.test(q)) return [{ title: "Alpha Outdoors", url: "https://www.alphaoutdoors.co.uk/", content: "x" }, { title: "wiki", url: "https://en.wikipedia.org/wiki/Alpha", content: "x" }];
          if (/Beta Home/.test(q)) return [{ title: "Beta Home", url: "https://betahome.co.uk/", content: "x" }];
          return [{ title: "unrelated", url: "https://somethingelse.com/", content: "x" }];
        }
        return [{ title: "Best UK independent retailers", url: "https://list.test/uk", content: "Alpha Outdoors, Beta Home and Ghost Brand are great." }];
      },
      extract: async () => [{ url: "https://list.test/uk", content: "Full list: Alpha Outdoors, Beta Home, Ghost Brand" }],
    };
    const ai = fakeAi((req) => {
      const sys = req.messages[0].content as string;
      if (sys.startsWith("You turn")) return { content: JSON.stringify({ summary: "UK WooCommerce retailers", searchQueries: ["best uk independent retailers"], requiredPlatform: "WooCommerce" }) };
      return { content: JSON.stringify({ companies: [
        { name: "Alpha Outdoors", website: null, reason: "Outdoor retailer", sourceId: "E1" },
        { name: "Beta Home", website: null, reason: "Homeware retailer", sourceId: "E1" },
        { name: "Ghost Brand", website: null, reason: "Named in list", sourceId: "E1" },
      ] }) };
    });
    const checkSite = async (url: string) => (url.includes("alphaoutdoors") ? { reachable: true, platform: "WooCommerce" } : { reachable: true, platform: "Shopify" });
    const created = await runDiscovery(s, run.id, { search, ai, checkSite });
    expect(created).toBe(1); // Beta runs Shopify (rejected); Ghost Brand has no matching domain (dropped)
    const [r] = await db.select().from(schema.discoveryRuns).where(eq(schema.discoveryRuns.id, run.id));
    expect(r.stats).toMatchObject({ candidatesNamed: 3, domainsResolved: 2, unresolved: 1, platformRequired: "WooCommerce", platformMatched: 1, platformRejected: 1, created: 1 });
    const rows = await db.select().from(schema.prospects).where(eq(schema.prospects.workspaceId, s.workspaceId));
    expect(rows.map((p) => [p.domain, p.ecommercePlatform])).toEqual([["alphaoutdoors.co.uk", "WooCommerce"]]);
  });
});
