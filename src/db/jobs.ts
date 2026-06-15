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

export async function finishJob(id: string, result: unknown): Promise<void> {
  await supabase
    .from("crawl_jobs")
    .update({ status: "succeeded", finished_at: new Date().toISOString(), result })
    .eq("id", id);
}

export async function failJob(
  id: string,
  errorText: string,
  retryCount: number,
  maxRetries: number,
): Promise<void> {
  if (retryCount < maxRetries) {
    // re-queue for another attempt
    await supabase
      .from("crawl_jobs")
      .update({ status: "queued", retry_count: retryCount + 1, error_text: errorText })
      .eq("id", id);
  } else {
    await supabase
      .from("crawl_jobs")
      .update({ status: "failed", finished_at: new Date().toISOString(), retry_count: retryCount + 1, error_text: errorText })
      .eq("id", id);
  }
}

// Re-queue jobs left stuck in 'running' by a crashed runner (no apify_run_id /
// webhook here, so we self-heal by timeout).
export async function recoverStuckRunning(maxMinutes = 30): Promise<void> {
  const cutoff = new Date(Date.now() - maxMinutes * 60_000).toISOString();
  await supabase
    .from("crawl_jobs")
    .update({ status: "queued", error_text: "recovered from stuck running" })
    .eq("status", "running")
    .lt("started_at", cutoff);
}
