import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { AppError, toUserMessage } from "@/lib/errors";
import { getAiProvider } from "@/lib/providers/ai";
import { getSearchProvider } from "@/lib/providers/search";
import { runDiscovery } from "@/lib/research/discovery";
import { findDecisionMakers, researchProspect, type ResearchDeps } from "@/lib/research/research";
import { claimJob, completeJob, failJob, recoverStaleJobs } from "./queue";

type Job = typeof schema.jobs.$inferSelect;

export async function runJob(job: Job, deps: ResearchDeps) {
  const payload = job.payload as { runId?: string; prospectId?: string; userId?: string };
  if (!job.workspaceId || !payload.userId) throw new AppError("validation", "Malformed job");
  const scope = { workspaceId: job.workspaceId, userId: payload.userId };
  switch (job.type) {
    case "discovery":
      await runDiscovery(scope, payload.runId!, deps);
      return;
    case "research":
      await researchProspect(scope, payload.prospectId!, deps);
      return;
    case "contacts":
      await findDecisionMakers(scope, payload.prospectId!, deps);
      return;
    default:
      throw new AppError("validation", `Unknown job type ${job.type}`);
  }
}

/** Errors a retry cannot fix (bad credentials, missing configuration, missing records). */
const PERMANENT = new Set(["provider_auth", "not_configured", "not_found", "validation"]);

/** Process one job. Returns false when the queue is empty. */
export async function processNextJob(makeDeps: () => ResearchDeps = () => ({ ai: getAiProvider(), search: getSearchProvider() })) {
  const job = await claimJob();
  if (!job) return false;
  try {
    await runJob(job, makeDeps());
    await completeJob(job.id);
  } catch (err) {
    const { message, kind } = toUserMessage(err);
    const retried = await failJob(job.id, job.attempts, job.maxAttempts, message, !PERMANENT.has(kind));
    if (!retried && job.type === "research") {
      const id = (job.payload as { prospectId?: string }).prospectId;
      if (id) await db.update(schema.prospects).set({ researchStatus: "failed", researchError: message }).where(eq(schema.prospects.id, id));
    }
  }
  return true;
}

const g = globalThis as unknown as { __vsWorker?: NodeJS.Timeout };

/** Start the in-process worker once per server process. */
export function startWorker(concurrency = 2, intervalMs = 2000) {
  if (g.__vsWorker) return;
  let active = 0;
  g.__vsWorker = setInterval(async () => {
    while (active < concurrency) {
      active++;
      processNextJob()
        .then((had) => {
          active--;
          return had;
        })
        .catch((e) => {
          active--;
          console.error("[worker]", e);
        });
      await new Promise((r) => setTimeout(r, 50));
    }
  }, intervalMs);
  g.__vsWorker.unref?.();
  recoverStaleJobs().catch((e) => console.error("[worker] recover", e));
  setInterval(() => recoverStaleJobs().catch(() => {}), 5 * 60_000).unref?.();
}
