"use client";

import Image from "next/image";
import { useState } from "react";
import type { AdminStatus, HotPost } from "@/lib/supabase";

const STATUS_COLORS: Record<AdminStatus, string> = {
  new:       "bg-zinc-700 text-zinc-300",
  ignored:   "bg-zinc-900 text-zinc-600",
  candidate: "bg-blue-900/60 text-blue-300",
  queued:    "bg-amber-900/60 text-amber-300",
  done:      "bg-green-900/60 text-green-300",
};

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (h < 24)  return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

interface Props {
  post: HotPost;
  onStatus: (id: string, status: AdminStatus) => Promise<void>;
}

export function VideoCard({ post, onStatus }: Props) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AdminStatus>(post.admin_status);

  async function act(s: AdminStatus) {
    setBusy(true);
    setStatus(s);
    await onStatus(post.id, s);
    setBusy(false);
  }

  const isIgnored = status === "ignored";

  return (
    <article
      className={`group relative flex flex-col rounded-xl overflow-hidden border transition-all duration-200 ${
        isIgnored
          ? "border-zinc-800/50 opacity-40 hover:opacity-70"
          : "border-zinc-800 hover:border-zinc-600"
      }`}
      style={{ background: "#141414" }}
    >
      {/* Cover image */}
      <div className="relative aspect-[9/16] w-full bg-zinc-900 overflow-hidden">
        {post.cover_image ? (
          <Image
            src={post.cover_image}
            alt={post.title ?? ""}
            fill
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
            className="object-cover transition-transform duration-500 group-hover:scale-105"
            unoptimized
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-zinc-700">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
          </div>
        )}

        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />

        {/* Status badge */}
        <div className="absolute top-2 left-2">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${STATUS_COLORS[status]}`}>
            {status}
          </span>
        </div>

        {/* Keyword badge */}
        {post.keyword_source && (
          <div className="absolute top-2 right-2">
            <span className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-zinc-400 font-mono">
              {post.keyword_source}
            </span>
          </div>
        )}

        {/* Scores overlay at bottom of image */}
        <div className="absolute bottom-2 left-2 right-2 flex justify-between items-end">
          <div className="flex flex-col gap-0.5">
            {post.opportunity_score >= 1 && (
              <span className="self-start rounded bg-rose-500/90 px-1.5 py-0.5 text-[10px] font-semibold text-white leading-tight">
                低粉丝 高赞数
              </span>
            )}
            <div className="font-mono text-[11px] text-amber-400 font-medium">
              热度 {fmt(post.trend_score)}
            </div>
            <div className="font-mono text-[10px] text-zinc-300">
              机会值 {post.opportunity_score.toFixed(1)}×
            </div>
          </div>
          <div className="text-[10px] text-zinc-500 font-mono">
            {timeAgo(post.publish_time)}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-col flex-1 p-3 gap-2">
        {/* Title */}
        <p className="text-[12px] leading-4 text-zinc-200 line-clamp-2 min-h-[2rem]">
          {post.title || <span className="text-zinc-600 italic">No caption</span>}
        </p>

        {/* Author */}
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-zinc-400 truncate max-w-[70%]">
            @{post.author_name ?? "—"}
          </span>
          <span className="font-mono text-[10px] text-zinc-600">
            {fmt(post.author_follower_count)} followers
          </span>
        </div>

        {/* Engagement */}
        <div className="flex gap-3 font-mono text-[10px] text-zinc-500">
          <span>❤ {fmt(post.like_count)}</span>
          <span>💬 {fmt(post.comment_count)}</span>
          <span>🔁 {fmt(post.share_count)}</span>
        </div>

        {/* Actions */}
        <div className="mt-auto pt-2 flex flex-col gap-1.5">
          <div className="flex gap-1.5">
            <a
              href={post.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 rounded py-1.5 text-center text-[11px] font-medium text-zinc-400 border border-zinc-700 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
            >
              View
            </a>
            {status !== "candidate" ? (
              <button
                disabled={busy}
                onClick={() => act("candidate")}
                className="flex-1 rounded py-1.5 text-[11px] font-medium text-blue-300 border border-blue-900 hover:border-blue-600 hover:text-blue-200 transition-colors disabled:opacity-40"
              >
                Save
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={() => act("new")}
                className="flex-1 rounded py-1.5 text-[11px] font-medium text-zinc-500 border border-zinc-800 hover:text-zinc-300 transition-colors disabled:opacity-40"
              >
                Unsave
              </button>
            )}
          </div>

          <div className="flex gap-1.5">
            {status !== "queued" ? (
              <button
                disabled={busy}
                onClick={() => act("queued")}
                className="flex-1 rounded py-1.5 text-[11px] font-medium bg-amber-400/10 text-amber-400 border border-amber-900 hover:bg-amber-400/20 hover:border-amber-700 transition-colors disabled:opacity-40"
              >
                Queue
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={() => act("new")}
                className="flex-1 rounded py-1.5 text-[11px] font-medium text-zinc-500 border border-zinc-800 hover:text-zinc-300 transition-colors disabled:opacity-40"
              >
                Unqueue
              </button>
            )}
            {status !== "ignored" ? (
              <button
                disabled={busy}
                onClick={() => act("ignored")}
                className="flex-1 rounded py-1.5 text-[11px] font-medium text-zinc-600 border border-zinc-800 hover:text-red-400 hover:border-red-900 transition-colors disabled:opacity-40"
              >
                Ignore
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={() => act("new")}
                className="flex-1 rounded py-1.5 text-[11px] font-medium text-zinc-500 border border-zinc-800 hover:text-zinc-300 transition-colors disabled:opacity-40"
              >
                Restore
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
