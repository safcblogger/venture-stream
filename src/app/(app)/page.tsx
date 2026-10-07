import Link from "next/link";
import { requireContext } from "@/lib/auth";
import { dashboard } from "@/lib/services/reports";
import { formatMoney, timeAgo } from "@/lib/format";
import { Empty, Kpi, PageHead, Score, StageBadge } from "@/components/ui";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const ctx = await requireContext();
  const d = await dashboard({ workspaceId: ctx.workspace.id, userId: ctx.user.id });
  const cur = ctx.workspace.currency;

  if (d.totalProspects === 0) {
    return (
      <>
        <PageHead title="Dashboard" sub={`Welcome, ${ctx.user.name.split(" ")[0]}.`} />
        <div className="card">
          <Empty title="No prospects yet." href="/discover" cta="Discover prospects">
            Discover your first prospects to start building your pipeline. Describe the companies you want to find, or add one manually from the Prospects page.
          </Empty>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead title="Dashboard" sub="Live view of your prospecting and pipeline." />
      <div className="kpis">
        <Kpi label="Total prospects" value={d.totalProspects.toLocaleString("en-GB")} sub={`${d.newProspects} new in 7 days`} />
        <Kpi label="Qualified" value={d.qualifiedProspects} sub="at Qualified stage" />
        <Kpi label="Active opportunities" value={d.activeOpportunities} />
        <Kpi label="Open tasks" value={d.openTasks} />
        <Kpi label="Overdue tasks" value={d.overdueTasks} tone={d.overdueTasks > 0 ? "danger" : undefined} />
        <Kpi label="Pipeline value" value={formatMoney(d.pipelineValue, cur)} sub="open + proposal deals" tone="accent" />
        <Kpi label="Revenue won" value={formatMoney(d.revenue, cur)} sub={`${d.dealCount} deal${d.dealCount === 1 ? "" : "s"} tracked`} />
      </div>

      <div className="grid cols-2">
        <section className="card">
          <div className="card-head"><h2>Highest-opportunity prospects</h2><Link href="/prospects?sort=score" className="muted">View all</Link></div>
          {d.topProspects.length === 0 ? (
            <Empty title="No scored prospects yet.">Run research on a prospect to identify and score opportunities.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {d.topProspects.map((p) => (
                    <tr key={p.id}>
                      <td><Link href={`/prospects/${p.id}`}><strong>{p.name}</strong></Link><div className="faint">{p.domain}</div></td>
                      <td className="hide-sm muted">{p.platform ?? ""}</td>
                      <td><StageBadge stage={p.stage} /></td>
                      <td className="right"><Score value={p.score} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head"><h2>Campaign performance</h2><Link href="/campaigns" className="muted">View all</Link></div>
          {d.campaigns.length === 0 ? (
            <Empty title="No campaigns yet." href="/campaigns" cta="Create a campaign">Group prospects into a campaign to track opportunities and revenue.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Campaign</th><th className="right">Prospects</th><th className="right">Opps</th><th className="right">Won</th><th className="right">Revenue</th></tr></thead>
                <tbody>
                  {d.campaigns.map((c) => (
                    <tr key={c.id}>
                      <td><Link href={`/campaigns/${c.id}`}><strong>{c.name}</strong></Link></td>
                      <td className="num">{c.prospects}</td>
                      <td className="num">{c.opportunities}</td>
                      <td className="num">{c.won}</td>
                      <td className="num">{formatMoney(c.revenue, cur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <section className="card" style={{ marginTop: 12 }}>
        <div className="card-head"><h2>Recent activity</h2></div>
        {d.recentActivity.length === 0 ? (
          <Empty title="No activity yet." />
        ) : (
          <ul className="timeline">
            {d.recentActivity.map((a) => (
              <li key={a.id}>
                <span className="dot" />
                <div>
                  {a.prospectId ? <Link href={`/prospects/${a.prospectId}`}>{a.summary}</Link> : a.summary}
                  <div className="meta">{timeAgo(a.createdAt)}{a.userName ? ` · ${a.userName}` : ""}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
