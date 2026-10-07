"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Loader2, Search } from "lucide-react";
import { bulkAction } from "@/app/actions";
import { LEAD_STATUS_LABELS, STAGE_LABELS, formatMoney, scoreClass, timeAgo } from "@/lib/format";

export interface Row {
  id: string;
  name: string;
  domain: string;
  industry: string | null;
  location: string | null;
  ecommercePlatform: string | null;
  opportunityScore: number | null;
  pipelineStage: string;
  leadStatus: string;
  assignedName: string | null;
  lastContactedAt: string | null;
  nextAction: string | null;
  estimatedValue: number | null;
  researchStatus: string;
  categories: string[];
  contactCount: number;
}

const STAGES = Object.entries(STAGE_LABELS);

/** Filter bar that writes to the URL. Text input is debounced so typing never fires a request per keystroke. */
export function ProspectFilters({
  members,
  categories,
  platforms,
  campaigns,
}: {
  members: { userId: string; name: string }[];
  categories: { key: string; label: string }[];
  platforms: string[];
  campaigns: { id: string; name: string }[];
}) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const push = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    next.delete("page");
    router.replace(`${path}${next.size ? `?${next}` : ""}`);
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  const sel = (name: string, label: string, options: { value: string; label: string }[]) => (
    <select aria-label={label} value={params.get(name) ?? ""} onChange={(e) => push({ [name]: e.target.value || null })}>
      <option value="">{label}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );

  return (
    <div className="filters">
      <div className="search" style={{ position: "relative" }}>
        <Search size={14} style={{ position: "absolute", left: 9, top: 8, color: "var(--faint)" }} />
        <input
          style={{ paddingLeft: 28 }}
          type="search"
          placeholder="Search company, domain, industry, location…"
          aria-label="Search prospects"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => push({ q: e.target.value.trim() || null }), 300);
          }}
        />
      </div>
      {sel("stage", "Any stage", STAGES.map(([value, label]) => ({ value, label })))}
      {sel("leadStatus", "Any status", Object.entries(LEAD_STATUS_LABELS).map(([value, label]) => ({ value, label })))}
      {sel("category", "Any opportunity", categories.map((c) => ({ value: c.key, label: c.label })))}
      {platforms.length > 0 && sel("platform", "Any platform", platforms.map((p) => ({ value: p, label: p })))}
      {sel("assigned", "Any owner", [{ value: "none", label: "Unassigned" }, ...members.map((m) => ({ value: m.userId, label: m.name }))])}
      {campaigns.length > 0 && sel("campaign", "Any campaign", campaigns.map((c) => ({ value: c.id, label: c.name })))}
      {sel("minScore", "Any score", [{ value: "40", label: "Score 40+" }, { value: "60", label: "Score 60+" }, { value: "80", label: "Score 80+" }])}
      {sel("contacted", "Contact status", [{ value: "no", label: "Never contacted" }, { value: "yes", label: "Contacted" }])}
      {sel("dm", "Decision makers", [{ value: "yes", label: "Has decision maker" }, { value: "no", label: "No decision maker" }])}
      {params.size > 0 && (
        <button className="btn ghost sm" onClick={() => { setQ(""); router.replace(path); }}>Clear</button>
      )}
    </div>
  );
}

export function ProspectTable({
  rows,
  currency,
  sort,
  dir,
  sortHrefs,
  members,
  campaigns,
}: {
  rows: Row[];
  currency: string;
  sort: string;
  dir: string;
  sortHrefs: Record<string, string>;
  members: { userId: string; name: string }[];
  campaigns: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const allIds = useMemo(() => rows.map((r) => r.id), [rows]);
  useEffect(() => setSelected(new Set()), [rows]);

  const run = (action: Parameters<typeof bulkAction>[1], confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setMsg(null);
    start(async () => {
      const r = await bulkAction([...selected], action);
      setMsg(r.ok ? { ok: true, text: r.message ?? "Done." } : { ok: false, text: r.error });
      if (r.ok) {
        setSelected(new Set());
        router.refresh();
      }
    });
  };

  const th = (key: string, label: string, cls = "") => (
    <th className={cls}>
      <Link href={sortHrefs[key]}>
        {label} {sort === key && (dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </Link>
    </th>
  );

  return (
    <>
      {selected.size > 0 && (
        <div className="bulkbar" role="toolbar" aria-label="Bulk actions">
          <strong>{selected.size} selected</strong>
          <select aria-label="Move to stage" defaultValue="" onChange={(e) => { if (e.target.value) run({ type: "stage", stage: e.target.value as never }); e.target.value = ""; }}>
            <option value="">Move to stage…</option>
            {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select aria-label="Assign" defaultValue="" onChange={(e) => { if (e.target.value) run({ type: "assign", userId: e.target.value === "none" ? null : e.target.value }); e.target.value = ""; }}>
            <option value="">Assign to…</option>
            <option value="none">Unassigned</option>
            {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          </select>
          {campaigns.length > 0 && (
            <select aria-label="Add to campaign" defaultValue="" onChange={(e) => { if (e.target.value) run({ type: "campaign", campaignId: e.target.value }); e.target.value = ""; }}>
              <option value="">Add to campaign…</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          <button className="btn sm" disabled={pending} onClick={() => run({ type: "research" })}>Research</button>
          <button className="btn sm danger" disabled={pending} onClick={() => run({ type: "delete" }, `Delete ${selected.size} prospect(s)? This also deletes their contacts, tasks and deals.`)}>Delete</button>
          {pending && <Loader2 size={14} className="spin" />}
          <button className="btn ghost sm" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
      {msg && <div className={`alert ${msg.ok ? "ok" : "error"}`} style={{ margin: 8 }} role="status">{msg.text}</div>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 28 }}>
                <input type="checkbox" aria-label="Select all on this page" checked={selected.size === rows.length && rows.length > 0} onChange={(e) => setSelected(e.target.checked ? new Set(allIds) : new Set())} />
              </th>
              {th("name", "Company")}
              <th className="hide-sm">Platform</th>
              <th className="hide-sm">Opportunities</th>
              {th("score", "Score", "right")}
              {th("stage", "Stage")}
              <th className="hide-sm">Owner</th>
              {th("last_contacted", "Last contact")}
              {th("value", "Value", "right")}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${r.name}`}
                    checked={selected.has(r.id)}
                    onChange={(e) => {
                      const n = new Set(selected);
                      e.target.checked ? n.add(r.id) : n.delete(r.id);
                      setSelected(n);
                    }}
                  />
                </td>
                <td>
                  <Link href={`/prospects/${r.id}`}><strong>{r.name}</strong></Link>
                  <div className="faint truncate" style={{ maxWidth: 280 }}>
                    {r.domain}{r.location ? ` · ${r.location}` : ""}
                    {r.researchStatus === "queued" || r.researchStatus === "running" ? " · researching…" : ""}
                    {r.researchStatus === "failed" ? " · research failed" : ""}
                  </div>
                </td>
                <td className="hide-sm muted">{r.ecommercePlatform ?? "—"}</td>
                <td className="hide-sm">
                  <div className="row wrap" style={{ gap: 4 }}>
                    {r.categories.slice(0, 3).map((c) => <span key={c} className="badge">{c}</span>)}
                    {r.categories.length > 3 && <span className="faint">+{r.categories.length - 3}</span>}
                    {r.categories.length === 0 && <span className="faint">—</span>}
                  </div>
                </td>
                <td className="right"><span className={scoreClass(r.opportunityScore)}>{r.opportunityScore ?? "—"}</span></td>
                <td><span className="badge">{STAGE_LABELS[r.pipelineStage]}</span></td>
                <td className="hide-sm muted">{r.assignedName ?? "—"}</td>
                <td className="muted nowrap">{timeAgo(r.lastContactedAt)}</td>
                <td className="num">{formatMoney(r.estimatedValue, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
