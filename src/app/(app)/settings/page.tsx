import { Trash2 } from "lucide-react";
import { addMemberAction, removeMemberAction, removeSecretAction, saveSecretAction } from "@/app/actions";
import { secretStatus } from "@/lib/secrets";
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
  const status = await secretStatus(ctx.workspace.id);
  const integrations = [
    { name: "OpenAI (AI assistant, research, outreach)", detail: `model ${e.OPENAI_MODEL}`, secret: "openai_api_key" as const, help: "platform.openai.com → API keys" },
    { name: "Tavily (web search for discovery and research)", detail: "tavily.com → API keys", secret: "tavily_api_key" as const, help: "app.tavily.com" },
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
          <div className="card-body stack">
            {integrations.map((i) => {
              const s = status[i.secret];
              return (
                <div key={i.secret} className="stack" style={{ paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
                  <div className="row between">
                    <div><strong>{i.name}</strong><div className="faint">{i.detail}</div></div>
                    {s.source === "app" ? <span className="badge ok">Saved · ends {s.last4}</span> : s.source === "env" ? <span className="badge ok">Set on server</span> : <span className="badge danger">Not set</span>}
                  </div>
                  {canManage ? (
                    <>
                      <ActionForm action={saveSecretAction.bind(null, i.secret)} submit={s.source === "app" ? "Replace key" : "Save key"} inline>
                        <input name="value" type="password" autoComplete="off" spellCheck={false} placeholder={`Paste your ${i.secret === "openai_api_key" ? "OpenAI" : "Tavily"} API key`} aria-label={`${i.name} API key`} required />
                      </ActionForm>
                      {s.source === "app" && <div><ActionButton className="btn sm ghost danger" confirm="Remove this saved key?" action={removeSecretAction.bind(null, i.secret)}>Remove saved key</ActionButton></div>}
                    </>
                  ) : <div className="faint">Only owners and admins can change keys.</div>}
                  <div className="faint">Get one at {i.help}</div>
                </div>
              );
            })}
            <div className="faint">Keys are encrypted before they&apos;re stored and are never shown again or sent to your browser. Anything you save here overrides a server setting.</div>
          </div>
        </section>
      </div>
    </>
  );
}
