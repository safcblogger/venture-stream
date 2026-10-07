import Link from "next/link";
import type { ReactNode } from "react";
import { scoreClass, STAGE_LABELS } from "@/lib/format";

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div className="row wrap">{children}</div>}
    </div>
  );
}

export function Empty({ title, children, href, cta }: { title: string; children?: ReactNode; href?: string; cta?: string }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {href && cta && (
        <Link className="btn primary" href={href}>
          {cta}
        </Link>
      )}
    </div>
  );
}

export function Score({ value }: { value: number | null | undefined }) {
  return <span className={scoreClass(value)} title="Opportunity score">{value ?? "—"}</span>;
}

const STAGE_TONE: Record<string, string> = { won: "ok", lost: "danger", qualified: "accent", proposal: "accent", negotiation: "accent", contacted: "info" };
export function StageBadge({ stage }: { stage: string }) {
  return <span className={`badge ${STAGE_TONE[stage] ?? ""}`}>{STAGE_LABELS[stage] ?? stage}</span>;
}

export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "accent" | "danger" }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${tone ?? ""}`}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function Pager({ page, pageSize, total, hrefFor }: { page: number; pageSize: number; total: number; hrefFor: (p: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="pager">
      <span>{from}–{to} of {total.toLocaleString("en-GB")}</span>
      <span className="row">
        {page > 1 ? <Link className="btn sm" href={hrefFor(page - 1)}>Previous</Link> : <span className="btn sm" aria-disabled style={{ opacity: 0.4 }}>Previous</span>}
        <span>Page {page} of {pages}</span>
        {page < pages ? <Link className="btn sm" href={hrefFor(page + 1)}>Next</Link> : <span className="btn sm" aria-disabled style={{ opacity: 0.4 }}>Next</span>}
      </span>
    </div>
  );
}

export function ProvDot({ p }: { p: "sourced" | "inferred" | "unknown" }) {
  return <span className={`prov ${p}`} title={p === "sourced" ? "Found in a source" : p === "inferred" ? "Inferred by AI" : "Unknown"} />;
}

export function ProvLegend() {
  return (
    <div className="legend">
      <span><span className="prov sourced" />Found in source</span>
      <span><span className="prov inferred" />Inferred by AI</span>
      <span><span className="prov unknown" />Unknown</span>
    </div>
  );
}

/** Build a query string from defined values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && v !== false) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}
