export interface VideoMeta {
  platform: "douyin" | "wechat";
  video_id: string;
  url: string;
  title: string;
  author_name: string;
  author_id: string;
  like_count: number;
  comment_count: number;
  share_count: number;
  publish_time: Date | null;
  cover_image: string;
  keyword_source: string;
  author_follower_count: number;
  author_total_likes: number;
  author_post_count: number;
}

export interface ScoredVideo extends VideoMeta {
  trend_score: number;
  opportunity_score: number;
}

// Like floor: a video is dropped before upsert when its like_count falls below
// this. Only likes matter — comments and shares are ignored for filtering.
// Override per run with MIN_ENGAGEMENT=<n> (0 disables the filter).
export const MIN_ENGAGEMENT = parseInt(process.env.MIN_ENGAGEMENT ?? "1000", 10);

/**
 * Drop low-like junk before it reaches hot_posts. Keeps a video only when its
 * like_count >= min; comments and shares don't count. Returns the kept subset —
 * diff against the input length to report how many were filtered.
 */
export function filterLowEngagement<T extends VideoMeta>(videos: T[], min = MIN_ENGAGEMENT): T[] {
  if (min <= 0) return videos;
  return videos.filter((v) => v.like_count >= min);
}

const RECENCY_DECAY_HOURS = 72; // hours before recency bonus drops to zero

function recencyBoost(publishTime: Date | null): number {
  if (!publishTime) return 0;
  const hoursOld = (Date.now() - publishTime.getTime()) / 3_600_000;
  return Math.max(0, 1 - hoursOld / RECENCY_DECAY_HOURS) * 10_000;
}

function creatorSizePenalty(followerCount: number): number {
  // Penalise big accounts — we want breakout small creators
  if (followerCount > 1_000_000) return 5_000;
  if (followerCount > 100_000) return 1_000;
  return 0;
}

export function score(video: VideoMeta): ScoredVideo {
  const trend_score =
    video.like_count * 1.0 +
    video.comment_count * 3.0 +
    video.share_count * 4.0 +
    recencyBoost(video.publish_time) -
    creatorSizePenalty(video.author_follower_count);

  const opportunity_score =
    video.like_count / Math.max(video.author_follower_count, 1);

  return { ...video, trend_score, opportunity_score };
}

export function printResults(videos: ScoredVideo[], keyword: string) {
  const sorted = [...videos].sort((a, b) => b.trend_score - a.trend_score);

  console.log(`\n${"=".repeat(80)}`);
  console.log(`Keyword: "${keyword}"  |  Found: ${sorted.length} videos`);
  console.log("=".repeat(80));

  for (const [i, v] of sorted.entries()) {
    const age = v.publish_time
      ? `${Math.round((Date.now() - v.publish_time.getTime()) / 3_600_000)}h ago`
      : "unknown";

    console.log(`\n#${i + 1}  ${v.title || "(no title)"}`);
    console.log(`    Author : @${v.author_name}  (${fmtNum(v.author_follower_count)} followers)`);
    console.log(`    Engage : ❤ ${fmtNum(v.like_count)}  💬 ${fmtNum(v.comment_count)}  🔁 ${fmtNum(v.share_count)}`);
    console.log(`    Posted : ${age}`);
    console.log(`    Scores : trend=${Math.round(v.trend_score).toLocaleString()}  opportunity=${v.opportunity_score.toFixed(2)}`);
    console.log(`    URL    : ${v.url}`);
  }

  console.log(`\n${"=".repeat(80)}\n`);
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
