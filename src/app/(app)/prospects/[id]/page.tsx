import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, Mail, Search, Trash2 } from "lucide-react";
import {
  addContactAction, addNoteAction, addToCampaignAction, createDealAction, createOpportunityAction, createTaskAction, deleteContactAction,
  deleteDealAction, findContactsAction, markContactedAction, researchProspectAction, setOpportunityStatusAction, setStageAction,
  setTaskStatusAction, updateDealAction, updateProspectAction,
} from "@/app/actions";
import { ActionButton, ActionForm, ActionSelect } from "@/components/action";
import { AutoRefresh } from "@/components/client-bits";
import { OutreachPanel } from "@/components/outreach";
import { Empty, ProvDot, ProvLegend, Score, StageBadge } from "@/components/ui";
import { requireContext } from "@/lib/auth";
import {
  DEAL_STATUS_LABELS, LEAD_STATUS_LABELS, STAGE_LABELS, TASK_STATUS_LABELS, formatDate, formatDateTime, formatMoney, safeHref, timeAgo,
} from "@/lib/format";
import { campaignsForProspect, listCampaigns } from "@/lib/services/campaigns";
import { listContactsForProspect } from "@/lib/services/contacts";
import { listDealsForProspect } from "@/lib/services/deals";
import { listOpportunities } from "@/lib/services/opportunities";
import { listDrafts } from "@/lib/services/outreach";
import { getProspect, listActivity, listFacts, listNotes } from "@/lib/services/prospects";
import { listTasks, todayISO } from "@/lib/services/tasks";
import { listCategories, listMembers } from "@/lib/services/workspaces";

const TABS = [
  ["overview", "Overview"],
  ["contacts", "Contacts"],
  ["tasks", "Tasks"],
  ["activity", "Activity"],
  ["campaigns", "Campaigns & deals"],
  ["outreach", "Outreach"],
] as const;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  const p = await getProspect({ workspaceId: ctx.workspace.id, userId: ctx.user.id }, (await params).id);
  return { title: p?.name ?? "Prospect" };
}

export default async function ProspectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requireContext();
  const scope = { workspaceId: ctx.workspace.id, userId: ctx.user.id };
  const { id } = await params;
  const p = await getProspect(scope, id);
  if (!p) notFound();
  const wantedTab = (await searchParams).tab;
  const tab = TABS.some(([k]) => k === wantedTab) ? wantedTab! : "overview";
  const cur = ctx.workspace.currency;
  const busy = p.researchStatus === "queued" || p.researchStatus === "running";
  const base = `/prospects/${id}`;

  const [members, campaigns, myCampaigns] = await Promise.all([listMembers(scope.workspaceId), listCampaigns(scope), campaignsForProspect(scope, id)]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="row wrap">
            <h1>{p.name}</h1>
            <Score value={p.opportunityScore} />
            <StageBadge stage={p.pipelineStage} />
            <AutoRefresh active={busy} />
          </div>
          <p>
            {safeHref(p.website) ? <a href={safeHref(p.website)} target="_blank" rel="noopener noreferrer">{p.domain} <ExternalLink size={11} style={{ verticalAlign: -1 }} /></a> : p.domain}
            {p.industry ? ` · ${p.industry}` : ""}{p.location ? ` · ${p.location}` : ""}
            {p.ecommercePlatform ? ` · ${p.ecommercePlatform}` : ""}
          </p>
        </div>
        <div className="row wrap">
          <ActionSelect label="Pipeline stage" value={p.pipelineStage} options={Object.entries(STAGE_LABELS).map(([value, label]) => ({ value, label }))} action={setStageAction.bind(null, id)} />
          <ActionButton className="btn" action={researchProspectAction.bind(null, id)}>
            <Search size={14} /> {p.researchStatus === "done" ? "Re-run research" : "Research"}
          </ActionButton>
        </div>
      </div>

      {p.researchStatus === "failed" && p.researchError && <div className="alert error" style={{ marginBottom: 12 }}>Research failed: {p.researchError}</div>}

      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <Link key={k} href={`${base}?tab=${k}`} className={`tab${tab === k ? " active" : ""}`} role="tab" aria-selected={tab === k} replace>{label}</Link>
        ))}
      </div>

      {tab === "overview" && <Overview scope={scope} p={p} members={members} cur={cur} />}
      {tab === "contacts" && <Contacts scope={scope} id={id} />}
      {tab === "tasks" && <Tasks scope={scope} id={id} members={members} />}
      {tab === "activity" && <Activity scope={scope} id={id} />}
      {tab === "campaigns" && <CampaignsDeals scope={scope} id={id} campaigns={campaigns} mine={myCampaigns} cur={cur} />}
      {tab === "outreach" && <Outreach scope={scope} id={id} researched={p.researchStatus === "done"} />}
    </>
  );
}

type Scope = { workspaceId: string; userId: string };

async function Overview({ scope, p, members, cur }: { scope: Scope; p: NonNullable<Awaited<ReturnType<typeof getProspect>>>; members: Awaited<ReturnType<typeof listMembers>>; cur: string }) {
  const [facts, opps, categories] = await Promise.all([
    listFacts(scope, p.id),
    listOpportunities(scope, { prospectId: p.id, pageSize: 50 }),
    listCategories(scope.workspaceId),
  ]);
  const have = new Set(opps.rows.map((o) => o.categoryKey));
  return (
    <div className="grid sidebar-right">
      <div className="stack">
        <section className="card">
          <div className="card-head"><h2>Opportunities</h2><span className="faint">{opps.rows.length} identified</span></div>
          {opps.rows.length === 0 ? (
            <Empty title="No opportunities identified yet.">{p.researchStatus === "done" ? "Research found no evidenced opportunities. You can record one manually." : "Run research to look for evidenced opportunities, or record one manually."}</Empty>
          ) : (
            opps.rows.map((o) => (
              <div key={o.id} className="opp">
                <div className="row between">
                  <span className="row"><Score value={o.score} /><strong>{o.categoryLabel}</strong><span className={`badge ${o.importance === "high" ? "accent" : ""}`}>{o.importance} importance</span>{o.origin === "manual" && <span className="badge">manual</span>}{o.status === "pursuing" && <span className="badge ok">pursuing</span>}</span>
                  <span className="row">
                    {o.status !== "pursuing" && <ActionButton action={setOpportunityStatusAction.bind(null, o.id, "pursuing")}>Pursue</ActionButton>}
                    <ActionButton className="btn sm ghost" confirm="Dismiss this opportunity? It will no longer count towards the score." action={setOpportunityStatusAction.bind(null, o.id, "dismissed")}>Dismiss</ActionButton>
                  </span>
                </div>
                <p style={{ margin: "6px 0 0" }}>{o.description}</p>
                {o.evidence.length > 0 && (
                  <ul>
                    {o.evidence.map((e, i) => (
                      <li key={i}>{e.text}{safeHref(e.sourceUrl) && <> <a href={safeHref(e.sourceUrl)} target="_blank" rel="noopener noreferrer" className="faint">source</a></>}</li>
                    ))}
                  </ul>
                )}
                {o.potentialImpact && <p className="muted" style={{ margin: "6px 0 0" }}><strong>Potential impact:</strong> {o.potentialImpact}</p>}
                {o.recommendedAction && <p className="muted" style={{ margin: "2px 0 0" }}><strong>Recommended action:</strong> {o.recommendedAction}</p>}
                {o.commercialValue != null && <p className="muted" style={{ margin: "2px 0 0" }}><strong>Potential commercial value:</strong> {formatMoney(o.commercialValue, cur)}</p>}
              </div>
            ))
          )}
          <details className="card-body" style={{ borderTop: "1px solid var(--border)" }}>
            <summary className="muted" style={{ cursor: "pointer" }}>Record an opportunity manually</summary>
            <ActionForm action={createOpportunityAction.bind(null, p.id)} submit="Save opportunity" className="stack">
              <div className="form-grid">
                <div className="field"><label htmlFor="mo-cat">Category</label>
                  <select id="mo-cat" name="categoryKey" required>{categories.filter((c) => !have.has(c.key)).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></div>
                <div className="field"><label htmlFor="mo-score">Score (0–100)</label><input id="mo-score" name="score" type="number" min={0} max={100} required /></div>
                <div className="field"><label htmlFor="mo-imp">Importance</label><select id="mo-imp" name="importance" defaultValue="medium"><option>low</option><option>medium</option><option>high</option></select></div>
                <div className="field"><label htmlFor="mo-val">Commercial value ({cur})</label><input id="mo-val" name="commercialValue" inputMode="decimal" /></div>
              </div>
              <div className="field"><label htmlFor="mo-desc">Description</label><textarea id="mo-desc" name="description" rows={2} required /></div>
              <div className="field"><label htmlFor="mo-ev">Evidence</label><textarea id="mo-ev" name="evidence" rows={2} required placeholder="What did you observe?" /></div>
              <div className="field"><label htmlFor="mo-act">Recommended action</label><input id="mo-act" name="recommendedAction" /></div>
            </ActionForm>
          </details>
        </section>

        <section className="card">
          <div className="card-head"><h2>Intelligence</h2><ProvLegend /></div>
          {facts.length === 0 ? (
            <Empty title="No research collected yet.">Run research to collect observations from the company&apos;s website and public sources.</Empty>
          ) : (
            <div className="facts">
              {facts.map((f) => (
                <FactRow key={f.id} f={f} />
              ))}
            </div>
          )}
          {p.technology.length > 0 && (
            <div className="card-body row wrap" style={{ borderTop: "1px solid var(--border)" }}>
              <span className="muted"><ProvDot p="sourced" />Detected technology</span>
              {p.technology.map((t) => <span key={t} className="badge">{t}</span>)}
            </div>
          )}
          {p.researchedAt && <div className="card-body faint">Researched {formatDateTime(p.researchedAt)} · Discovered {formatDate(p.discoveredAt)} via {p.discoverySource === "discovery" ? "AI discovery" : "manual entry"}{safeHref(p.discoverySourceUrl) && <> · <a href={safeHref(p.discoverySourceUrl)} target="_blank" rel="noopener noreferrer">source</a></>}</div>}
        </section>
      </div>

      <aside className="stack">
        <section className="card">
          <div className="card-head"><h2>Company</h2></div>
          <div className="card-body">
            <ActionForm action={updateProspectAction.bind(null, p.id)} reset={false} className="stack">
              <div className="field"><label htmlFor="e-name">Company</label><input id="e-name" name="name" defaultValue={p.name} required /></div>
              <div className="field"><label htmlFor="e-ind">Industry</label><input id="e-ind" name="industry" defaultValue={p.industry ?? ""} /></div>
              <div className="field"><label htmlFor="e-loc">Location</label><input id="e-loc" name="location" defaultValue={p.location ?? ""} /></div>
              <div className="field"><label htmlFor="e-size">Company size</label><input id="e-size" name="companySize" defaultValue={p.companySize ?? ""} /></div>
              <div className="field"><label htmlFor="e-desc">Description</label><textarea id="e-desc" name="description" rows={3} defaultValue={p.description ?? ""} /></div>
              <div className="form-grid">
                <div className="field"><label htmlFor="e-status">Lead status</label>
                  <select id="e-status" name="leadStatus" defaultValue={p.leadStatus}>{Object.entries(LEAD_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                <div className="field"><label htmlFor="e-own">Assigned to</label>
                  <select id="e-own" name="assignedUserId" defaultValue={p.assignedUserId ?? ""}><option value="">Unassigned</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select></div>
                <div className="field"><label htmlFor="e-val">Estimated value ({cur})</label><input id="e-val" name="estimatedValue" inputMode="decimal" defaultValue={p.estimatedValue != null ? (p.estimatedValue / 100).toString() : ""} /></div>
              </div>
              <div className="form-grid">
                <div className="field"><label htmlFor="e-na">Next action</label><input id="e-na" name="nextAction" defaultValue={p.nextAction ?? ""} /></div>
                <div className="field"><label htmlFor="e-nad">Next action due</label><input id="e-nad" name="nextActionAt" type="date" defaultValue={p.nextActionAt ?? ""} /></div>
              </div>
            </ActionForm>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h2>Contact log</h2></div>
          <div className="card-body stack">
            <div className="muted">Last contacted: {p.lastContactedAt ? `${formatDateTime(p.lastContactedAt)} (${timeAgo(p.lastContactedAt)})` : "never"}</div>
            <ActionForm action={markContactedAction.bind(null, p.id)} submit="Log as contacted" inline>
              <input name="note" placeholder="Optional note, e.g. emailed intro" maxLength={200} />
            </ActionForm>
          </div>
        </section>
      </aside>
    </div>
  );
}

function FactRow({ f }: { f: { label: string; value: string | null; provenance: "sourced" | "inferred" | "unknown"; sourceUrl: string | null } }) {
  return (
    <>
      <div className="k"><ProvDot p={f.provenance} />{f.label}</div>
      <div>
        {f.value ?? <span className="faint">Unknown</span>}
        {safeHref(f.sourceUrl) && f.provenance === "sourced" && <> <a className="faint" href={safeHref(f.sourceUrl)} target="_blank" rel="noopener noreferrer">source</a></>}
      </div>
    </>
  );
}

async function Contacts({ scope, id }: { scope: Scope; id: string }) {
  const contacts = await listContactsForProspect(scope, id);
  return (
    <div className="grid sidebar-right">
      <section className="card">
        <div className="card-head">
          <h2>Contacts & decision makers</h2>
          <ActionButton action={findContactsAction.bind(null, id)}><Search size={13} /> Find decision makers</ActionButton>
        </div>
        {contacts.length === 0 ? (
          <Empty title="No contacts yet.">Search public sources for decision makers, or add someone you know. Venture Stream only stores people found in a real source and never guesses email addresses.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Title</th><th>Relevance</th><th>Confidence</th><th>Source</th><th /></tr></thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.name}</strong>
                      <div className="row faint" style={{ gap: 8 }}>
                        {c.email && <a href={`mailto:${c.email}`}><Mail size={11} /> {c.email}</a>}
                        {safeHref(c.linkedinUrl) && <a href={safeHref(c.linkedinUrl)} target="_blank" rel="noopener noreferrer"><ExternalLink size={11} /> LinkedIn</a>}
                      </div>
                    </td>
                    <td>{c.jobTitle ?? <span className="faint">—</span>}</td>
                    <td><span className={`badge ${c.relevance === "primary" ? "accent" : ""}`}>{c.relevance === "primary" ? "Decision maker" : c.relevance === "relevant" ? "Relevant" : "Other"}</span></td>
                    <td>{c.confidence ? <span className={`badge ${c.confidence === "high" ? "ok" : ""}`}>{c.confidence}</span> : "—"}</td>
                    <td className="faint">{safeHref(c.sourceUrl) ? <a href={safeHref(c.sourceUrl)} target="_blank" rel="noopener noreferrer">{c.sourceType === "research" ? "research" : "link"}</a> : c.sourceType}</td>
                    <td className="right"><ActionButton className="btn sm ghost icon" confirm={`Remove ${c.name}?`} action={deleteContactAction.bind(null, c.id)} title="Remove contact"><Trash2 size={13} /></ActionButton></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <div className="card-head"><h2>Add contact</h2></div>
        <div className="card-body">
          <ActionForm action={addContactAction.bind(null, id)} submit="Add contact">
            <div className="field"><label htmlFor="c-name">Name</label><input id="c-name" name="name" required /></div>
            <div className="field"><label htmlFor="c-title">Job title</label><input id="c-title" name="jobTitle" /></div>
            <div className="field"><label htmlFor="c-email">Email</label><input id="c-email" name="email" type="email" /></div>
            <div className="field"><label htmlFor="c-li">LinkedIn URL</label><input id="c-li" name="linkedinUrl" type="url" placeholder="https://www.linkedin.com/in/…" /></div>
          </ActionForm>
        </div>
      </section>
    </div>
  );
}

async function Tasks({ scope, id, members }: { scope: Scope; id: string; members: { userId: string; name: string }[] }) {
  const tasks = await listTasks(scope, { prospectId: id, pageSize: 100 });
  const today = todayISO();
  return (
    <div className="grid sidebar-right">
      <section className="card">
        <div className="card-head"><h2>Tasks</h2></div>
        {tasks.rows.length === 0 ? (
          <Empty title="No tasks for this prospect.">Create a follow-up so nothing slips.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {tasks.rows.map((t) => (
                  <tr key={t.id}>
                    <td style={{ width: 90 }}>
                      {t.status === "complete" ? <span className="badge ok">Done</span> : <ActionButton action={setTaskStatusAction.bind(null, t.id, "complete")}>Complete</ActionButton>}
                    </td>
                    <td>
                      <span style={t.status === "complete" ? { textDecoration: "line-through", color: "var(--muted)" } : undefined}>{t.title}</span>
                      {t.description && <div className="faint">{t.description}</div>}
                    </td>
                    <td className="muted">{TASK_STATUS_LABELS[t.status]}</td>
                    <td><span className={`badge ${t.priority === "high" ? "danger" : ""}`}>{t.priority}</span></td>
                    <td className={`nowrap ${t.status !== "complete" && t.dueDate && t.dueDate < today ? "" : "muted"}`} style={t.status !== "complete" && t.dueDate && t.dueDate < today ? { color: "var(--danger)" } : undefined}>{t.dueDate ? formatDate(t.dueDate) : "No date"}</td>
                    <td className="muted">{t.assignedName ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <div className="card-head"><h2>New task</h2></div>
        <div className="card-body">
          <ActionForm action={createTaskAction.bind(null, { prospectId: id })} submit="Create task">
            <div className="field"><label htmlFor="t-title">Title</label><input id="t-title" name="title" required /></div>
            <div className="field"><label htmlFor="t-desc">Description</label><textarea id="t-desc" name="description" rows={2} /></div>
            <div className="form-grid">
              <div className="field"><label htmlFor="t-due">Due date</label><input id="t-due" name="dueDate" type="date" /></div>
              <div className="field"><label htmlFor="t-pri">Priority</label><select id="t-pri" name="priority" defaultValue="medium"><option>low</option><option>medium</option><option>high</option></select></div>
              <div className="field"><label htmlFor="t-own">Assign to</label><select id="t-own" name="assignedUserId" defaultValue={scope.userId}>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select></div>
            </div>
          </ActionForm>
        </div>
      </section>
    </div>
  );
}

async function Activity({ scope, id }: { scope: Scope; id: string }) {
  const [activity, notes] = await Promise.all([listActivity(scope, { prospectId: id, limit: 200 }), listNotes(scope, id)]);
  return (
    <div className="grid sidebar-right">
      <section className="card">
        <div className="card-head"><h2>Activity timeline</h2></div>
        {activity.length === 0 ? <Empty title="No activity yet." /> : (
          <ul className="timeline">
            {activity.map((a) => (
              <li key={a.id}><span className="dot" /><div>{a.summary}<div className="meta">{formatDateTime(a.createdAt)}{a.userName ? ` · ${a.userName}` : " · system"}</div></div></li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <div className="card-head"><h2>Notes</h2></div>
        <div className="card-body stack">
          <ActionForm action={addNoteAction.bind(null, id)} submit="Add note">
            <textarea name="body" rows={3} maxLength={5000} placeholder="Write a note…" required aria-label="Note" />
          </ActionForm>
          {notes.map((n) => (
            <div key={n.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
              <div style={{ whiteSpace: "pre-wrap" }}>{n.body}</div>
              <div className="faint">{n.author ?? "Unknown"} · {formatDateTime(n.createdAt)}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

async function CampaignsDeals({ scope, id, campaigns, mine, cur }: { scope: Scope; id: string; campaigns: Awaited<ReturnType<typeof listCampaigns>>; mine: Awaited<ReturnType<typeof campaignsForProspect>>; cur: string }) {
  const deals = await listDealsForProspect(scope, id);
  const mineIds = new Set(mine.map((m) => m.id));
  const addable = campaigns.filter((c) => !mineIds.has(c.id));
  return (
    <div className="grid cols-2">
      <section className="card">
        <div className="card-head"><h2>Campaigns</h2></div>
        {mine.length === 0 ? <Empty title="Not in any campaign.">{campaigns.length === 0 ? "Create a campaign first from the Campaigns page." : "Add this prospect to a campaign below."}</Empty> : (
          <ul className="timeline">
            {mine.map((c) => <li key={c.id}><span className="dot" /><div><Link href={`/campaigns/${c.id}`}><strong>{c.name}</strong></Link> <span className="badge">{c.status}</span><div className="meta">Added {formatDate(c.addedAt)}</div></div></li>)}
          </ul>
        )}
        {addable.length > 0 && (
          <div className="card-body row" style={{ borderTop: "1px solid var(--border)" }}>
            <span className="muted">Add to</span>
            {addable.slice(0, 8).map((c) => <ActionButton key={c.id} action={addToCampaignAction.bind(null, id, c.id)}>{c.name}</ActionButton>)}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head"><h2>Deals & revenue</h2></div>
        {deals.length === 0 ? <Empty title="No deals yet.">Create a deal to track estimated, proposal and won value against this prospect.</Empty> : deals.map((d) => (
          <div key={d.id} className="opp">
            <div className="row between">
              <span className="row"><strong>{d.title}</strong><span className={`badge ${d.status === "won" ? "ok" : d.status === "lost" ? "danger" : "accent"}`}>{DEAL_STATUS_LABELS[d.status]}</span></span>
              <ActionButton className="btn sm ghost icon" confirm="Delete this deal?" action={deleteDealAction.bind(null, d.id)} title="Delete deal"><Trash2 size={13} /></ActionButton>
            </div>
            <div className="muted">Estimated {formatMoney(d.estimatedValue, cur)} · Proposal {formatMoney(d.proposalValue, cur)} · Won {formatMoney(d.wonValue, cur)}{d.campaignName ? ` · ${d.campaignName}` : ""}</div>
            <ActionForm action={updateDealAction.bind(null, d.id)} reset={false} submit="Update" className="stack">
              <div className="form-grid">
                <div className="field"><label>Status</label><select name="status" defaultValue={d.status}>{Object.entries(DEAL_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                <div className="field"><label>Estimated ({cur})</label><input name="estimatedValue" inputMode="decimal" defaultValue={d.estimatedValue != null ? String(d.estimatedValue / 100) : ""} /></div>
                <div className="field"><label>Proposal ({cur})</label><input name="proposalValue" inputMode="decimal" defaultValue={d.proposalValue != null ? String(d.proposalValue / 100) : ""} /></div>
                <div className="field"><label>Won ({cur})</label><input name="wonValue" inputMode="decimal" defaultValue={d.wonValue != null ? String(d.wonValue / 100) : ""} /></div>
              </div>
            </ActionForm>
          </div>
        ))}
        <details className="card-body" style={{ borderTop: "1px solid var(--border)" }}>
          <summary className="muted" style={{ cursor: "pointer" }}>New deal</summary>
          <ActionForm action={createDealAction.bind(null, id)} submit="Create deal">
            <div className="field"><label htmlFor="d-title">Title</label><input id="d-title" name="title" required placeholder="e.g. Technical SEO retainer" /></div>
            <div className="form-grid">
              <div className="field"><label htmlFor="d-est">Estimated value ({cur})</label><input id="d-est" name="estimatedValue" inputMode="decimal" /></div>
              <div className="field"><label htmlFor="d-prop">Proposal value ({cur})</label><input id="d-prop" name="proposalValue" inputMode="decimal" /></div>
              <div className="field"><label htmlFor="d-camp">Campaign</label><select id="d-camp" name="campaignId" defaultValue=""><option value="">Auto / none</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            </div>
          </ActionForm>
        </details>
      </section>
    </div>
  );
}

async function Outreach({ scope, id, researched }: { scope: Scope; id: string; researched: boolean }) {
  const [contacts, drafts, opps] = await Promise.all([listContactsForProspect(scope, id), listDrafts(scope, id), listOpportunities(scope, { prospectId: id, pageSize: 1 })]);
  return (
    <OutreachPanel
      prospectId={id}
      contacts={contacts.map((c) => ({ id: c.id, name: c.name, jobTitle: c.jobTitle }))}
      drafts={drafts.map((d) => ({ id: d.id, subject: d.subject, body: d.body, instruction: d.instruction, updatedAt: d.updatedAt.toISOString() }))}
      canGenerate={researched || opps.total > 0}
    />
  );
}
