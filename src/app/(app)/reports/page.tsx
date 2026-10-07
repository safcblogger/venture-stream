import Link from "next/link";
import { Empty, PageHead } from "@/components/ui";
import { requireContext } from "@/lib/auth";
import { STAGE_LABELS, formatMoney, sourceLabel } from "@/lib/format";
import { reports } from "@/lib/services/reports";

export const metadata = { title: "Reports" };

export default async function ReportsPage() {
  const ctx = await requireContext();
  const cur = ctx.workspace.currency;
  const r = await reports({ workspaceId: ctx.workspace.id, userId: ctx.user.id });
  const maxFunnel = Math.max(1, ...r.funnel.map((f) => f.count));
  const hasData = r.funnel.some((f) => f.count > 0);

  if (!hasData) {
    return (
      <>
        <PageHead title="Reports" />
        <div className="card"><Empty title="Nothing to report yet." href="/discover" cta="Discover prospects">Reports are calculated from your prospects, deals and campaigns as you add them.</Empty></div>
      </>
    );
  }

  const byOpps = [...r.campaigns].sort((a, b) => b.opportunities - a.opportunities);
  const byRevenue = [...r.campaigns].sort((a, b) => b.revenue - a.revenue);

  return (
    <>
      <PageHead title="Reports" sub="Every figure here is calculated from data stored in your workspace." />
      <div className="grid cols-2">
        <section className="card">
          <div className="card-head"><h2>Which campaigns generated the most opportunities?</h2></div>
          {byOpps.length === 0 ? <Empty title="No campaigns yet." href="/campaigns" cta="Create a campaign" /> : (
            <table className="table">
              <thead><tr><th>Campaign</th><th className="right">Prospects</th><th className="right">Opportunities</th></tr></thead>
              <tbody>{byOpps.map((c) => <tr key={c.id}><td><Link href={`/campaigns/${c.id}`}>{c.name}</Link></td><td className="num">{c.prospects}</td><td className="num"><strong>{c.opportunities}</strong></td></tr>)}</tbody>
            </table>
          )}
        </section>
        <section className="card">
          <div className="card-head"><h2>Which campaigns generated the most revenue?</h2></div>
          {byRevenue.length === 0 ? <Empty title="No campaigns yet." /> : (
            <table className="table">
              <thead><tr><th>Campaign</th><th className="right">Won deals</th><th className="right">Pipeline</th><th className="right">Revenue</th></tr></thead>
              <tbody>{byRevenue.map((c) => <tr key={c.id}><td><Link href={`/campaigns/${c.id}`}>{c.name}</Link></td><td className="num">{c.won}</td><td className="num">{formatMoney(c.pipelineValue, cur)}</td><td className="num"><strong>{formatMoney(c.revenue, cur)}</strong></td></tr>)}</tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card" style={{ marginTop: 12 }}>
        <div className="card-head"><h2>Which prospect sources produce the highest-value opportunities?</h2></div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Source</th><th className="right">Prospects</th><th className="right">Avg score</th><th className="right">Deals</th><th className="right">Largest deal</th><th className="right">Open pipeline</th><th className="right">Revenue won</th></tr></thead>
            <tbody>
              {r.sources.map((s) => (
                <tr key={s.source}>
                  <td>{sourceLabel(s.source)}</td>
                  <td className="num">{s.prospects}</td>
                  <td className="num">{s.avgScore ?? "—"}</td>
                  <td className="num">{s.deals}</td>
                  <td className="num">{s.deals ? formatMoney(s.biggestDeal, cur) : "—"}</td>
                  <td className="num">{formatMoney(s.pipelineValue, cur)}</td>
                  <td className="num"><strong>{formatMoney(s.revenue, cur)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid cols-2" style={{ marginTop: 12 }}>
        <section className="card">
          <div className="card-head"><h2>Pipeline funnel</h2></div>
          <div className="card-body stack">
            {r.funnel.map((f) => (
              <div key={f.stage}>
                <div className="row between"><Link href={`/prospects?stage=${f.stage}`}>{STAGE_LABELS[f.stage]}</Link><span className="mono">{f.count}</span></div>
                <div className="bar"><i style={{ width: `${(f.count / maxFunnel) * 100}%` }} /></div>
              </div>
            ))}
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h2>Opportunities by category</h2></div>
          <table className="table">
            <thead><tr><th>Category</th><th className="right">Count</th><th className="right">Avg score</th></tr></thead>
            <tbody>
              {r.categories.map((c) => (
                <tr key={c.key}><td><Link href={`/opportunities?category=${c.key}`}>{c.label}</Link></td><td className="num">{c.count}</td><td className="num">{c.avgScore ?? "—"}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
