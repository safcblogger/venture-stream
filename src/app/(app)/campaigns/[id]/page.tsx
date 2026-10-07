import Link from "next/link";
import { notFound } from "next/navigation";
import { Trash2 } from "lucide-react";
import { createTaskAction, deleteCampaignAction, removeFromCampaignAction, setCampaignStatusAction } from "@/app/actions";
import { ActionButton, ActionForm, ActionSelect } from "@/components/action";
import { Empty, Kpi, PageHead, Score, StageBadge } from "@/components/ui";
import { requireContext } from "@/lib/auth";
import { CAMPAIGN_STATUS_LABELS, formatDate, formatMoney, timeAgo } from "@/lib/format";
import { campaignProspectsList, listCampaigns } from "@/lib/services/campaigns";
import { listActivity } from "@/lib/services/prospects";
import { listTasks } from "@/lib/services/tasks";
import { listMembers } from "@/lib/services/workspaces";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  const [c] = (await params).id.match(/^[0-9a-f-]{36}$/i) ? await listCampaigns({ workspaceId: ctx.workspace.id, userId: ctx.user.id }, { campaignId: (await params).id }) : [];
  return { title: c?.name ?? "Campaign" };
}

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  const scope = { workspaceId: ctx.workspace.id, userId: ctx.user.id };
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [c] = await listCampaigns(scope, { campaignId: id });
  if (!c) notFound();
  const cur = ctx.workspace.currency;
  const [prospects, tasks, activity, members] = await Promise.all([
    campaignProspectsList(scope, id),
    listTasks(scope, { campaignId: id, pageSize: 50 }),
    listActivity(scope, { campaignId: id, limit: 20 }),
    listMembers(scope.workspaceId),
  ]);

  return (
    <>
      <PageHead title={c.name} sub={c.description ?? undefined}>
        <ActionSelect label="Campaign status" value={c.status} options={Object.entries(CAMPAIGN_STATUS_LABELS).map(([value, label]) => ({ value, label }))} action={setCampaignStatusAction.bind(null, id) as (v: string) => ReturnType<typeof setCampaignStatusAction>} />
        <ActionButton className="btn danger" confirm="Delete this campaign? Prospects are kept; deals lose their campaign attribution." action={deleteCampaignAction.bind(null, id)}><Trash2 size={14} /> Delete</ActionButton>
      </PageHead>
      {c.targetCriteria && <p className="muted"><strong>Target:</strong> {c.targetCriteria}</p>}
      <div className="kpis">
        <Kpi label="Prospects" value={c.prospects} />
        <Kpi label="Contacts" value={c.contacts} />
        <Kpi label="Opportunities" value={c.opportunities} />
        <Kpi label="Proposals" value={c.proposals} />
        <Kpi label="Won" value={c.won} />
        <Kpi label="Pipeline value" value={formatMoney(c.pipelineValue, cur)} tone="accent" />
        <Kpi label="Revenue" value={formatMoney(c.revenue, cur)} sub={c.revenueTarget != null ? `target ${formatMoney(c.revenueTarget, cur)}` : undefined} />
      </div>
      <div className="grid sidebar-right">
        <div className="stack">
          <section className="card">
            <div className="card-head"><h2>Prospects</h2><Link className="muted" href={`/prospects?campaign=${id}`}>Open in list</Link></div>
            {prospects.length === 0 ? (
              <Empty title="No prospects in this campaign.">Select prospects in the Prospects list and use “Add to campaign”, or add from a prospect&apos;s Campaigns tab.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {prospects.map((p) => (
                      <tr key={p.id}>
                        <td><Link href={`/prospects/${p.id}`}><strong>{p.name}</strong></Link><div className="faint">{p.domain}</div></td>
                        <td><StageBadge stage={p.stage} /></td>
                        <td className="muted hide-sm">Added {formatDate(p.addedAt)}</td>
                        <td className="right"><Score value={p.score} /></td>
                        <td className="right"><ActionButton className="btn sm ghost icon" confirm={`Remove ${p.name} from this campaign?`} action={removeFromCampaignAction.bind(null, id, p.id)} title="Remove"><Trash2 size={13} /></ActionButton></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="card">
            <div className="card-head"><h2>Activity</h2></div>
            {activity.length === 0 ? <Empty title="No activity yet." /> : (
              <ul className="timeline">{activity.map((a) => <li key={a.id}><span className="dot" /><div>{a.summary}<div className="meta">{timeAgo(a.createdAt)}</div></div></li>)}</ul>
            )}
          </section>
        </div>
        <section className="card">
          <div className="card-head"><h2>Campaign tasks</h2></div>
          {tasks.rows.length > 0 && (
            <ul className="timeline">
              {tasks.rows.map((t) => <li key={t.id}><span className="dot" /><div>{t.title}<div className="meta">{t.status === "complete" ? "Done" : t.dueDate ? `Due ${formatDate(t.dueDate)}` : "No date"}</div></div></li>)}
            </ul>
          )}
          <div className="card-body">
            <ActionForm action={createTaskAction.bind(null, { campaignId: id })} submit="Add task">
              <div className="field"><label htmlFor="ct-title">Title</label><input id="ct-title" name="title" required /></div>
              <div className="form-grid">
                <div className="field"><label htmlFor="ct-due">Due</label><input id="ct-due" name="dueDate" type="date" /></div>
                <div className="field"><label htmlFor="ct-own">Assign to</label><select id="ct-own" name="assignedUserId" defaultValue={scope.userId}>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select></div>
              </div>
            </ActionForm>
          </div>
        </section>
      </div>
    </>
  );
}
