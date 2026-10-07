"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setStageAction } from "@/app/actions";
import { STAGE_LABELS, formatMoney, formatDate, scoreClass, timeAgo } from "@/lib/format";

interface Card {
  id: string;
  name: string;
  domain: string;
  score: number | null;
  value: number | null;
  assignedName: string | null;
  lastActivity: string | null;
  nextTaskTitle: string | null;
  nextTaskDue: string | null;
}
interface Column {
  stage: string;
  total: number;
  value: number;
  rows: Card[];
}

export function PipelineBoard({ columns, currency }: { columns: Column[]; currency: string }) {
  const router = useRouter();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const move = (id: string, stage: string) => {
    setError(null);
    start(async () => {
      const r = await setStageAction(id, stage);
      if (!r.ok) setError(r.error);
      router.refresh();
    });
  };

  return (
    <>
      {error && <div className="alert error" style={{ marginBottom: 8 }} role="alert">{error}</div>}
      <div className="board" style={{ opacity: pending ? 0.7 : 1 }}>
        {columns.map((c) => (
          <section
            key={c.stage}
            className={`col${over === c.stage ? " over" : ""}`}
            aria-label={`${STAGE_LABELS[c.stage]} stage`}
            onDragOver={(e) => { e.preventDefault(); setOver(c.stage); }}
            onDragLeave={() => setOver((o) => (o === c.stage ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData("text/plain");
              if (id && !c.rows.some((r) => r.id === id)) move(id, c.stage);
            }}
          >
            <div className="col-head">
              <strong>{STAGE_LABELS[c.stage]}</strong>
              <span className="muted mono">{c.total}{c.value > 0 ? ` · ${formatMoney(c.value, currency)}` : ""}</span>
            </div>
            <div className="col-body">
              {c.rows.length === 0 && <div className="faint" style={{ padding: 8 }}>Nothing here</div>}
              {c.rows.map((r) => (
                <article
                  key={r.id}
                  className={`pcard${dragging === r.id ? " dragging" : ""}`}
                  draggable
                  onDragStart={(e) => { e.dataTransfer.setData("text/plain", r.id); setDragging(r.id); }}
                  onDragEnd={() => setDragging(null)}
                >
                  <div className="row between">
                    <Link href={`/prospects/${r.id}`} className="t truncate">{r.name}</Link>
                    <span className={scoreClass(r.score)}>{r.score ?? "—"}</span>
                  </div>
                  <div className="m">
                    {r.value != null && <span className="mono">{formatMoney(r.value, currency)}</span>}
                    <span>{r.assignedName ?? "Unassigned"}</span>
                    <span>Active {timeAgo(r.lastActivity)}</span>
                  </div>
                  {r.nextTaskTitle && <div className="m" title={r.nextTaskTitle}>Next: <span className="truncate" style={{ maxWidth: 150 }}>{r.nextTaskTitle}</span>{r.nextTaskDue ? ` · ${formatDate(r.nextTaskDue)}` : ""}</div>}
                  <select aria-label={`Move ${r.name} to stage`} value={c.stage} onChange={(e) => move(r.id, e.target.value)}>
                    {Object.entries(STAGE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </article>
              ))}
              {c.total > c.rows.length && <Link className="muted" style={{ padding: 6 }} href={`/prospects?stage=${c.stage}`}>+{c.total - c.rows.length} more →</Link>}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
