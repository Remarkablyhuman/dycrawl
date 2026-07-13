import { supabase } from "./client.js";

// crawl_jobs orchestration helpers for the local attended runner.
// crawl_jobs is RLS service-role-only; this module runs with the service-role
// client (same as upsert), so it can read/write freely.

export interface CrawlJob {
  id: string;
  job_type: "hotpost_search" | "account_snapshot" | "transcribe";
  status: string;
  platform: "douyin" | "wechat" | null;
  input: {
    keywords?: string[];
    max_videos_per_keyword?: number;
    fetch_top_comments?: boolean;
    top_comments_count?: number;
    industry?: string; // controlled industry KEY → stamped on hot_posts.industry
    [k: string]: unknown;
  } | null;
  retry_count: number;
  max_retries: number;
}

export const RUNNER_ID = `${process.env.RUNNER_ID ?? "local"}-${process.pid}`;

// Claim the oldest queued job and flip it to running. Single-runner setup, but
// the update is guarded on status='queued' so two runners can't double-claim.
export async function claimNextJob(): Promise<CrawlJob | null> {
  const { data, error } = await supabase
    .from("crawl_jobs")
    .select("id, job_type, status, platform, input, retry_count, max_retries")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(error.message);

  const job = (data ?? [])[0] as CrawlJob | undefined;
  if (!job) return null;

  const { data: upd, error: uerr } = await supabase
    .from("crawl_jobs")
    .update({ status: "running", started_at: new Date().toISOString(), runner_id: RUNNER_ID })
    .eq("id", job.id)
    .eq("status", "queued")
    .select("id");
  if (uerr) throw new Error(uerr.message);
  if (!upd || upd.length === 0) return null; // another runner claimed it first

  return { ...job, status: "running" };
}

// Status writes here occasionally eat a transient 5xx from the Supabase gateway.
// The old finishJob/failJob ignored the update error entirely, so a single lost
// write left a job stuck in 'running' while the runner happily logged success.
// Retry transient failures with backoff and throw if they persist, so the caller
// can react instead of silently desyncing crawl_jobs from reality.
async function updateJob(
  id: string,
  patch: Record<string, unknown>,
  attempts = 4,
): Promise<void> {
  let lastErr = "";
  for (let i = 0; i < attempts; i++) {
    const { error } = await supabase.from("crawl_jobs").update(patch).eq("id", id);
    if (!error) return;
    lastErr = error.message;
    if (i < attempts - 1) {
      // backoff: 0.5s, 1s, 2s
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw new Error(`crawl_jobs update failed for ${id} after ${attempts} attempts: ${lastErr}`);
}

export async function finishJob(id: string, result: unknown): Promise<void> {
  await updateJob(id, { status: "succeeded", finished_at: new Date().toISOString(), result });
}

export async function failJob(
  id: string,
  errorText: string,
  retryCount: number,
  maxRetries: number,
): Promise<void> {
  if (retryCount < maxRetries) {
    // re-queue for another attempt
    await updateJob(id, { status: "queued", retry_count: retryCount + 1, error_text: errorText });
  } else {
    await updateJob(id, { status: "failed", finished_at: new Date().toISOString(), retry_count: retryCount + 1, error_text: errorText });
  }
}

// Re-queue jobs left stuck in 'running' by a crashed runner (no apify_run_id /
// webhook here, so we self-heal by timeout).
export async function recoverStuckRunning(maxMinutes = 30): Promise<void> {
  const cutoff = new Date(Date.now() - maxMinutes * 60_000).toISOString();
  const { error } = await supabase
    .from("crawl_jobs")
    .update({ status: "queued", error_text: "recovered from stuck running" })
    .eq("status", "running")
    .lt("started_at", cutoff);
  if (error) throw new Error(error.message);
}
