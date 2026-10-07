import Link from "next/link";
import { Empty, PageHead, Pager, Score, qs } from "@/components/ui";
import { requireContext } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { listOpportunities } from "@/lib/services/opportunities";
import { listCategories } from "@/lib/services/workspaces";

export const metadata = { title: "Opportunities" };

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<{ category?: string; min?: string; status?: string; page?: string }> }) {
  const ctx = await requireContext();
  const scope = { workspaceId: ctx.workspace.id, userId: ctx.user.id };
  const sp = await searchParams;
  const page = /^\d+$/.test(sp.page ?? "") ? parseInt(sp.page!, 10) : 1;
  const min = /^\d+$/.test(sp.min ?? "") ? Math.min(100, parseInt(sp.min!, 10)) : undefined;
  const status = sp.status === "pursuing" || sp.status === "dismissed" || sp.status === "identified" ? sp.status : undefined;
  const [res, categories] = await Promise.all([
    listOpportunities(scope, { categoryKey: sp.category, minScore: min, status, page, pageSize: 25 }),
    listCategories(scope.workspaceId),
  ]);
  const base = { category: sp.category, min: sp.min, status: sp.status };
  const filtered = Boolean(sp.category || sp.min || sp.status);

  return (
    <>
      <PageHead title="Opportunities" sub="Evidenced gaps across your prospects, highest score first." />
      <form className="filters" action="/opportunities">
        <select name="category" defaultValue={sp.category ?? ""} aria-label="Category">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <select name="min" defaultValue={sp.min ?? ""} aria-label="Minimum score">
          <option value="">Any score</option><option value="40">40+</option><option value="60">60+</option><option value="80">80+</option>
        </select>
        <select name="status" defaultValue={sp.status ?? ""} aria-label="Status">
          <option value="">Active</option><option value="pursuing">Pursuing</option><option value="dismissed">Dismissed</option>
        </select>
        <button className="btn">Apply</button>
        {filtered && <Link className="btn ghost" href="/opportunities">Clear</Link>}
      </form>
      <div className="card">
        {res.total === 0 ? (
          filtered ? <Empty title="No opportunities match these filters." /> : (
            <Empty title="No opportunities yet." href="/prospects" cta="Go to prospects">Opportunities are identified when a prospect is researched, or you can record one manually on a prospect.</Empty>
          )
        ) : (
          <>
            {res.rows.map((o) => (
              <div key={o.id} className="opp">
                <div className="row between">
                  <span className="row"><Score value={o.score} /><strong>{o.categoryLabel}</strong><span className="muted">—</span><Link href={`/prospects/${o.prospectId}`}>{o.prospectName}</Link></span>
                  <span className="row">{o.status !== "identified" && <span className="badge">{o.status}</span>}<span className={`badge ${o.importance === "high" ? "accent" : ""}`}>{o.importance}</span></span>
                </div>
                <p style={{ margin: "6px 0 0" }}>{o.description}</p>
                {o.recommendedAction && <p className="muted" style={{ margin: "2px 0 0" }}><strong>Recommended:</strong> {o.recommendedAction}</p>}
                {o.commercialValue != null && <p className="muted" style={{ margin: "2px 0 0" }}><strong>Potential value:</strong> {formatMoney(o.commercialValue, ctx.workspace.currency)}</p>}
              </div>
            ))}
            <Pager page={res.page} pageSize={res.pageSize} total={res.total} hrefFor={(p) => `/opportunities${qs({ ...base, page: p })}`} />
          </>
        )}
      </div>
    </>
  );
}
