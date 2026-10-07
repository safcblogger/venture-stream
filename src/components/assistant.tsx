"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Plus, SendHorizontal, Sparkles, X } from "lucide-react";
import { Markdown } from "./markdown";

interface Msg {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
}

const SUGGESTIONS = [
  "Best prospects for Shopify SEO",
  "Prospects with decision makers",
  "Overdue follow-ups",
  "Highest-value opportunities",
  "Best-performing campaigns",
  "What should I work on today?",
];

export function Assistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [restored, setRestored] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Restore the most recent conversation the first time the panel opens.
  useEffect(() => {
    if (!open || restored) return;
    setRestored(true);
    fetch("/api/assistant")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.messages?.length) {
          setConversationId(d.conversationId);
          setMessages(d.messages);
        }
      })
      .catch(() => {});
  }, [open, restored]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, loading]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || loading) return;
      setInput("");
      setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", content: message }]);
      setLoading(true);
      try {
        const res = await fetch("/api/assistant", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId, message }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "The assistant could not answer. Please try again.");
        setConversationId(data.conversationId);
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", content: data.reply }]);
      } catch (e) {
        const msg = e instanceof TypeError ? "Could not reach the server. Check your connection and try again." : (e as Error).message;
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "error", content: msg }]);
      } finally {
        setLoading(false);
      }
    },
    [conversationId, loading],
  );

  if (!open) {
    return (
      <button className="fab" aria-label="Open AI Sales Assistant" title="AI Sales Assistant" onClick={() => setOpen(true)}>
        <Sparkles size={22} />
      </button>
    );
  }

  return (
    <section className="assistant" role="dialog" aria-label="AI Sales Assistant">
      <div className="as-head">
        <span className="mark"><Bot size={16} /></span>
        <div className="grow">
          <strong>Sales Assistant</strong>
          <div className="muted" style={{ fontSize: 11.5 }}>Answers from your Venture Stream data only</div>
        </div>
        {messages.length > 0 && (
          <button className="btn ghost icon sm" title="New conversation" aria-label="New conversation" onClick={() => { setMessages([]); setConversationId(null); }}>
            <Plus size={15} />
          </button>
        )}
        <button className="btn ghost icon sm" aria-label="Close assistant" onClick={() => setOpen(false)}>
          <X size={16} />
        </button>
      </div>
      <div className="as-body" ref={bodyRef} aria-live="polite">
        {messages.length === 0 && !loading && (
          <>
            <p className="muted">Ask about your prospects, opportunities, tasks, campaigns or revenue.</p>
            <div className="suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="msg user">{m.content}</div>
          ) : m.role === "error" ? (
            <div key={m.id} className="msg error alert error" role="alert">{m.content}</div>
          ) : (
            <div key={m.id} className="msg assistant"><Markdown text={m.content} /></div>
          ),
        )}
        {loading && (
          <div className="msg assistant" aria-label="Assistant is thinking">
            <span className="typing"><i /><i /><i /></span>
          </div>
        )}
      </div>
      <form
        className="as-foot"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          placeholder="Ask about your pipeline…"
          aria-label="Message"
          maxLength={2000}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        <button className="btn primary icon" disabled={loading || !input.trim()} aria-label="Send">
          <SendHorizontal size={15} />
        </button>
      </form>
    </section>
  );
}
