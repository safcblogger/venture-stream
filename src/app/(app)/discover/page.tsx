import Link from "next/link";
import { AutoRefresh } from "@/components/client-bits";
import { DiscoverForm } from "@/components/discover-form";
import { Empty, PageHead, Score } from "@/components/ui";
import { requireContext } from "@/lib/auth";
import { env } from "@/lib/env";
import { safeHref, timeAgo } from "@/lib/format";
import { listDiscoveryRuns } from "@/lib/research/discovery";

export const metadata = { title: "Discover" };

export default async function DiscoverPage() {
  const ctx = await requireContext();
  const runs = await listDiscoveryRuns({ workspaceId: ctx.workspace.id, userId: ctx.user.id });
  const e = env();
  const missing = [!e.OPENAI_API_KEY && "OPENAI_API_KEY", !e.TAVILY_API_KEY && "TAVILY_API_KEY"].filter(Boolean) as string[];
  const active = runs.some((r) => r.status === "queued" || r.status === "running") || runs.some((r) => r.prospects.some((p) => p.researchStatus === "queued" || p.researchStatus === "running"));

  return (
    <>
      <PageHead title="Discover" sub="Describe who you want to sell to. Venture Stream searches the web, verifies each company against its sources, then researches it."><AutoRefresh active={active} /></PageHead>
      {missing.length > 0 && (
        <div className="alert error" style={{ marginBottom: 12 }}>
          Discovery needs {missing.join(" and ")} to be set in the server environment. See <code>.env.example</code>.
        </div>
      )}
      <DiscoverForm />

      <h2 style={{ margin: "18px 0 8px" }}>Recent discovery runs</h2>
      {runs.length === 0 ? (
        <div className="card"><Empty title="No discovery runs yet.">Describe your ideal prospects above to find real companies.</Empty></div>
      ) : (
        <div className="stack">
          {runs.map((r) => (
            <section key={r.id} className="card">
              <div className="card-head">
                <div className="grow">
                  <strong>{r.query}</strong>
                  <div className="faint">
                    {timeAgo(r.createdAt)}
                    {r.interpreted ? ` · Interpreted as: ${(r.interpreted as { summary?: string }).summary ?? ""}` : ""}
                  </div>
                </div>
                <span className={`badge ${r.status === "done" ? "ok" : r.status === "failed" ? "danger" : "info"}`}>{r.status === "done" ? `${r.resultsCount} new` : r.status}</span>
              </div>
              {r.status === "failed" && <div className="card-body"><div className="alert error">{r.error ?? "Discovery failed."}</div></div>}
              {r.status === "done" && r.prospects.length === 0 && (
                <div className="card-body muted">No new companies were found that could be verified against their sources. Try rephrasing or being more specific.</div>
              )}
              {r.prospects.length > 0 && (
                <div className="table-wrap">
                  <table className="table">
                    <tbody>
                      {r.prospects.map((p) => (
                        <tr key={p.id}>
                          <td><Link href={`/prospects/${p.id}`}><strong>{p.name}</strong></Link><div className="faint">{p.domain}</div></td>
                          <td className="muted hide-sm">{safeHref(p.sourceUrl) ? <a href={safeHref(p.sourceUrl)} target="_blank" rel="noopener noreferrer">found in source</a> : ""}</td>
                          <td className="muted">{p.researchStatus === "done" ? "Researched" : p.researchStatus === "failed" ? "Research failed" : p.researchStatus === "none" ? "Not researched" : "Researching…"}</td>
                          <td className="right"><Score value={p.score} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
