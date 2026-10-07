import Link from "next/link";
import { ExternalLink, Mail } from "lucide-react";
import { Empty, PageHead, Pager, qs } from "@/components/ui";
import { requireContext } from "@/lib/auth";
import { safeHref, timeAgo } from "@/lib/format";
import { listContacts } from "@/lib/services/contacts";

export const metadata = { title: "Contacts" };

export default async function ContactsPage({ searchParams }: { searchParams: Promise<{ q?: string; relevance?: string; uncontacted?: string; page?: string }> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const page = /^\d+$/.test(sp.page ?? "") ? parseInt(sp.page!, 10) : 1;
  const relevance = sp.relevance === "primary" || sp.relevance === "relevant" || sp.relevance === "other" ? sp.relevance : undefined;
  const res = await listContacts({ workspaceId: ctx.workspace.id, userId: ctx.user.id }, { q: sp.q?.slice(0, 100), relevance, uncontactedOnly: sp.uncontacted === "1", page, pageSize: 30 });
  const filtered = Boolean(sp.q || sp.relevance || sp.uncontacted);

  return (
    <>
      <PageHead title="Contacts" sub="People at your prospects, found in public sources or added by your team." />
      <form className="filters" action="/contacts">
        <input className="search" name="q" defaultValue={sp.q ?? ""} placeholder="Search name, title or company…" aria-label="Search contacts" />
        <select name="relevance" defaultValue={sp.relevance ?? ""} aria-label="Relevance">
          <option value="">All roles</option><option value="primary">Decision makers</option><option value="relevant">Relevant</option><option value="other">Other</option>
        </select>
        <select name="uncontacted" defaultValue={sp.uncontacted ?? ""} aria-label="Contact status">
          <option value="">Any</option><option value="1">Not yet contacted</option>
        </select>
        <button className="btn">Apply</button>
        {filtered && <Link className="btn ghost" href="/contacts">Clear</Link>}
      </form>
      <div className="card">
        {res.total === 0 ? (
          filtered ? <Empty title="No contacts match these filters." /> : (
            <Empty title="No contacts yet." href="/prospects" cta="Go to prospects">Open a prospect and use “Find decision makers”, or add a contact manually.</Empty>
          )
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Name</th><th>Title</th><th>Company</th><th>Relevance</th><th className="hide-sm">Confidence</th><th className="hide-sm">Last contacted</th></tr></thead>
                <tbody>
                  {res.rows.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.name}</strong>
                        <div className="row faint" style={{ gap: 8 }}>
                          {c.email && <a href={`mailto:${c.email}`}><Mail size={11} /> {c.email}</a>}
                          {safeHref(c.linkedinUrl) && <a href={safeHref(c.linkedinUrl)} target="_blank" rel="noopener noreferrer"><ExternalLink size={11} /> LinkedIn</a>}
                        </div>
                      </td>
                      <td>{c.jobTitle ?? "—"}</td>
                      <td><Link href={`/prospects/${c.prospectId}?tab=contacts`}>{c.prospectName}</Link></td>
                      <td><span className={`badge ${c.relevance === "primary" ? "accent" : ""}`}>{c.relevance === "primary" ? "Decision maker" : c.relevance}</span></td>
                      <td className="hide-sm">{c.confidence ?? "—"}</td>
                      <td className="hide-sm muted">{timeAgo(c.lastContactedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={res.page} pageSize={res.pageSize} total={res.total} hrefFor={(p) => `/contacts${qs({ q: sp.q, relevance: sp.relevance, uncontacted: sp.uncontacted, page: p })}`} />
          </>
        )}
      </div>
    </>
  );
}
