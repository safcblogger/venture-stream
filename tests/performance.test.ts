import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { newWorkspace } from "./helpers/fixtures";
import { db } from "@/db";
import { listProspects, pipelineBoard } from "@/lib/services/prospects";
import { dashboard, reports } from "@/lib/services/reports";

/** Bulk-loads generated rows straight into the test database to prove list/report queries stay fast at scale. */
describe("scale", () => {
  it("lists, filters, searches and reports over 5,000 prospects quickly", async () => {
    const s = await newWorkspace("perf");
    await db.execute(sql`
      insert into prospects (workspace_id, name, domain, website, industry, ecommerce_platform, opportunity_score, pipeline_stage, discovery_source)
      select ${s.workspaceId}, 'Company ' || g, 'company-' || g || '.test.co.uk', 'https://company-' || g || '.test.co.uk',
             (array['Fashion','Outdoor','Homeware','Beauty'])[1 + g % 4],
             (array['Shopify','WooCommerce','Magento'])[1 + g % 3],
             g % 100,
             ((array['lead','current','contacted','qualified','proposal','negotiation','won','lost'])[1 + g % 8])::pipeline_stage,
             case when g % 2 = 0 then 'discovery' else 'manual' end
      from generate_series(1, 5000) g`);
    const timed = async <T>(fn: () => Promise<T>) => {
      const t = performance.now();
      const r = await fn();
      return { r, ms: performance.now() - t };
    };
    const list = await timed(() => listProspects(s, { sort: "score", dir: "desc", pageSize: 25 }));
    expect(list.r.total).toBe(5000);
    expect(list.r.rows).toHaveLength(25);
    const search = await timed(() => listProspects(s, { q: "company-42", platform: "Shopify", stage: "lead" }));
    const filtered = await timed(() => listProspects(s, { minScore: 80, stage: "qualified", page: 3 }));
    const board = await timed(() => pipelineBoard(s));
    const dash = await timed(() => dashboard(s));
    const rep = await timed(() => reports(s));
    console.log("perf ms", { list: list.ms | 0, search: search.ms | 0, filtered: filtered.ms | 0, board: board.ms | 0, dash: dash.ms | 0, rep: rep.ms | 0 });
    for (const t of [list, search, filtered, board, dash, rep]) expect(t.ms).toBeLessThan(1500);
    expect((await dash.r).totalProspects).toBe(5000);
  });
});
