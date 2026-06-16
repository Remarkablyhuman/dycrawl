/**
 * DYCrawler worker
 *
 * Polls post_media_jobs for pending jobs and processes them:
 *   download (yt-dlp) → extract audio (ffmpeg) → transcribe (OpenAI) → save
 *
 * Prerequisites:
 *   brew install yt-dlp ffmpeg
 *
 * Usage:
 *   node --loader ts-node/esm src/worker.ts
 */

import { mkdirSync, createReadStream, readFileSync, writeFileSync } from "fs";
import { unlink } from "fs/promises";
import { spawn } from "child_process";
import { join } from "path";
import { supabase } from "./db/client.js";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const STORAGE_DIR  = "./storage";
const COOKIE_FILE  = "./cookies.json";
const NETSCAPE_COOKIES = "./storage/cookies.txt";
const POLL_MS      = 5_000;
const MAX_RETRIES  = 3;

mkdirSync(STORAGE_DIR, { recursive: true });

// Convert Playwright cookies.json → Netscape format for yt-dlp
function buildNetscapeCookies() {
  try {
    const raw = JSON.parse(readFileSync(COOKIE_FILE, "utf-8"));
    const cookies: { name: string; value: string; domain: string; path: string; expires: number; secure: boolean }[] =
      raw.cookies ?? raw; // Playwright storageState wraps in { cookies: [...] }
    const lines = ["# Netscape HTTP Cookie File", "# https://curl.se/docs/http-cookies.html", ""];
    for (const c of cookies) {
      const domain     = c.domain.startsWith(".") ? c.domain : c.domain;
      const subdomains = c.domain.startsWith(".") ? "TRUE" : "FALSE";
      const path       = c.path ?? "/";
      const secure     = c.secure ? "TRUE" : "FALSE";
      // yt-dlp rejects expires=-1 (session cookies); use far-future timestamp instead
      const expires    = (c.expires && c.expires > 0) ? Math.floor(c.expires) : 2147483647;
      lines.push(`${domain}\t${subdomains}\t${path}\t${secure}\t${expires}\t${c.name}\t${c.value}`);
    }
    writeFileSync(NETSCAPE_COOKIES, lines.join("\n"));
    console.log(`Cookies loaded (${cookies.length} entries)`);
  } catch {
    console.warn("No cookies.json found — downloads may fail without login");
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`  $ ${cmd} ${args.join(" ")}`);
    const proc = spawn(cmd, args, { stdio: "pipe" });

    let lastLine = "";
    const onData = (data: Buffer) => {
      const text = data.toString();
      process.stdout.write(text);
      const lines = text.trim().split("\n");
      if (lines.at(-1)) lastLine = lines.at(-1)!;
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    // heartbeat so the user knows it's still alive
    const heartbeat = setInterval(() => {
      console.log(`  … still running (last: ${lastLine.slice(0, 80)})`);
    }, 10_000);

    proc.on("close", (code) => {
      clearInterval(heartbeat);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    proc.on("error", (err) => { clearInterval(heartbeat); reject(err); });
  });
}

async function setJobStatus(
  id: string,
  status: string,
  extra: Record<string, unknown> = {}
) {
  await supabase.from("post_media_jobs").update({ status, ...extra }).eq("id", id);
}

// ── pipeline steps ────────────────────────────────────────────────────────────

async function download(videoUrl: string, outPath: string): Promise<void> {
  await run("yt-dlp", [
    "--no-playlist",
    "--cookies", NETSCAPE_COOKIES,
    "--output", outPath,
    "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "--merge-output-format", "mp4",
    videoUrl,
  ]);
}

async function extractAudio(videoPath: string, audioPath: string): Promise<void> {
  await run("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-vn",
    "-ar", "16000",   // 16kHz — optimal for Whisper
    "-ac", "1",       // mono
    "-c:a", "pcm_s16le",
    audioPath,
  ]);
}

async function transcribe(audioPath: string): Promise<{
  text: string;
  language: string;
  duration: number;
  segments: unknown;
}> {
  // gpt-4o-mini-transcribe only supports 'json' | 'text' (verbose_json is
  // whisper-1 only). 'json' returns text only — duration/segments come back
  // undefined and fall back to 0/null below; the guest flow only needs the text.
  const resp = await openai.audio.transcriptions.create({
    model: "gpt-4o-mini-transcribe",
    file: createReadStream(audioPath) as never,
    response_format: "json",
    language: "zh",
  });

  return {
    text:     resp.text,
    language: (resp as { language?: string }).language ?? "zh",
    duration: (resp as { duration?: number }).duration ?? 0,
    segments: (resp as { segments?: unknown }).segments ?? null,
  };
}

// ── main job processor ────────────────────────────────────────────────────────

async function processJob(job: {
  id: string;
  hot_post_id: string;
  source_video_url: string;
  retry_count: number;
}) {
  const videoPath = join(STORAGE_DIR, `${job.hot_post_id}.mp4`);
  const audioPath = join(STORAGE_DIR, `${job.hot_post_id}.wav`);

  console.log(`\n[job ${job.id}] processing hot_post ${job.hot_post_id}`);
  console.log(`  url: ${job.source_video_url}`);

  try {
    // 1. download
    await setJobStatus(job.id, "downloading");
    console.log("  → downloading…");
    await download(job.source_video_url, videoPath);
    await setJobStatus(job.id, "downloaded", { downloaded_video_path: videoPath });

    // 2. extract audio
    await setJobStatus(job.id, "extracting_audio");
    console.log("  → extracting audio…");
    await extractAudio(videoPath, audioPath);
    await setJobStatus(job.id, "transcribing", { audio_path: audioPath });

    // 3. transcribe
    console.log("  → transcribing…");
    const result = await transcribe(audioPath);

    // 4. save transcript
    await supabase.from("post_transcripts").upsert(
      {
        hot_post_id:      job.hot_post_id,
        model:            "gpt-4o-mini-transcribe",
        transcript:       result.text,
        language:         result.language,
        duration_seconds: result.duration,
        segments:         result.segments,
      },
      { onConflict: "hot_post_id" }
    );

    // 5. mark done — write transcript_status, NOT admin_status (admin_status is
    // the production-curation pipeline in /admin/hot-posts; clobbering it with
    // 'done' would mark a freshly-crawled post as 「已制作」).
    await setJobStatus(job.id, "done");
    await supabase
      .from("hot_posts")
      .update({ transcript_status: "done" })
      .eq("id", job.hot_post_id);

    console.log(`  ✓ done — "${result.text.slice(0, 80)}…"`);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ failed: ${msg}`);
    await setJobStatus(job.id, "failed", {
      error_text:  msg,
      retry_count: job.retry_count + 1,
    });
    // Only flag the hot_post as failed once retries are exhausted; otherwise it
    // stays 'pending' and a later attempt can still flip it to 'done'.
    if (job.retry_count + 1 >= MAX_RETRIES) {
      await supabase
        .from("hot_posts")
        .update({ transcript_status: "failed" })
        .eq("id", job.hot_post_id);
    }
  } finally {
    // clean up local files regardless of outcome
    for (const p of [videoPath, audioPath]) {
      unlink(p).catch(() => {});
    }
  }
}

// ── poll loop ─────────────────────────────────────────────────────────────────

async function poll() {
  const { data: job } = await supabase
    .from("post_media_jobs")
    .select("id, hot_post_id, source_video_url, retry_count")
    .eq("status", "pending")
    .lt("retry_count", MAX_RETRIES)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (job) await processJob(job);
}

buildNetscapeCookies();
console.log(`DYCrawler worker started — polling every ${POLL_MS / 1000}s`);
console.log(`Storage: ${STORAGE_DIR}\n`);

setInterval(poll, POLL_MS);
poll(); // run immediately on start
