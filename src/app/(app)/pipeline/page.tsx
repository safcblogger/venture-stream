import { PipelineBoard } from "@/components/pipeline-board";
import { Empty, PageHead } from "@/components/ui";
import { requireContext } from "@/lib/auth";
import { pipelineBoard } from "@/lib/services/prospects";

export const metadata = { title: "Pipeline" };

export default async function PipelinePage() {
  const ctx = await requireContext();
  const cols = await pipelineBoard({ workspaceId: ctx.workspace.id, userId: ctx.user.id });
  const total = cols.reduce((n, c) => n + c.total, 0);
  return (
    <>
      <PageHead title="Pipeline" sub="Drag a card to another stage, or use the stage menu on the card." />
      {total === 0 ? (
        <div className="card"><Empty title="No prospects in your pipeline." href="/discover" cta="Discover prospects">New prospects start in the Lead stage.</Empty></div>
      ) : (
        <PipelineBoard columns={cols} currency={ctx.workspace.currency} />
      )}
    </>
  );
}
