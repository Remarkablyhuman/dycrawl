-- Migration 001: add platform column to hot_posts
-- Allows distinguishing Douyin vs WeChat Channels videos in the same table.

alter table hot_posts
  add column if not exists platform text not null default 'douyin'
    check (platform in ('douyin', 'wechat'));

create index if not exists hot_posts_platform_idx on hot_posts (platform);
