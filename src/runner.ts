/**
 * Crawl runner — local attended job processor.
 *
 * Polls Supabase `crawl_jobs` for queued work and executes it on this machine
 * with a HEADED browser (operator solves CAPTCHAs). For `hotpost_search` it runs
 * the existing crawl.ts / crawl_wechat.ts once per keyword (those scripts upsert
 * into hot_posts directly), then records how many rows landed.
 *
 * Usage:
 *   node --loader ts-node/esm src/runner.ts
 *   HEADED=1 RUNNER_POLL_MS=15000 node --loader ts-node/esm src/runner.ts
 *
 * Leave it running while you watch; it claims jobs as they appear and pops a
 * browser window per keyword so you can clear any login / CAPTCHA prompt.
 *
 * NOTE: account_snapshot + transcribe job types are not handled here yet (they
 * need the new account / 视频号助手 / comment capture flows). transcribe is
 * currently served by the standalone worker.ts.
 */

import { spawn } from "child_process";
import { claimNextJob, finishJob, failJob, recoverStuckRunning, type CrawlJob } from "./db/jobs.js";
import { getCapturedVideoIds } from "./db/comments.js";
import { enqueueHomeRecommendedJobs } from "./db/media.js";
import { supabase } from "./db/client.js";

const POLL_MS = parseInt(process.env.RUNNER_POLL_MS ?? "15000", 10);
const HEADED = process.env.HEADED ?? "1"; // attended by default

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runScript(script: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--loader", "ts-node/esm", script], {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
    child.on("error", reject);
  });
}

async function countCaptured(platform: string, keywords: string[], since: string): Promise<number> {
  if (keywords.length === 0) return 0;
  const { count } = await supabase
    .from("hot_posts")
    .select("id", { count: "exact", head: true })
    .eq("platform", platform)
    .in("keyword_source", keywords)
    .gte("crawled_at", since);
  return count ?? 0;
}

async function runHotpostSearch(
  job: CrawlJob,
): Promise<{ videos_captured: number; keywords: number; comments_for: number; transcribe_enqueued: number }> {
  const platform = job.platform ?? "douyin";
  const script = platform === "wechat" ? "src/crawl_wechat.ts" : "src/crawl.ts";
  const keywords = job.input?.keywords ?? [];
  const max = String(job.input?.max_videos_per_keyword ?? 30);
  // controlled industry KEY for this batch; passed to the child as env (string)
  const industry = typeof job.input?.industry === "string" ? job.input.industry : "";
  const since = new Date().toISOString();

  if (keywords.length === 0) throw new Error("no keywords in job input");

  for (const kw of keywords) {
    console.log(`\n[job ${job.id}] crawling "${kw}" (${platform}, max ${max})…`);
    await runScript(script, { KEYWORD: kw, MAX_VIDEOS: max, HEADED, INDUSTRY: industry });
    // polite pause between keywords (5–10s) to stay under the radar
    await sleep(5_000 + Math.floor((Date.now() % 5_000)));
  }

  const videos_captured = await countCaptured(platform, keywords, since);

  // Top-comment phase (douyin only this phase): grab comments for the highest
  // trend_score videos we just captured.
  let comments_for = 0;
  if (platform === "douyin" && job.input?.fetch_top_comments) {
    const maxC = Number(job.input?.max_videos_with_comments ?? 20);
    const ids = await getCapturedVideoIds("douyin", keywords, since, maxC);
    if (ids.length > 0) {
      console.log(`\n[job ${job.id}] fetching top comments for ${ids.length} videos…`);
      await runScript("src/comments.ts", {
        AWEME_IDS: ids.join(","),
        TOP_N: String(job.input?.top_comments_count ?? 10),
        HEADED,
      });
      comments_for = ids.length;
    }
  }

  // Transcription phase (douyin only): v2 auto-enqueue only the posts the guest
  // home 今日推荐 will actually surface — each chosen industry's top-trend post +
  // the global top — aligning transcription spend with what's shown. Replaces the
  // old top-N-by-trend preheat. (See plan/crawler/transcription-strategy.html v2.)
  let transcribe_enqueued = 0;
  if (platform === "douyin") {
    transcribe_enqueued = await enqueueHomeRecommendedJobs();
    if (transcribe_enqueued > 0) {
      console.log(`\n[job ${job.id}] enqueued ${transcribe_enqueued} home-recommended transcription job(s)`);
    }
  }

  return { videos_captured, keywords: keywords.length, comments_for, transcribe_enqueued };
}

async function loop(): Promise<void> {
  console.log(`crawl runner started — poll ${POLL_MS}ms, headed=${HEADED}`);
  for (;;) {
    try {
      await recoverStuckRunning();
      const job = await claimNextJob();
      if (!job) {
        await sleep(POLL_MS);
        continue;
      }

      console.log(`\n=== claimed job ${job.id} (${job.job_type}) ===`);
      try {
        let result: unknown = {};
        if (job.job_type === "hotpost_search") {
          result = await runHotpostSearch(job);
        } else {
          throw new Error(`job_type "${job.job_type}" not yet supported by runner`);
        }
        // Work is done and already persisted (crawl.ts upserts hot_posts directly).
        // Marking the job 'succeeded' is best-effort bookkeeping: if it still fails
        // after retries, log loudly but DON'T fall through to failJob — re-queuing
        // would re-crawl data we already have.
        try {
          await finishJob(job.id, result);
          console.log(`=== job ${job.id} succeeded ===`, result);
        } catch (be) {
          const bmsg = be instanceof Error ? be.message : String(be);
          console.error(`⚠️  job ${job.id} WORK SUCCEEDED but marking 'succeeded' failed: ${bmsg}`);
          console.error(`    Data is saved. Reconcile crawl_jobs.status manually if it stays 'running'.`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`job ${job.id} failed: ${msg}`);
        await failJob(job.id, msg, job.retry_count, job.max_retries);
      }
    } catch (e) {
      console.error("runner loop error:", e);
      await sleep(POLL_MS);
    }
  }
}

loop();
