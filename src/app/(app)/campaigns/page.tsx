import Link from "next/link";
import { Plus } from "lucide-react";
import { createCampaignAction } from "@/app/actions";
import { ActionForm } from "@/components/action";
import { Empty, PageHead } from "@/components/ui";
import { requireContext } from "@/lib/auth";
import { CAMPAIGN_STATUS_LABELS, formatMoney } from "@/lib/format";
import { listCampaigns } from "@/lib/services/campaigns";

export const metadata = { title: "Campaigns" };

export default async function CampaignsPage() {
  const ctx = await requireContext();
  const cur = ctx.workspace.currency;
  const campaigns = await listCampaigns({ workspaceId: ctx.workspace.id, userId: ctx.user.id });
  return (
    <>
      <PageHead title="Campaigns" sub="Group prospects, then measure the opportunities and revenue each campaign produces." />
      <div className="grid sidebar-right">
        <div className="card">
          {campaigns.length === 0 ? (
            <Empty title="No campaigns yet.">Create your first campaign, then add prospects from the Prospects list.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Campaign</th><th>Status</th><th className="right">Prospects</th><th className="right hide-sm">Contacts</th><th className="right">Opps</th><th className="right hide-sm">Proposals</th><th className="right">Won</th><th className="right">Pipeline</th><th className="right">Revenue</th></tr></thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id}>
                      <td><Link href={`/campaigns/${c.id}`}><strong>{c.name}</strong></Link><div className="faint">{c.ownerName ?? ""}</div></td>
                      <td><span className={`badge ${c.status === "active" ? "ok" : ""}`}>{CAMPAIGN_STATUS_LABELS[c.status]}</span></td>
                      <td className="num">{c.prospects}</td>
                      <td className="num hide-sm">{c.contacts}</td>
                      <td className="num">{c.opportunities}</td>
                      <td className="num hide-sm">{c.proposals}</td>
                      <td className="num">{c.won}</td>
                      <td className="num">{formatMoney(c.pipelineValue, cur)}</td>
                      <td className="num">{formatMoney(c.revenue, cur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <section className="card">
          <div className="card-head"><h2><Plus size={12} /> New campaign</h2></div>
          <div className="card-body">
            <ActionForm action={createCampaignAction} submit="Create campaign">
              <div className="field"><label htmlFor="c-name">Name</label><input id="c-name" name="name" required /></div>
              <div className="field"><label htmlFor="c-desc">Description</label><textarea id="c-desc" name="description" rows={2} /></div>
              <div className="field"><label htmlFor="c-crit">Target criteria</label><textarea id="c-crit" name="targetCriteria" rows={2} placeholder="Who is this campaign aimed at?" /></div>
              <div className="form-grid">
                <div className="field"><label htmlFor="c-status">Status</label><select id="c-status" name="status" defaultValue="draft">{Object.entries(CAMPAIGN_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                <div className="field"><label htmlFor="c-rev">Revenue target ({cur})</label><input id="c-rev" name="revenueTarget" inputMode="decimal" /></div>
              </div>
            </ActionForm>
          </div>
        </section>
      </div>
    </>
  );
}
