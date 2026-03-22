import { createClient } from "@supabase/supabase-js";

const url  = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Browser / RSC reads (anon key, respects RLS)
export const supabase = createClient(url, anon);

// Server-side writes (service role, bypasses RLS)
export const supabaseAdmin = createClient(url, service);

export type AdminStatus = "new" | "ignored" | "candidate" | "queued" | "done";

export interface HotPost {
  id: string;
  video_id: string;
  url: string;
  title: string | null;
  cover_image: string | null;
  publish_time: string | null;
  keyword_source: string | null;
  author_name: string | null;
  author_follower_count: number;
  like_count: number;
  comment_count: number;
  share_count: number;
  trend_score: number;
  opportunity_score: number;
  admin_status: AdminStatus;
  crawled_at: string;
}
