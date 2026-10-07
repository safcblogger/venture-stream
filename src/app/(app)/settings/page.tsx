import { Trash2 } from "lucide-react";
import { addMemberAction, removeMemberAction } from "@/app/actions";
import { ActionButton, ActionForm } from "@/components/action";
import { PageHead } from "@/components/ui";
import { requireContext } from "@/lib/auth";
import { env } from "@/lib/env";
import { listMembers } from "@/lib/services/workspaces";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await requireContext();
  const members = await listMembers(ctx.workspace.id);
  const canManage = ctx.role !== "member";
  const e = env();
  const integrations = [
    { name: "AI provider", detail: `${e.AI_PROVIDER} · ${e.OPENAI_MODEL}`, ok: Boolean(e.OPENAI_API_KEY), key: "OPENAI_API_KEY" },
    { name: "Web search", detail: e.SEARCH_PROVIDER, ok: Boolean(e.TAVILY_API_KEY), key: "TAVILY_API_KEY" },
  ];
  return (
    <>
      <PageHead title="Settings" sub={`${ctx.workspace.name} · you are ${ctx.role === "owner" ? "the owner" : `an ${ctx.role}`}`} />
      <div className="grid cols-2">
        <section className="card">
          <div className="card-head"><h2>Team</h2></div>
          <table className="table">
            <tbody>
              {members.map((m) => (
                <tr key={m.userId}>
                  <td><strong>{m.name}</strong><div className="faint">{m.email}</div></td>
                  <td><span className={`badge ${m.role === "owner" ? "accent" : ""}`}>{m.role}</span></td>
                  <td className="right">{canManage && m.role !== "owner" && m.userId !== ctx.user.id && <ActionButton className="btn sm ghost icon" confirm={`Remove ${m.name} from this workspace?`} action={removeMemberAction.bind(null, m.userId)} title="Remove"><Trash2 size={13} /></ActionButton>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {canManage ? (
            <div className="card-body" style={{ borderTop: "1px solid var(--border)" }}>
              <ActionForm action={addMemberAction} submit="Add member">
                <div className="form-grid">
                  <div className="field"><label htmlFor="m-email">Email of an existing account</label><input id="m-email" name="email" type="email" required /></div>
                  <div className="field"><label htmlFor="m-role">Role</label><select id="m-role" name="role" defaultValue="member"><option value="member">Member</option><option value="admin">Admin</option></select></div>
                </div>
                <p className="faint">Members see all of this workspace&apos;s prospects, tasks and campaigns. They need to create an account first.</p>
              </ActionForm>
            </div>
          ) : (
            <div className="card-body muted">Only owners and admins can manage the team.</div>
          )}
        </section>
        <section className="card">
          <div className="card-head"><h2>Integrations</h2></div>
          <table className="table">
            <tbody>
              {integrations.map((i) => (
                <tr key={i.name}>
                  <td><strong>{i.name}</strong><div className="faint">{i.detail}</div></td>
                  <td>{i.ok ? <span className="badge ok">Configured</span> : <span className="badge danger">Missing {i.key}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="card-body faint">API keys are server-side environment variables and are never sent to the browser. Change them in the deployment environment.</div>
        </section>
      </div>
    </>
  );
}
