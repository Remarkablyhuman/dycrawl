import { supabase } from "./client.js";
import type { ScoredVideo } from "../scorer.js";

// `industry` is a controlled KEY from the crawl job (crawl_jobs.input.industry),
// stamped on every row this job captures. '' / undefined → null (未分类),
// which the app then backfills via /api/admin/classify-hot-posts.
export async function upsertVideos(videos: ScoredVideo[], industry: string | null = null): Promise<void> {
  if (videos.length === 0) return;

  const rows = videos.map((v) => ({
    platform:              v.platform,
    video_id:              v.video_id,
    url:                   v.url,
    title:                 v.title,
    cover_image:           v.cover_image,
    publish_time:          v.publish_time?.toISOString() ?? null,
    keyword_source:        v.keyword_source,
    industry:              industry || null,
    author_name:           v.author_name,
    author_id:             v.author_id,
    author_follower_count: v.author_follower_count,
    author_total_likes:    v.author_total_likes,
    author_post_count:     v.author_post_count,
    like_count:            v.like_count,
    comment_count:         v.comment_count,
    share_count:           v.share_count,
    trend_score:           v.trend_score,
    opportunity_score:     v.opportunity_score,
  }));

  const { error } = await supabase
    .from("hot_posts")
    .upsert(rows, { onConflict: "platform,video_id", ignoreDuplicates: false });

  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
}
