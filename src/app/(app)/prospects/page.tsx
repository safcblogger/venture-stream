import { Suspense } from "react";
import { Plus } from "lucide-react";
import { ActionForm } from "@/components/action";
import { createProspectAction } from "@/app/actions";
import { ProspectFilters, ProspectTable, type Row } from "@/components/prospect-list";
import { Empty, PageHead, Pager, qs } from "@/components/ui";
import { requireContext } from "@/lib/auth";
import { listCampaigns } from "@/lib/services/campaigns";
import { distinctPlatforms, listProspects, type ProspectFilters as F } from "@/lib/services/prospects";
import { listCategories, listMembers } from "@/lib/services/workspaces";

export const metadata = { title: "Prospects" };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const intOr = (v: string | undefined) => (v && /^\d+$/.test(v) ? parseInt(v, 10) : undefined);
const UUID = /^[0-9a-f-]{36}$/i;

function filtersFromParams(sp: SP): F {
  const assigned = one(sp.assigned);
  const sort = one(sp.sort);
  const f: F = {
    q: one(sp.q)?.slice(0, 200),
    stage: one(sp.stage) as F["stage"],
    leadStatus: one(sp.leadStatus) as F["leadStatus"],
    categoryKey: one(sp.category),
    platform: one(sp.platform),
    minScore: intOr(one(sp.minScore)),
    campaignId: UUID.test(one(sp.campaign) ?? "") ? one(sp.campaign) : undefined,
    assignedUserId: assigned && UUID.test(assigned) ? assigned : undefined,
    unassigned: assigned === "none" ? true : undefined,
    contacted: one(sp.contacted) === "yes" ? true : one(sp.contacted) === "no" ? false : undefined,
    hasDecisionMaker: one(sp.dm) === "yes" ? true : one(sp.dm) === "no" ? false : undefined,
    sort: (["score", "name", "created", "updated", "stage", "last_contacted", "value"].includes(sort ?? "") ? sort : "score") as F["sort"],
    dir: one(sp.dir) === "asc" ? "asc" : "desc",
    page: intOr(one(sp.page)),
    pageSize: 25,
  };
  return f;
}

export default async function ProspectsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requireContext();
  const scope = { workspaceId: ctx.workspace.id, userId: ctx.user.id };
  const sp = await searchParams;
  const f = filtersFromParams(sp);
  const parsedStage = f.stage && !["lead", "current", "contacted", "qualified", "proposal", "negotiation", "won", "lost"].includes(f.stage) ? undefined : f.stage;
  const safe: F = { ...f, stage: parsedStage, leadStatus: ["new", "working", "nurturing", "unqualified"].includes(f.leadStatus ?? "") ? f.leadStatus : undefined };

  const [res, members, categories, platforms, campaigns] = await Promise.all([
    listProspects(scope, safe),
    listMembers(scope.workspaceId),
    listCategories(scope.workspaceId),
    distinctPlatforms(scope),
    listCampaigns(scope),
  ]);

  const rows: Row[] = res.rows.map(({ createdAt: _c, ...r }) => ({ ...r, lastContactedAt: r.lastContactedAt?.toISOString() ?? null }));

  const base = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, one(v)]));
  const sortHref = (key: string) => {
    const nextDir = f.sort === key && f.dir === "desc" ? "asc" : "desc";
    return `/prospects${qs({ ...base, sort: key, dir: nextDir, page: undefined })}`;
  };
  const filtered = Object.keys(base).some((k) => !["sort", "dir", "page"].includes(k));

  return (
    <>
      <PageHead title="Prospects" sub={`${res.total.toLocaleString("en-GB")} ${filtered ? "matching" : "in your workspace"}`}>
        <details className="card" style={{ position: "relative" }}>
          <summary className="btn primary" style={{ listStyle: "none" }}><Plus size={14} /> Add prospect</summary>
          <div className="card card-body" style={{ position: "absolute", right: 0, top: 36, width: 340, zIndex: 10 }}>
            <ActionForm action={createProspectAction} submit="Add prospect">
              <div className="field"><label htmlFor="np-name">Company</label><input id="np-name" name="name" required /></div>
              <div className="field"><label htmlFor="np-site">Website</label><input id="np-site" name="website" placeholder="example.co.uk" required /></div>
              <div className="field"><label htmlFor="np-ind">Industry</label><input id="np-ind" name="industry" /></div>
              <div className="field"><label htmlFor="np-loc">Location</label><input id="np-loc" name="location" /></div>
            </ActionForm>
          </div>
        </details>
      </PageHead>

      <Suspense>
        <ProspectFilters members={members} categories={categories.map((c) => ({ key: c.key, label: c.label }))} platforms={platforms} campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))} />
      </Suspense>

      <div className="card">
        {res.total === 0 ? (
          filtered ? (
            <Empty title="No prospects match these filters.">Try removing a filter or searching for something broader.</Empty>
          ) : (
            <Empty title="No prospects yet." href="/discover" cta="Discover prospects">
              Discover your first prospects to start building your pipeline, or add a company manually.
            </Empty>
          )
        ) : (
          <>
            <ProspectTable
              rows={rows}
              currency={ctx.workspace.currency}
              sort={f.sort ?? "score"}
              dir={f.dir ?? "desc"}
              sortHrefs={Object.fromEntries(["name", "score", "stage", "last_contacted", "value"].map((k) => [k, sortHref(k)]))}
              members={members}
              campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))}
            />
            <Pager page={res.page} pageSize={res.pageSize} total={res.total} hrefFor={(p) => `/prospects${qs({ ...base, page: p })}`} />
          </>
        )}
      </div>
    </>
  );
}
