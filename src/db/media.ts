import { supabase } from "./client.js";

// ── Transcription queue producers ──────────────────────────────────────────────
//
// worker.ts consumes post_media_jobs (status='pending', retry_count<3) →
// yt-dlp + ffmpeg + OpenAI → post_transcripts, then flips
// hot_posts.transcript_status to 'done'. These functions are the *producers*
// that decide which posts get a job.
//
// Douyin only: yt-dlp + the local cookies.json are douyin login state; 视频号
// videos aren't downloadable this way, so we never enqueue them.

/**
 * v2 (current) — Home-recommendation-aligned producer.
 *
 * /guest/home 今日推荐 only ever surfaces, per guest, the highest-trend
 * *already-transcribed* hot post in their primary_industry; guests with no
 * industry fall back to the global highest-trend transcribed post
 * (see LeadForge guest/home/page.tsx). So the only posts worth auto-transcribing:
 *   - the top-trend post of each industry at least one guest has chosen, plus
 *   - the global top-trend post (covers guests with no industry set).
 * That's a tiny, ~100%-hit set vs. the old top-N×keyword preheat — every job we
 * create is a post some home-recommendation slot will actually display.
 *
 * Idempotent: only enqueues posts with transcript_status='none' (pending/done/
 * failed are never re-queued), and de-dupes against existing post_media_jobs.
 */
export async function enqueueHomeRecommendedJobs(): Promise<number> {
  // 1. industries at least one guest has selected
  const { data: profs } = await supabase
    .from("profiles")
    .select("primary_industry")
    .eq("role", "guest")
    .not("primary_industry", "is", null);
  const industries = [
    ...new Set((profs ?? []).map((p) => p.primary_industry as string).filter(Boolean)),
  ];

  // 2. each chosen industry's top-trend post + the global top-trend post.
  //    Only the trend-leader matters (that's what home would show); enqueue it
  //    only if it's still untranscribed.
  const candidates = new Map<string, string>(); // hot_post_id → source url
  async function considerTop(industry: string | null): Promise<void> {
    let q = supabase
      .from("hot_posts")
      .select("id, url, transcript_status")
      .eq("platform", "douyin")
      .order("trend_score", { ascending: false })
      .limit(1);
    if (industry) q = q.eq("industry", industry);
    const { data } = await q;
    const row = (data ?? [])[0];
    if (row && row.url && row.transcript_status === "none") {
      candidates.set(row.id as string, row.url as string);
    }
  }
  for (const ind of industries) await considerTop(ind);
  await considerTop(null); // global fallback (guests with no industry set)

  if (candidates.size === 0) return 0;

  // 3. de-dupe vs existing jobs, insert pending, flip transcript_status
  const ids = [...candidates.keys()];
  const { data: existing } = await supabase
    .from("post_media_jobs")
    .select("hot_post_id")
    .in("hot_post_id", ids);
  const taken = new Set((existing ?? []).map((j) => j.hot_post_id as string));
  const fresh = ids.filter((id) => !taken.has(id));
  if (fresh.length === 0) return 0;

  const { error: insErr } = await supabase.from("post_media_jobs").insert(
    fresh.map((id) => ({
      hot_post_id: id,
      source_video_url: candidates.get(id)!,
      status: "pending",
    })),
  );
  if (insErr) throw new Error(`post_media_jobs insert failed: ${insErr.message}`);

  await supabase.from("hot_posts").update({ transcript_status: "pending" }).in("id", fresh);
  return fresh.length;
}

/**
 * @deprecated v1 preheat — top-N freshly-captured posts by trend_score per crawl.
 * Superseded by enqueueHomeRecommendedJobs() (home-aligned). Kept for the case
 * where an operator wants to force-transcribe a whole batch; the runner no longer
 * calls it. See plan/crawler/transcription-strategy.html v2.
 */
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
