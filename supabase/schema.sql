-- DYCrawler schema
-- Run this once against your Supabase project.

-- ── hot_posts ────────────────────────────────────────────────────────────────
-- Crawled video metadata + ranking scores.

create table if not exists hot_posts (
  id                    uuid primary key default gen_random_uuid(),

  -- identity
  platform              text not null default 'douyin'
                        check (platform in ('douyin', 'wechat')),
  video_id              text not null unique,
  url                   text not null,
  title                 text,
  cover_image           text,
  publish_time          timestamptz,
  keyword_source        text,

  -- author
  author_name           text,
  author_id             text,
  author_follower_count bigint default 0,
  author_total_likes    bigint default 0,
  author_post_count     int    default 0,

  -- engagement
  like_count            bigint default 0,
  comment_count         bigint default 0,
  share_count           bigint default 0,

  -- scores
  trend_score           float  default 0,
  opportunity_score     float  default 0,

  -- admin workflow
  admin_status          text not null default 'new'
                        check (admin_status in ('new','ignored','candidate','queued','done')),

  -- timestamps
  crawled_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

create index if not exists hot_posts_platform_idx       on hot_posts (platform);
create index if not exists hot_posts_keyword_source_idx on hot_posts (keyword_source);
create index if not exists hot_posts_admin_status_idx   on hot_posts (admin_status);
create index if not exists hot_posts_trend_score_idx    on hot_posts (trend_score desc);

-- ── post_media_jobs ──────────────────────────────────────────────────────────
-- File acquisition + transcription job state. Created when admin queues a video.

create table if not exists post_media_jobs (
  id                    uuid primary key default gen_random_uuid(),
  hot_post_id           uuid not null references hot_posts (id) on delete cascade,

  status                text not null default 'pending'
                        check (status in (
                          'pending','downloading','downloaded',
                          'extracting_audio','transcribing','done','failed'
                        )),

  source_video_url      text,
  downloaded_video_path text,
  audio_path            text,
  error_text            text,
  retry_count           int default 0,

  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

create index if not exists post_media_jobs_hot_post_id_idx on post_media_jobs (hot_post_id);
create index if not exists post_media_jobs_status_idx      on post_media_jobs (status);

-- ── post_transcripts ─────────────────────────────────────────────────────────
-- Transcript results from OpenAI.

create table if not exists post_transcripts (
  id                uuid primary key default gen_random_uuid(),
  hot_post_id       uuid not null references hot_posts (id) on delete cascade,

  model             text,
  transcript        text,
  language          text,
  duration_seconds  float,
  segments          jsonb,

  created_at        timestamptz default now()
);

create index if not exists post_transcripts_hot_post_id_idx on post_transcripts (hot_post_id);

-- ── updated_at trigger ───────────────────────────────────────────────────────

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create or replace trigger hot_posts_updated_at
  before update on hot_posts
  for each row execute function set_updated_at();

create or replace trigger post_media_jobs_updated_at
  before update on post_media_jobs
  for each row execute function set_updated_at();
