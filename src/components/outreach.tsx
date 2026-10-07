"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { deleteDraftAction, generateOutreachAction, updateDraftAction } from "@/app/actions";
import { CopyButton } from "./client-bits";
import { formatDateTime } from "@/lib/format";

interface Draft {
  id: string;
  subject: string | null;
  body: string;
  instruction: string;
  updatedAt: string;
}

const PRESETS = [
  "Write a short introduction explaining the technical SEO opportunity identified for this company.",
  "Write a brief, friendly follow-up referencing the opportunity we identified.",
];

export function OutreachPanel({
  prospectId,
  contacts,
  drafts,
  canGenerate,
}: {
  prospectId: string;
  contacts: { id: string; name: string; jobTitle: string | null }[];
  drafts: Draft[];
  canGenerate: boolean;
}) {
  const router = useRouter();
  const [instruction, setInstruction] = useState(PRESETS[0]);
  const [contactId, setContactId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const generate = (draftId?: string, instr = instruction, cId = contactId) => {
    setError(null);
    start(async () => {
      const r = await generateOutreachAction(prospectId, { instruction: instr, contactId: cId || null, draftId: draftId ?? null });
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  };

  return (
    <div className="stack">
      <div className="alert info">
        Drafts are generated from this prospect&apos;s stored research only and are <strong>not sent</strong> — Venture Stream has no sending integration. Copy a draft into your email client.
      </div>
      {!canGenerate && <div className="alert info">Run research on this prospect first so the message can be based on real findings.</div>}
      <div className="card card-body stack">
        <div className="field">
          <label htmlFor="o-ins">What should the message say?</label>
          <textarea id="o-ins" rows={3} value={instruction} maxLength={1000} onChange={(e) => setInstruction(e.target.value)} />
          <div className="row wrap">
            {PRESETS.map((p) => <button key={p} type="button" className="chip" onClick={() => setInstruction(p)}>{p.split(".")[0].slice(0, 46)}…</button>)}
          </div>
        </div>
        <div className="row wrap">
          <div className="field grow" style={{ minWidth: 200 }}>
            <label htmlFor="o-contact">Recipient</label>
            <select id="o-contact" value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">No named recipient</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.jobTitle ? ` — ${c.jobTitle}` : ""}</option>)}
            </select>
          </div>
          <button className="btn primary" style={{ alignSelf: "flex-end" }} disabled={pending || !canGenerate} onClick={() => generate()}>
            {pending ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Generate
          </button>
        </div>
        {error && <div className="alert error" role="alert">{error}</div>}
      </div>
      {drafts.map((d) => <DraftCard key={d.id} draft={d} onRegenerate={() => generate(d.id, d.instruction, contactId)} busy={pending} />)}
    </div>
  );
}

function DraftCard({ draft, onRegenerate, busy }: { draft: Draft; onRegenerate: () => void; busy: boolean }) {
  const router = useRouter();
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [body, setBody] = useState(draft.body);
  const [saved, setSaved] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // A regenerate replaces the stored draft: pick up the new text when props change.
  const [seen, setSeen] = useState(draft.updatedAt);
  if (seen !== draft.updatedAt) {
    setSeen(draft.updatedAt);
    setSubject(draft.subject ?? "");
    setBody(draft.body);
    setSaved(true);
  }
  return (
    <div className="card">
      <div className="card-head">
        <span className="row"><span className="badge warn">Draft · not sent</span><span className="faint">{formatDateTime(draft.updatedAt)}</span></span>
        <span className="row">
          <button className="btn sm" disabled={busy} onClick={onRegenerate}><RefreshCw size={12} /> Regenerate</button>
          <CopyButton text={subject ? `Subject: ${subject}\n\n${body}` : body} />
          <button className="btn sm danger" onClick={() => start(async () => { await deleteDraftAction(draft.id); router.refresh(); })}>Delete</button>
        </span>
      </div>
      <div className="card-body stack">
        <div className="field"><label>Subject</label><input value={subject} maxLength={200} onChange={(e) => { setSubject(e.target.value); setSaved(false); }} /></div>
        <div className="field"><label>Message</label><textarea rows={9} value={body} onChange={(e) => { setBody(e.target.value); setSaved(false); }} /></div>
        <div className="row">
          <button
            className="btn sm"
            disabled={pending || saved}
            onClick={() => start(async () => {
              const r = await updateDraftAction(draft.id, { subject, body });
              if (!r.ok) setError(r.error);
              else { setError(null); setSaved(true); }
            })}
          >
            {saved ? "Saved" : "Save edits"}
          </button>
          {error && <span className="alert error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
