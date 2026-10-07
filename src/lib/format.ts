/** Money is stored as integer minor units. */
export function formatMoney(minor: number | null | undefined, currency = "GBP"): string {
  if (minor === null || minor === undefined) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(minor / 100);
}

/** Parse a user-entered amount like "12,500" or "£1,250.50" into minor units. Returns null for blank, NaN for invalid. */
export function parseMoneyInput(raw: FormDataEntryValue | null | undefined): number | null {
  const s = String(raw ?? "").replace(/[£$€,\s]/g, "");
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return Number.NaN;
  return Math.round(parseFloat(s) * 100);
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(d));
}

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(d));
}

export function timeAgo(d: Date | string | null | undefined, now = Date.now()): string {
  if (!d) return "never";
  const s = Math.max(0, Math.round((now - new Date(d).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return formatDate(d);
}

export const STAGE_LABELS: Record<string, string> = {
  lead: "Lead",
  current: "Current",
  contacted: "Contacted",
  qualified: "Qualified",
  proposal: "Proposal",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

export const LEAD_STATUS_LABELS: Record<string, string> = {
  new: "New",
  working: "Working",
  nurturing: "Nurturing",
  unqualified: "Unqualified",
};

export const TASK_STATUS_LABELS: Record<string, string> = { open: "Open", in_progress: "In progress", complete: "Complete" };
export const CAMPAIGN_STATUS_LABELS: Record<string, string> = { draft: "Draft", active: "Active", paused: "Paused", completed: "Completed" };
export const DEAL_STATUS_LABELS: Record<string, string> = { open: "Open", proposal: "Proposal", won: "Won", lost: "Lost" };

export function scoreClass(score: number | null | undefined) {
  if (score == null) return "score";
  return score >= 70 ? "score hi" : score >= 45 ? "score mid" : "score";
}

export function sourceLabel(source: string) {
  return source === "discovery" ? "AI discovery" : source === "manual" ? "Manual" : source;
}

/** Only http(s) URLs may be rendered as links; anything else (e.g. javascript:) becomes undefined. */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}
