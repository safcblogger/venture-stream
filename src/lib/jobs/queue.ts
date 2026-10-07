import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";

export type JobType = "discovery" | "research" | "contacts";

export async function enqueueJob(job: { type: JobType; workspaceId: string; payload: Record<string, unknown>; runAt?: Date }) {
  const [row] = await db
    .insert(schema.jobs)
    .values({ type: job.type, workspaceId: job.workspaceId, payload: job.payload, runAt: job.runAt ?? new Date() })
    .returning();
  return row;
}

/** Atomically claim the next due job. SKIP LOCKED lets several workers run safely against one table. */
export async function claimJob() {
  const rows = await db.execute<{ id: string }>(sql`
    update jobs set status = 'running', locked_at = now(), attempts = attempts + 1
    where id = (
      select id from jobs
      where status = 'queued' and run_at <= now()
      order by run_at
      for update skip locked
      limit 1
    )
    returning id`);
  const id = rows[0]?.id;
  if (!id) return null;
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
  return job ?? null;
}

export async function completeJob(id: string) {
  await db.update(schema.jobs).set({ status: "done", finishedAt: new Date(), lockedAt: null }).where(eq(schema.jobs.id, id));
}

/** Retry with backoff until maxAttempts, then mark failed. Returns true if the job will be retried. */
export async function failJob(id: string, attempts: number, maxAttempts: number, message: string, retryable: boolean) {
  const retry = retryable && attempts < maxAttempts;
  await db
    .update(schema.jobs)
    .set(
      retry
        ? { status: "queued", lockedAt: null, lastError: message, runAt: new Date(Date.now() + 30_000 * attempts) }
        : { status: "failed", lockedAt: null, lastError: message, finishedAt: new Date() },
    )
    .where(eq(schema.jobs.id, id));
  return retry;
}

/** Jobs whose worker died mid-run are returned to the queue. */
export async function recoverStaleJobs(olderThanMs = 10 * 60_000) {
  await db
    .update(schema.jobs)
    .set({ status: "queued", lockedAt: null })
    .where(and(eq(schema.jobs.status, "running"), sql`${schema.jobs.lockedAt} < now() - (${olderThanMs} * interval '1 millisecond')`));
}
