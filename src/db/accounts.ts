import { supabase } from "./client.js";

// Shared DB layer for guest account snapshots (guest_accounts / account_snapshots
// / account_videos / guest_account_sessions). Service-role client (bypasses RLS).

const today = () => new Date().toISOString().slice(0, 10);

export interface AccountVideoRow {
  video_id: string;
  title: string;
  url: string;
  cover_image: string;
  publish_time: Date | null;
  like_count: number;
  comment_count: number;
  share_count: number;
  play_count: number | null;
  completion_rate: number | null;
  avg_play_time_sec: number | null;
}

export async function getGuestIdByEmail(email: string): Promise<string | null> {
  const { data } = await supabase.from("profiles").select("id, role").eq("email", email).maybeSingle();
  if (!data) return null;
  if (data.role !== "guest") console.warn(`  (warning: ${email} role is ${data.role}, not guest)`);
  return data.id as string;
}

export async function findWechatAccount(guestId: string): Promise<string | null> {
  const { data } = await supabase
    .from("guest_accounts")
    .select("id")
    .eq("platform", "wechat")
    .eq("guest_id", guestId)
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

// Create or update the wechat guest_account from 助手 auth_data; return its id.
export async function upsertWechatAccount(
  guestId: string,
  uniqId: string,
  nickname: string,
  profileUrl: string,
): Promise<string> {
  const byId = await supabase.from("guest_accounts").select("id").eq("platform", "wechat").eq("author_id", uniqId).maybeSingle();
  if (byId.data) {
    await supabase.from("guest_accounts").update({ guest_id: guestId, nickname, profile_url: profileUrl, auth_status: "active" }).eq("id", byId.data.id);
    return byId.data.id as string;
  }
  // account row created earlier for this guest without an author_id yet
  const byGuest = await supabase.from("guest_accounts").select("id").eq("platform", "wechat").eq("guest_id", guestId).is("author_id", null).limit(1).maybeSingle();
  if (byGuest.data) {
    await supabase.from("guest_accounts").update({ author_id: uniqId, nickname, profile_url: profileUrl, auth_status: "active" }).eq("id", byGuest.data.id);
    return byGuest.data.id as string;
  }
  const { data, error } = await supabase
    .from("guest_accounts")
    .insert({ guest_id: guestId, platform: "wechat", author_id: uniqId, nickname, profile_url: profileUrl, auth_status: "active" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

export async function writeAccountSnapshot(
  accountId: string,
  s: { follower_count: number | null; total_likes: number | null; post_count: number | null },
): Promise<void> {
  const { error } = await supabase
    .from("account_snapshots")
    .upsert(
      { guest_account_id: accountId, follower_count: s.follower_count, total_likes: s.total_likes, post_count: s.post_count, captured_on: today() },
      { onConflict: "guest_account_id,captured_on" },
    );
  if (error) throw new Error(error.message);
}

export async function writeAccountVideos(accountId: string, vids: AccountVideoRow[]): Promise<void> {
  if (vids.length === 0) return;
  const co = today();
  const rows = vids.map((v) => ({
    guest_account_id: accountId,
    video_id: v.video_id,
    title: v.title,
    url: v.url,
    cover_image: v.cover_image,
    publish_time: v.publish_time ? v.publish_time.toISOString() : null,
    like_count: v.like_count,
    comment_count: v.comment_count,
    share_count: v.share_count,
    play_count: v.play_count,
    completion_rate: v.completion_rate,
    avg_play_time_sec: v.avg_play_time_sec,
    captured_on: co,
  }));
  const { error } = await supabase.from("account_videos").upsert(rows, { onConflict: "guest_account_id,video_id,captured_on" });
  if (error) throw new Error(error.message);
}

// ── per-guest wechat 助手 session (storageState) — service-role only table ────

export async function loadSession(accountId: string): Promise<unknown | null> {
  const { data } = await supabase.from("guest_account_sessions").select("storage_state, status").eq("guest_account_id", accountId).maybeSingle();
  if (!data || data.status !== "active") return null;
  return data.storage_state ?? null;
}

export async function saveSession(accountId: string, storageState: unknown): Promise<void> {
  await supabase
    .from("guest_account_sessions")
    .upsert({ guest_account_id: accountId, storage_state: storageState, status: "active" }, { onConflict: "guest_account_id" });
}
