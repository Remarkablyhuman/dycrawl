"use client";

import { useRouter } from "next/navigation";
import type { AdminStatus, HotPost } from "@/lib/supabase";
import { VideoCard } from "./VideoCard";

interface Props {
  posts: HotPost[];
  statusFilters: { label: string; value: AdminStatus | "all" }[];
  currentStatus: string;
  currentSort: string;
  currentKeyword: string;
  keywords: string[];
  error?: string;
}

export function AdminBoard({
  posts, statusFilters, currentStatus, currentSort, currentKeyword, keywords, error
}: Props) {
  const router = useRouter();

  function nav(updates: Record<string, string>) {
    const params = new URLSearchParams({
      status: currentStatus,
      sort:   currentSort,
      keyword: currentKeyword,
      ...updates,
    });
    // remove empty
    if (!params.get("keyword")) params.delete("keyword");
    router.push(`/admin?${params.toString()}`);
  }

  async function setStatus(id: string, status: AdminStatus) {
    await fetch(`/api/posts/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    router.refresh();
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ fontFamily: "var(--font-syne), sans-serif" }}>

      {/* ── Header ── */}
      <header className="sticky top-0 z-40 border-b border-zinc-800 bg-[#0c0c0c]/90 backdrop-blur-sm">
        <div className="mx-auto max-w-screen-2xl px-6 py-4 flex items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <span className="text-amber-400 font-mono text-xs tracking-widest uppercase opacity-60">UMI Douyin</span>
            <h1 className="text-base font-700 tracking-tight">Crawler</h1>
            <span className="ml-2 rounded bg-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-400">
              {posts.length} videos
            </span>
          </div>

          {/* Sort */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-widest text-zinc-500">Sort</span>
            {[
              { label: "Trend",       value: "trend"       },
              { label: "Opportunity", value: "opportunity" },
              { label: "Recency",     value: "recency"     },
            ].map((s) => (
              <button
                key={s.value}
                onClick={() => nav({ sort: s.value })}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  currentSort === s.value
                    ? "bg-amber-400 text-black"
                    : "text-zinc-400 hover:text-zinc-100"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Filter bar ── */}
        <div className="mx-auto max-w-screen-2xl px-6 pb-3 flex items-center gap-6 flex-wrap">
          {/* Status tabs */}
          <div className="flex items-center gap-1">
            {statusFilters.map((f) => (
              <button
                key={f.value}
                onClick={() => nav({ status: f.value })}
                className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                  currentStatus === f.value
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Keyword filter */}
          {keywords.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-widest text-zinc-600">Keyword</span>
              <button
                onClick={() => nav({ keyword: "" })}
                className={`rounded px-2.5 py-1 text-xs transition-colors ${
                  !currentKeyword ? "text-amber-400" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                All
              </button>
              {keywords.map((kw) => (
                <button
                  key={kw}
                  onClick={() => nav({ keyword: kw })}
                  className={`rounded px-2.5 py-1 text-xs transition-colors ${
                    currentKeyword === kw ? "text-amber-400" : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {kw}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      {/* ── Grid ── */}
      <main className="mx-auto max-w-screen-2xl w-full px-6 py-6 flex-1">
        {error && (
          <p className="mb-4 rounded border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-400">
            {error}
          </p>
        )}

        {posts.length === 0 ? (
          <div className="flex h-64 items-center justify-center text-zinc-600">
            No videos in this view.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {posts.map((post) => (
              <VideoCard key={post.id} post={post} onStatus={setStatus} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
