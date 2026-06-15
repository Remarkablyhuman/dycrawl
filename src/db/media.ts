import { supabase } from "./client.js";

// Transcription queue producer.
//
// After a hotpost_search, pick the top-N freshly-captured douyin posts by
// trend_score and enqueue a transcription job for each. worker.ts consumes
// post_media_jobs (pending) → yt-dlp + ffmpeg + OpenAI → post_transcripts, then
// flips hot_posts.transcript_status to 'done'.
//
// Douyin only: yt-dlp + the local cookies.json are douyin login state; 视频号
// videos aren't downloadable this way, so we don't enqueue them.
//
// Idempotent: only selects posts with transcript_status='none' (so 'pending' /
// 'done' / 'failed' are never re-queued — failures don't get hammered), and
// de-dupes against any existing post_media_jobs rows (no unique on hot_post_id).
export async function enqueueTranscribeJobs(
  keywords: string[],
  sinceIso: string,
  limit: number,
): Promise<number> {
  if (keywords.length === 0) return 0;

  const { data: posts, error } = await supabase
    .from("hot_posts")
    .select("id, url")
    .eq("platform", "douyin")
    .in("keyword_source", keywords)
    .gte("crawled_at", sinceIso)
    .eq("transcript_status", "none")
    .order("trend_score", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const rows = (posts ?? []).filter((r) => r.url);
  if (rows.length === 0) return 0;

  const ids = rows.map((r) => r.id as string);
  const { data: existing } = await supabase
    .from("post_media_jobs")
    .select("hot_post_id")
    .in("hot_post_id", ids);
  const taken = new Set((existing ?? []).map((j) => j.hot_post_id as string));

  const fresh = rows.filter((r) => !taken.has(r.id as string));
  if (fresh.length === 0) return 0;

  const { error: insErr } = await supabase.from("post_media_jobs").insert(
    fresh.map((r) => ({
      hot_post_id: r.id,
      source_video_url: r.url,
      status: "pending",
    })),
  );
  if (insErr) throw new Error(`post_media_jobs insert failed: ${insErr.message}`);

  await supabase
    .from("hot_posts")
    .update({ transcript_status: "pending" })
    .in("id", fresh.map((r) => r.id as string));

  return fresh.length;
}
