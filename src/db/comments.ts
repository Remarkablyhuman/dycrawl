import { supabase } from "./client.js";

export interface RankedComment {
  comment_id: string;
  text: string;
  like_count: number;
  author_name: string;
  author_id: string;
  rank: number;
}

// Map platform video_ids (aweme_id) -> hot_posts.id (uuid) for the rows the
// search phase just upserted. post_comments.hot_post_id references hot_posts(id).
export async function getHotPostIdMap(platform: string, videoIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (videoIds.length === 0) return map;
  const { data, error } = await supabase
    .from("hot_posts")
    .select("id, video_id")
    .eq("platform", platform)
    .in("video_id", videoIds);
  if (error) throw new Error(error.message);
  for (const r of data ?? []) map.set(r.video_id as string, r.id as string);
  return map;
}

// The freshly-captured videos for a keyword set, highest trend_score first.
// Used by the runner to pick which videos to fetch comments for.
export async function getCapturedVideoIds(
  platform: string,
  keywords: string[],
  sinceIso: string,
  limit: number,
): Promise<string[]> {
  if (keywords.length === 0) return [];
  const { data, error } = await supabase
    .from("hot_posts")
    .select("video_id")
    .eq("platform", platform)
    .in("keyword_source", keywords)
    .gte("crawled_at", sinceIso)
    .order("trend_score", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.video_id as string);
}

export async function upsertComments(hotPostId: string, comments: RankedComment[]): Promise<void> {
  if (comments.length === 0) return;
  const rows = comments.map((c) => ({
    hot_post_id: hotPostId,
    platform: "douyin",
    comment_id: c.comment_id,
    text: c.text,
    like_count: c.like_count,
    author_name: c.author_name,
    author_id: c.author_id,
    rank: c.rank,
  }));
  const { error } = await supabase
    .from("post_comments")
    .upsert(rows, { onConflict: "hot_post_id,comment_id", ignoreDuplicates: false });
  if (error) throw new Error(`post_comments upsert failed: ${error.message}`);
}
