"use client";

import { useActionState, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import type { ActionResult } from "@/app/actions";

type FormAction = (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;

/** A form bound to a server action: shows errors/success, resets on success, refreshes server data. */
export function ActionForm({
  action,
  children,
  submit = "Save",
  className,
  reset = true,
  onDone,
  inline,
}: {
  action: FormAction;
  children: ReactNode;
  submit?: string;
  className?: string;
  reset?: boolean;
  onDone?: (r: Extract<ActionResult, { ok: true }>) => void;
  inline?: boolean;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  const handled = useRef<ActionResult | null>(null);

  useEffect(() => {
    if (state && state !== handled.current && state.ok) {
      handled.current = state;
      if (reset) ref.current?.reset();
      onDone?.(state);
      router.refresh();
    }
  }, [state, reset, onDone, router]);

  return (
    <form ref={ref} action={formAction} className={className ?? "stack"}>
      {children}
      <div className={inline ? "row" : "row wrap"}>
        <button className="btn primary" disabled={pending}>
          {pending && <Loader2 size={14} className="spin" />} {submit}
        </button>
        {state && !state.ok && <span className="alert error" role="alert">{state.error}</span>}
        {state && state.ok && state.message && <span className="muted" role="status">{state.message}</span>}
      </div>
    </form>
  );
}

/** A button that invokes a bound server action, then refreshes the page's data. */
export function ActionButton({
  action,
  children,
  className = "btn sm",
  confirm,
  title,
  onDone,
}: {
  action: () => Promise<ActionResult>;
  children: ReactNode;
  className?: string;
  confirm?: string;
  title?: string;
  onDone?: (r: Extract<ActionResult, { ok: true }>) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  return (
    <>
      <button
        className={className}
        title={title}
        disabled={pending}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          setError(null);
          setNote(null);
          start(async () => {
            const r = await action();
            if (!r.ok) setError(r.error);
            else {
              if (r.message) setNote(r.message);
              onDone?.(r);
              router.refresh();
            }
          });
        }}
      >
        {pending ? <Loader2 size={13} className="spin" /> : null}
        {children}
      </button>
      {error && <span className="alert error" role="alert">{error}</span>}
      {note && <span className="muted">{note}</span>}
    </>
  );
}

/** A select that fires a server action on change (stage, status, etc.). */
export function ActionSelect({
  value,
  options,
  action,
  className = "",
  label,
}: {
  value: string;
  options: { value: string; label: string }[];
  action: (value: string) => Promise<ActionResult>;
  className?: string;
  label: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <select
        aria-label={label}
        className={className}
        value={value}
        disabled={pending}
        onChange={(e) => {
          const v = e.target.value;
          setError(null);
          start(async () => {
            const r = await action(v);
            if (!r.ok) setError(r.error);
            router.refresh();
          });
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && <span className="alert error">{error}</span>}
    </>
  );
}
