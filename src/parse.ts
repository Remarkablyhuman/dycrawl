/**
 * parse.ts — pure parsers for the captured API responses.
 *
 * Each function takes a raw JSON object (as returned by the platform's internal
 * API, captured via capture.ts) and returns clean rows ready to upsert. No I/O,
 * no browser — easy to unit-test against the sample files under ./capture/.
 *
 * Field mappings were derived from real captured responses:
 *   douyin comment/list           -> parseDouyinComments
 *   douyin user/profile/other     -> parseDouyinAccount
 *   douyin aweme/post             -> parseDouyinPosts
 *   wechat auth/auth_data         -> parseWechatAccount
 *   wechat post/post_list         -> parseWechatPosts   (has reads + completion!)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Douyin: top comments (aweme/v1/web/comment/list/) ────────────────────────

export interface ParsedComment {
  comment_id: string;
  text: string;
  like_count: number;
  author_name: string;
  author_id: string;
}

export function parseDouyinComments(json: any): ParsedComment[] {
  const comments: any[] = json?.comments ?? [];
  return comments
    .map((c) => ({
      comment_id: String(c?.cid ?? ""),
      text: String(c?.text ?? ""),
      like_count: Number(c?.digg_count ?? 0),
      author_name: String(c?.user?.nickname ?? ""),
      author_id: String(c?.user?.uid ?? c?.user?.sec_uid ?? ""),
    }))
    .filter((c) => c.comment_id && c.text);
}

/** Sort by likes desc and tag rank 1..n. Pass the merged comments of all pages. */
export function topComments(all: ParsedComment[], n = 10): Array<ParsedComment & { rank: number }> {
  const dedup = new Map<string, ParsedComment>();
  for (const c of all) if (!dedup.has(c.comment_id)) dedup.set(c.comment_id, c);
  return [...dedup.values()]
    .sort((a, b) => b.like_count - a.like_count)
    .slice(0, n)
    .map((c, i) => ({ ...c, rank: i + 1 }));
}

// ── Douyin: account profile (aweme/v1/web/user/profile/other/) ───────────────

export interface ParsedAccount {
  nickname: string;
  author_id: string;   // numeric uid
  sec_uid: string;
  unique_id: string;   // @handle
  follower_count: number;
  total_likes: number; // total_favorited
  post_count: number;  // aweme_count
  signature: string;
}

export function parseDouyinAccount(json: any): ParsedAccount | null {
  const u = json?.user;
  if (!u) return null;
  return {
    nickname: String(u.nickname ?? ""),
    author_id: String(u.uid ?? ""),
    sec_uid: String(u.sec_uid ?? ""),
    unique_id: String(u.unique_id ?? ""),
    follower_count: Number(u.follower_count ?? 0),
    total_likes: Number(u.total_favorited ?? 0),
    post_count: Number(u.aweme_count ?? 0),
    signature: String(u.signature ?? ""),
  };
}

// ── Douyin: account videos (aweme/v1/web/aweme/post/) ────────────────────────

export interface ParsedVideo {
  video_id: string;
  title: string;
  url: string;
  cover_image: string;
  publish_time: Date | null;
  like_count: number;
  comment_count: number;
  share_count: number;
  play_count: number | null; // douyin web does not expose plays (0/absent)
}

export function parseDouyinPosts(json: any): ParsedVideo[] {
  const list: any[] = json?.aweme_list ?? [];
  return list
    .map((a) => {
      const s = a?.statistics ?? {};
      const id = String(a?.aweme_id ?? "");
      const play = Number(s.play_count ?? 0);
      return {
        video_id: id,
        title: String(a?.desc ?? ""),
        url: String(a?.share_url ?? (id ? `https://www.douyin.com/video/${id}` : "")),
        cover_image: String(a?.video?.cover?.url_list?.[0] ?? ""),
        publish_time: a?.create_time ? new Date(a.create_time * 1000) : null,
        like_count: Number(s.digg_count ?? 0),
        comment_count: Number(s.comment_count ?? 0),
        share_count: Number(s.share_count ?? 0),
        play_count: play > 0 ? play : null,
      };
    })
    .filter((v) => v.video_id);
}

// ── WeChat 视频号助手: account (auth/auth_data) ───────────────────────────────

export interface ParsedWxAccount {
  nickname: string;
  uniq_id: string;     // 视频号 id, e.g. sph021...
  fans_count: number;
  feeds_count: number; // post count
  signature: string;
}

export function parseWechatAccount(json: any): ParsedWxAccount | null {
  const f = json?.data?.finderUser;
  if (!f) return null;
  return {
    nickname: String(f.nickname ?? ""),
    uniq_id: String(f.uniqId ?? ""),
    fans_count: Number(f.fansCount ?? 0),
    feeds_count: Number(f.feedsCount ?? 0),
    signature: String(json?.data?.signature ?? ""),
  };
}

// ── WeChat 视频号助手: posts (post/post_list) — reads + completion ────────────

export interface ParsedWxVideo {
  video_id: string;
  title: string;
  cover_image: string;
  publish_time: Date | null;
  read_count: number;       // 播放量
  like_count: number;
  comment_count: number;
  share_count: number;      // forwardCount
  fav_count: number;        // 收藏
  full_play_rate: number | null;  // 完播率 (0..1)
  avg_play_time_sec: number | null;
}

export function parseWechatPosts(json: any): ParsedWxVideo[] {
  const list: any[] = json?.data?.list ?? [];
  return list
    .map((p) => ({
      video_id: String(p?.objectId ?? p?.exportId ?? ""),
      title: wxCaption(p?.desc),
      cover_image: String(p?.desc?.media?.[0]?.thumbUrl ?? ""),
      publish_time: p?.createTime ? new Date(p.createTime * 1000) : null,
      read_count: Number(p?.readCount ?? 0),
      like_count: Number(p?.likeCount ?? 0),
      comment_count: Number(p?.commentCount ?? 0),
      share_count: Number(p?.forwardCount ?? 0),
      fav_count: Number(p?.favCount ?? 0),
      full_play_rate: p?.fullPlayRate != null ? Number(p.fullPlayRate) : null,
      avg_play_time_sec: p?.avgPlayTimeSec != null ? Number(p.avgPlayTimeSec) : null,
    }))
    .filter((v) => v.video_id);
}

// WeChat post `desc` is an object holding media; the caption text lives under a
// few possible keys depending on post type. Fall back across them.
function wxCaption(desc: any): string {
  if (!desc) return "";
  if (typeof desc === "string") return desc;
  return String(desc.description ?? desc.shortTitle ?? desc.title ?? desc.feedDesc ?? "");
}
