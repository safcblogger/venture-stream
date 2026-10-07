"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search } from "lucide-react";
import { startDiscoveryAction } from "@/app/actions";

const EXAMPLES = [
  "Find UK ecommerce companies using Shopify that look like they need technical SEO help.",
  "Find established UK companies with strong products but poor organic visibility.",
  "Find ecommerce companies that could be good prospects for our technical SEO services.",
];

export function DiscoverForm() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="card card-body stack"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const r = await startDiscoveryAction(query);
          if (!r.ok) setError(r.error);
          else {
            setQuery("");
            router.refresh();
          }
        });
      }}
    >
      <div className="field">
        <label htmlFor="dq">Describe the prospects you want to find</label>
        <textarea id="dq" rows={3} value={query} maxLength={1000} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. UK ecommerce companies using Shopify that look like they need technical SEO help" />
      </div>
      <div className="row wrap">
        {EXAMPLES.map((x) => (
          <button key={x} type="button" className="chip" onClick={() => setQuery(x)}>{x.replace(/^Find /, "").slice(0, 52)}…</button>
        ))}
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      <div>
        <button className="btn primary" disabled={pending || query.trim().length < 8}>
          {pending ? <Loader2 size={14} className="spin" /> : <Search size={14} />} Discover prospects
        </button>
      </div>
    </form>
  );
}
