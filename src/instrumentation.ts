export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.WORKER_ENABLED !== "false") {
    const { startWorker } = await import("@/lib/jobs/worker");
    startWorker();
  }
}
