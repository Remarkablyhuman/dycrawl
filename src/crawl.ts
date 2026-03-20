/**
 * DYCrawler — Douyin search crawler (console output mode)
 *
 * Strategy: intercept Douyin's internal search API responses (XHR/fetch)
 * instead of DOM-scraping. This gives us clean structured data.
 *
 * Usage:
 *   KEYWORD="your keyword" node --loader ts-node/esm src/crawl.ts
 *   KEYWORD="your keyword" MAX_VIDEOS=30 HEADED=1 node --loader ts-node/esm src/crawl.ts
 *
 * Set HEADED=1 to show the browser window (needed if Douyin shows a CAPTCHA).
 * Set COOKIE_FILE=./cookies.json to load saved cookies from a previous session.
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { existsSync } from "fs";
import { score, printResults, type VideoMeta, type ScoredVideo } from "./scorer.js";

chromium.use(StealthPlugin());

const KEYWORD = process.env.KEYWORD ?? "搞笑";
const MAX_VIDEOS = parseInt(process.env.MAX_VIDEOS ?? "20", 10);
const HEADED = process.env.HEADED === "1";
const LOGIN = process.env.LOGIN === "1"; // open browser for manual login, save session, then exit
const COOKIE_FILE = process.env.COOKIE_FILE ?? "./cookies.json";

const SEARCH_URL = `https://www.douyin.com/search/${encodeURIComponent(KEYWORD)}?type=video`;

// ── Douyin API response types (partial) ─────────────────────────────────────

interface DouyinAuthor {
  uid?: string;
  unique_id?: string;
  nickname?: string;
  follower_count?: number;
  total_favorited?: number;
  aweme_count?: number;
}

interface DouyinStats {
  digg_count?: number;      // likes
  comment_count?: number;
  share_count?: number;
  collect_count?: number;
}

interface DouyinAweme {
  aweme_id?: string;
  desc?: string;            // title / caption
  create_time?: number;     // unix timestamp
  author?: DouyinAuthor;
  statistics?: DouyinStats;
  video?: {
    cover?: { url_list?: string[] };
    play_addr?: { url_list?: string[] };
  };
  share_url?: string;
}

interface DouyinSearchResponse {
  data?: Array<{ aweme_info?: DouyinAweme }>;
  aweme_list?: DouyinAweme[];
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parseAweme(aweme: DouyinAweme, keyword: string): VideoMeta | null {
  const id = aweme.aweme_id;
  if (!id) return null;

  const stats = aweme.statistics ?? {};
  const author = aweme.author ?? {};

  return {
    video_id: id,
    url: aweme.share_url ?? `https://www.douyin.com/video/${id}`,
    title: aweme.desc ?? "",
    author_name: author.nickname ?? "",
    author_id: author.uid ?? author.unique_id ?? "",
    like_count: stats.digg_count ?? 0,
    comment_count: stats.comment_count ?? 0,
    share_count: stats.share_count ?? 0,
    publish_time: aweme.create_time ? new Date(aweme.create_time * 1000) : null,
    cover_image: aweme.video?.cover?.url_list?.[0] ?? "",
    keyword_source: keyword,
    author_follower_count: author.follower_count ?? 0,
    author_total_likes: author.total_favorited ?? 0,
    author_post_count: author.aweme_count ?? 0,
  };
}

// ── modal dismissal ──────────────────────────────────────────────────────────

async function retriggerSearch(page: any, keyword: string) {
  try {
    // Click the video tab to re-trigger the search API
    const videoTab = page.locator('li:has-text("视频"), [data-e2e="search-tab-video"]').first();
    if (await videoTab.isVisible({ timeout: 2_000 })) {
      await videoTab.click();
      console.log("  clicked 视频 tab to re-trigger search");
      return;
    }
  } catch { /* fallback */ }

  try {
    // Fallback: click into search box and re-submit
    const input = page.locator('input[type="search"], input[placeholder*="搜索"]').first();
    if (await input.isVisible({ timeout: 2_000 })) {
      await input.click();
      await input.press("Enter");
      console.log("  re-submitted search via Enter");
    }
  } catch { /* ignore */ }
}

async function dismissModals(page: any) {
  // "请登录后继续使用" — click 取消 (Cancel) to stay as guest
  const cancelSelectors = [
    'button:has-text("取消")',
    'button:has-text("稍后再说")',
    'button:has-text("暂不登录")',
    '[data-e2e="modal-close"]',
    '.modal-close',
    'button[aria-label="关闭"]',
  ];
  for (const sel of cancelSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1_500 })) {
        await el.click();
        await page.waitForTimeout(800);
        console.log(`  dismissed modal: ${sel}`);
      }
    } catch { /* not present */ }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

console.log(`\nDYCrawler starting`);
console.log(`  keyword  : "${KEYWORD}"`);
console.log(`  target   : ${MAX_VIDEOS} videos`);
console.log(`  headless : ${!HEADED}`);
console.log(`  url      : ${SEARCH_URL}\n`);

const browser = await chromium.launch({
  headless: !HEADED,
  args: ["--lang=zh-CN", "--no-sandbox"],
});

const ctx = await browser.newContext({
  locale: "zh-CN",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  // Load saved cookies if available
  ...(existsSync(COOKIE_FILE)
    ? { storageState: COOKIE_FILE }
    : {}),
});

const page = await ctx.newPage();
const collected = new Map<string, VideoMeta>(); // keyed by video_id

// ── intercept search API responses ───────────────────────────────────────────

page.on("response", async (response) => {
  const url = response.url();

  // Douyin search API patterns:
  //   /aweme/v1/web/search/item/
  //   /search/item/
  //   /api/search/
  if (
    !url.includes("search") ||
    !url.includes("aweme") && !url.includes("item")
  ) {
    return;
  }

  // Only care about JSON responses
  const ct = response.headers()["content-type"] ?? "";
  if (!ct.includes("json")) return;

  try {
    const body = await response.json() as DouyinSearchResponse;

    // The response can nest results in different shapes depending on the endpoint
    const awemes: DouyinAweme[] = [
      ...(body.aweme_list ?? []),
      ...(body.data ?? []).map((d) => d.aweme_info).filter(Boolean) as DouyinAweme[],
    ];

    for (const aweme of awemes) {
      const meta = parseAweme(aweme, KEYWORD);
      if (meta && !collected.has(meta.video_id)) {
        collected.set(meta.video_id, meta);
        process.stdout.write(`  + captured video ${collected.size}: ${meta.title.slice(0, 40)}\n`);
      }
    }
  } catch {
    // not JSON or parse error — skip
  }
});

// ── login mode ────────────────────────────────────────────────────────────────

if (LOGIN) {
  console.log("\nLOGIN MODE — a browser window will open.");
  console.log("1. Log into your Douyin account.");
  console.log("2. The session saves automatically once login is detected.");
  console.log("   (max wait: 3 minutes)\n");
  await page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Poll every 3s for up to 3 minutes until a real session cookie appears
  const deadline = Date.now() + 180_000;
  let saved = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3_000);
    const cookies = await ctx.cookies();
    const isLoggedIn = cookies.some((c) =>
      ["sessionid", "sessionid_ss", "passport_auth_status", "sid_ucp_v1"].includes(c.name)
    );
    if (isLoggedIn) {
      await ctx.storageState({ path: COOKIE_FILE });
      console.log(`\nLogged in! Session saved to ${COOKIE_FILE}`);
      console.log(`You can now run: KEYWORD="洛杉矶" node --loader ts-node/esm src/crawl.ts`);
      saved = true;
      break;
    }
    process.stdout.write(".");
  }
  if (!saved) {
    console.log("\nTimeout reached. Saving whatever session exists…");
    await ctx.storageState({ path: COOKIE_FILE });
  }
  await browser.close();
  process.exit(0);
}

// ── navigate ──────────────────────────────────────────────────────────────────

await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
await page.waitForTimeout(3_000);

// Dismiss login / cookie modals (click Cancel / 取消 to stay as guest)
await dismissModals(page);

// If no results yet, the search may need to be re-triggered after modal close
if (collected.size === 0) {
  await page.waitForTimeout(1_000);
  await dismissModals(page);
  // Re-trigger search: click the search input and press Enter
  await retriggerSearch(page, KEYWORD);
  await page.waitForTimeout(3_000);
  await dismissModals(page);
}

if (HEADED) {
  console.log("\nBrowser is open. Solve any CAPTCHA manually.");
  console.log("Waiting 45 seconds for interaction…");
  await page.waitForTimeout(45_000);
} else {
  await page.waitForTimeout(4_000);
}

// Scroll to load more results if needed
let scrolls = 0;
while (collected.size < MAX_VIDEOS && scrolls < 8) {
  try {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
  } catch {
    // Page may have navigated — wait and continue
    await page.waitForTimeout(3_000);
  }
  await page.waitForTimeout(2_500);
  scrolls++;
}

// ── save cookies for next run ─────────────────────────────────────────────────

try {
  await ctx.storageState({ path: COOKIE_FILE });
  console.log(`\nSession cookies saved to ${COOKIE_FILE}`);
} catch {
  // non-fatal
}

await browser.close();

// ── output results ────────────────────────────────────────────────────────────

const videos = [...collected.values()].slice(0, MAX_VIDEOS);

if (videos.length === 0) {
  console.log("\nNo videos captured via API interception.");
  console.log("Try running with HEADED=1 to see if there's a CAPTCHA to solve:");
  console.log(`  HEADED=1 KEYWORD="${KEYWORD}" node --loader ts-node/esm src/crawl.ts`);
} else {
  const scored: ScoredVideo[] = videos.map(score);
  printResults(scored, KEYWORD);
}
