/**
 * comments.ts — fetch top comments for a set of Douyin videos and write them to
 * post_comments. Reuses the proven parser in parse.ts.
 *
 * Strategy: open each video's detail page and intercept the comment/list API the
 * page fires (first page auto-loads; scrolling pulls more cursors). Merge, dedup,
 * keep Top N by like count.
 *
 * Usage (normally invoked by runner.ts after a douyin search):
 *   AWEME_IDS="7603...,7558..." TOP_N=10 HEADED=1 \
 *     node --loader ts-node/esm src/comments.ts
 *
 * Env:
 *   AWEME_IDS    comma-separated douyin aweme_id list (required)
 *   TOP_N        comments to keep per video (default 10)
 *   PAGES        comment scroll passes per video (default 4)
 *   HEADED       1 = show browser (solve CAPTCHA); default 1
 *   COOKIE_FILE  storageState (default ./cookies.json)
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { existsSync } from "fs";
import { parseDouyinComments, topComments, type ParsedComment } from "./parse.js";
import { getHotPostIdMap, upsertComments } from "./db/comments.js";

chromium.use(StealthPlugin());

const AWEME_IDS = (process.env.AWEME_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const TOP_N = parseInt(process.env.TOP_N ?? "10", 10);
const PAGES = parseInt(process.env.PAGES ?? "4", 10);
const HEADED = (process.env.HEADED ?? "1") === "1";
const COOKIE_FILE = process.env.COOKIE_FILE ?? "./cookies.json";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (AWEME_IDS.length === 0) {
  console.error("AWEME_IDS is empty — nothing to do.");
  process.exit(0);
}

console.log(`\ncomments: ${AWEME_IDS.length} videos, top ${TOP_N} each (headed=${HEADED})`);

const idMap = await getHotPostIdMap("douyin", AWEME_IDS);
const targets = AWEME_IDS.filter((id) => idMap.has(id));
if (targets.length === 0) {
  console.log("none of the aweme_ids exist in hot_posts yet — skipping.");
  process.exit(0);
}

const browser = await chromium.launch({ headless: !HEADED, args: ["--lang=zh-CN", "--no-sandbox"] });
const ctx = await browser.newContext({
  locale: "zh-CN",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  ...(existsSync(COOKIE_FILE) ? { storageState: COOKIE_FILE } : {}),
});
const page = await ctx.newPage();

// Bucket every comment/list response by its aweme_id so late responses never
// bleed into the wrong video.
const byAweme = new Map<string, Map<string, ParsedComment>>();

page.on("response", async (res) => {
  const url = res.url();
  if (!url.includes("comment/list")) return;
  const ct = res.headers()["content-type"] ?? "";
  if (!ct.includes("json")) return;
  try {
    const json = await res.json();
    const awemeId = String((json?.comments?.[0]?.aweme_id) ?? "");
    if (!awemeId) return;
    if (!byAweme.has(awemeId)) byAweme.set(awemeId, new Map());
    const bucket = byAweme.get(awemeId)!;
    for (const c of parseDouyinComments(json)) bucket.set(c.comment_id, c);
  } catch {
    // not JSON / parse error — skip
  }
});

async function dismissModals() {
  for (const sel of ['button:has-text("取消")', 'button:has-text("暂不登录")', 'button[aria-label="关闭"]', '.modal-close']) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1_000 })) { await el.click(); await sleep(500); }
    } catch { /* not present */ }
  }
}

for (const awemeId of targets) {
  const hotPostId = idMap.get(awemeId)!;
  console.log(`\n[video ${awemeId}] opening detail…`);
  try {
    await page.goto(`https://www.douyin.com/video/${awemeId}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await sleep(3_000);
    await dismissModals();

    // The detail page sometimes renders blank on first load; a reload reliably
    // populates the comment panel (matches what we saw during capture).
    if ((byAweme.get(awemeId)?.size ?? 0) === 0) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await sleep(2_500);
      await dismissModals();
    }

    // First comment page usually auto-loads; scroll to pull more cursors.
    let last = 0;
    for (let i = 0; i < PAGES; i++) {
      try {
        await page.evaluate(() => {
          const sc = document.querySelector('[data-e2e="comment-list"]') ?? document.scrollingElement ?? document.body;
          (sc as Element).scrollTop = (sc as Element).scrollHeight;
          window.scrollBy(0, window.innerHeight);
        });
      } catch { /* page may navigate */ }
      await sleep(2_000);
      const have = byAweme.get(awemeId)?.size ?? 0;
      if (have === last && have > 0) break; // no new comments loading
      last = have;
    }

    const bucket = [...(byAweme.get(awemeId)?.values() ?? [])];
    const top = topComments(bucket, TOP_N);
    await upsertComments(hotPostId, top);
    console.log(`  ✓ ${bucket.length} comments seen → wrote top ${top.length}`);
  } catch (e) {
    console.error(`  ✗ ${awemeId}: ${e instanceof Error ? e.message : e}`);
  }
  await sleep(3_000 + Math.floor((Date.now() % 3_000)));
}

try { await ctx.storageState({ path: COOKIE_FILE }); } catch { /* non-fatal */ }
await browser.close();
console.log("\ncomments done.\n");
process.exit(0);
