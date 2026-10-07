import Link from "next/link";
import { Trash2 } from "lucide-react";
import { createTaskAction, deleteTaskAction, setTaskStatusAction } from "@/app/actions";
import { ActionButton, ActionForm, ActionSelect } from "@/components/action";
import { Empty, PageHead, Pager, qs } from "@/components/ui";
import { requireContext } from "@/lib/auth";
import { TASK_STATUS_LABELS, formatDate } from "@/lib/format";
import { listTasks, taskCounts, todayISO, type TaskView } from "@/lib/services/tasks";
import { listMembers } from "@/lib/services/workspaces";

export const metadata = { title: "Tasks" };

const VIEWS: [TaskView, string][] = [["today", "Today"], ["upcoming", "Upcoming"], ["overdue", "Overdue"], ["completed", "Completed"]];

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ view?: string; page?: string; mine?: string }> }) {
  const ctx = await requireContext();
  const scope = { workspaceId: ctx.workspace.id, userId: ctx.user.id };
  const sp = await searchParams;
  const view = (VIEWS.find(([v]) => v === sp.view)?.[0] ?? "today") as TaskView;
  const page = /^\d+$/.test(sp.page ?? "") ? parseInt(sp.page!, 10) : 1;
  const mine = sp.mine === "1";
  const [res, counts, members] = await Promise.all([
    listTasks(scope, { view, page, pageSize: 30, assignedUserId: mine ? scope.userId : undefined }),
    taskCounts(scope),
    listMembers(scope.workspaceId),
  ]);
  const today = todayISO();

  return (
    <>
      <PageHead title="Tasks" sub="Follow-ups and to-dos across your prospects and campaigns." />
      <div className="grid sidebar-right">
        <div>
          <div className="tabs">
            {VIEWS.map(([v, label]) => (
              <Link key={v} href={`/tasks${qs({ view: v, mine: mine ? 1 : undefined })}`} className={`tab${view === v ? " active" : ""}`}>
                {label} <span className="faint">{counts[v as "today" | "upcoming" | "overdue" | "completed"]}</span>
              </Link>
            ))}
            <span className="grow" />
            <Link className="tab" href={`/tasks${qs({ view, mine: mine ? undefined : 1 })}`}>{mine ? "Showing: mine" : "Showing: everyone"}</Link>
          </div>
          <div className="card">
            {res.rows.length === 0 ? (
              <Empty title={view === "completed" ? "No completed tasks yet." : `No ${view} tasks.`}>{view === "completed" ? "Completed tasks will appear here." : "Create a task to track your next follow-up."}</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {res.rows.map((t) => {
                      const late = t.status !== "complete" && t.dueDate != null && t.dueDate < today;
                      return (
                        <tr key={t.id}>
                          <td style={{ width: 92 }}>
                            {t.status === "complete" ? <ActionButton action={setTaskStatusAction.bind(null, t.id, "open")}>Reopen</ActionButton> : <ActionButton action={setTaskStatusAction.bind(null, t.id, "complete")}>Complete</ActionButton>}
                          </td>
                          <td>
                            <div style={t.status === "complete" ? { textDecoration: "line-through", color: "var(--muted)" } : undefined}>{t.title}</div>
                            <div className="faint">
                              {t.prospectId && <Link href={`/prospects/${t.prospectId}?tab=tasks`}>{t.prospectName}</Link>}
                              {t.campaignId && <> · <Link href={`/campaigns/${t.campaignId}`}>{t.campaignName}</Link></>}
                              {t.description ? ` · ${t.description}` : ""}
                            </div>
                          </td>
                          <td className="hide-sm">
                            {t.status !== "complete" && <ActionSelect label="Task status" value={t.status} options={[{ value: "open", label: "Open" }, { value: "in_progress", label: "In progress" }]} action={setTaskStatusAction.bind(null, t.id) as (v: string) => ReturnType<typeof setTaskStatusAction>} />}
                            {t.status === "complete" && <span className="muted">{TASK_STATUS_LABELS[t.status]} {t.completedAt ? formatDate(t.completedAt) : ""}</span>}
                          </td>
                          <td><span className={`badge ${t.priority === "high" ? "danger" : ""}`}>{t.priority}</span></td>
                          <td className="nowrap" style={late ? { color: "var(--danger)" } : { color: "var(--muted)" }}>{t.dueDate ? formatDate(t.dueDate) : "No date"}</td>
                          <td className="muted hide-sm">{t.assignedName ?? ""}</td>
                          <td className="right"><ActionButton className="btn sm ghost icon" confirm="Delete this task?" action={deleteTaskAction.bind(null, t.id)} title="Delete task"><Trash2 size={13} /></ActionButton></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {res.total > 0 && <Pager page={res.page} pageSize={res.pageSize} total={res.total} hrefFor={(p) => `/tasks${qs({ view, page: p, mine: mine ? 1 : undefined })}`} />}
          </div>
        </div>
        <section className="card">
          <div className="card-head"><h2>New task</h2></div>
          <div className="card-body">
            <ActionForm action={createTaskAction.bind(null, {})} submit="Create task">
              <div className="field"><label htmlFor="nt-title">Title</label><input id="nt-title" name="title" required /></div>
              <div className="field"><label htmlFor="nt-desc">Description</label><textarea id="nt-desc" name="description" rows={2} /></div>
              <div className="form-grid">
                <div className="field"><label htmlFor="nt-due">Due date</label><input id="nt-due" name="dueDate" type="date" defaultValue={today} /></div>
                <div className="field"><label htmlFor="nt-pri">Priority</label><select id="nt-pri" name="priority" defaultValue="medium"><option>low</option><option>medium</option><option>high</option></select></div>
                <div className="field"><label htmlFor="nt-own">Assign to</label><select id="nt-own" name="assignedUserId" defaultValue={scope.userId}>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select></div>
              </div>
              <p className="faint">To attach a task to a prospect, create it from the prospect&apos;s Tasks tab.</p>
            </ActionForm>
          </div>
        </section>
      </div>
    </>
  );
}
