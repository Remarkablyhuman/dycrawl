/**
 * WeChatCrawler — WeChat Channels (视频号) search crawler
 *
 * Strategy: intercept WeChat Channels' internal API responses (XHR/fetch)
 * to get clean structured video data, identical approach to crawl.ts.
 *
 * Usage:
 *   KEYWORD="keyword" node --loader ts-node/esm src/crawl_wechat.ts
 *   KEYWORD="keyword" MAX_VIDEOS=30 HEADED=1 node --loader ts-node/esm src/crawl_wechat.ts
 *
 * LOGIN=1 HEADED=1 node --loader ts-node/esm src/crawl_wechat.ts
 *   — opens browser for QR code scan; saves session to wechat_cookies.json
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { existsSync } from "fs";
import { score, printResults, type VideoMeta, type ScoredVideo } from "./scorer.js";
import { upsertVideos } from "./db/upsert.js";

chromium.use(StealthPlugin());

const KEYWORD    = process.env.KEYWORD ?? "洛杉矶";
const MAX_VIDEOS = parseInt(process.env.MAX_VIDEOS ?? "30", 10);
const HEADED     = process.env.HEADED === "1";
const LOGIN      = process.env.LOGIN === "1";
const COOKIE_FILE = process.env.COOKIE_FILE ?? "./wechat_cookies.json";

const SEARCH_URL = `https://channels.weixin.qq.com/web/pages/search?keyword=${encodeURIComponent(KEYWORD)}`;

// ── WeChat Channels API response types ───────────────────────────────────────

interface WechatContact {
  username?: string;
  nickname?: string;
  headImgUrl?: string;
  followCount?: number;     // follower count
  likeCount?: number;       // total likes on their profile
}

interface WechatMediaItem {
  thumbUrl?: string;
  url?: string;
  spec?: Array<{ url?: string }>;
}

interface WechatObject {
  objectId?: string;
  objectNonce?: string;
  description?: string;    // video caption / title
  createTime?: number;     // unix timestamp (seconds)
  likeCount?: number;
  commentCount?: number;
  forwardCount?: number;   // shares / forwards
  contact?: WechatContact;
  mediaList?: WechatMediaItem[];
}

interface WechatFeedItem {
  object?: WechatObject;
}

// The API can return results under several different shapes
interface WechatApiResponse {
  data?: {
    feeds?: WechatFeedItem[];
    list?: WechatFeedItem[];
    videos?: WechatFeedItem[];
    objects?: WechatObject[];
  };
  feeds?: WechatFeedItem[];
  list?: WechatFeedItem[];
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parseFeedItem(item: WechatFeedItem | WechatObject, keyword: string): VideoMeta | null {
  // Items may be wrapped in { object: ... } or be the object directly
  const obj: WechatObject = (item as WechatFeedItem).object ?? (item as WechatObject);
  const id = obj.objectId;
  if (!id) return null;

  const contact = obj.contact ?? {};
  const nonce = obj.objectNonce ?? "";
  const url = nonce
    ? `https://channels.weixin.qq.com/web/pages/feed?objectId=${id}&objectNonce=${nonce}`
    : `https://channels.weixin.qq.com/web/pages/feed?objectId=${id}`;

  const thumbUrl =
    obj.mediaList?.[0]?.thumbUrl ??
    obj.mediaList?.[0]?.spec?.[0]?.url ??
    "";

  return {
    platform: "wechat",
    video_id: id,
    url,
    title: obj.description ?? "",
    author_name: contact.nickname ?? "",
    author_id: contact.username ?? "",
    like_count: obj.likeCount ?? 0,
    comment_count: obj.commentCount ?? 0,
    share_count: obj.forwardCount ?? 0,
    publish_time: obj.createTime ? new Date(obj.createTime * 1000) : null,
    cover_image: thumbUrl,
    keyword_source: keyword,
    author_follower_count: contact.followCount ?? 0,
    author_total_likes: contact.likeCount ?? 0,
    author_post_count: 0,
  };
}

function extractItems(body: WechatApiResponse): Array<WechatFeedItem | WechatObject> {
  return [
    ...(body.data?.feeds   ?? []),
    ...(body.data?.list    ?? []),
    ...(body.data?.videos  ?? []),
    ...(body.data?.objects ?? []),
    ...(body.feeds         ?? []),
    ...(body.list          ?? []),
  ];
}

// ── modal dismissal ──────────────────────────────────────────────────────────

async function dismissModals(page: any) {
  const cancelSelectors = [
    'button:has-text("取消")',
    'button:has-text("稍后再说")',
    'button:has-text("关闭")',
    '[aria-label="关闭"]',
    '.close-btn',
  ];
  for (const sel of cancelSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1_500 })) {
        await el.click();
        await page.waitForTimeout(600);
      }
    } catch { /* not present */ }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

console.log(`\nWeChatCrawler starting`);
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
  ...(!LOGIN && existsSync(COOKIE_FILE)
    ? { storageState: COOKIE_FILE }
    : {}),
});

const page = await ctx.newPage();
const collected = new Map<string, VideoMeta>(); // keyed by video_id

// ── intercept WeChat Channels API responses ───────────────────────────────────

const DEBUG = process.env.DEBUG === "1";

page.on("response", async (response: any) => {
  const url = response.url();

  // WeChat Channels API patterns:
  //   /cgi-bin/mmfindertrip/finder/post/...
  //   channels.weixin.qq.com/cgi-bin/...
  if (!url.includes("channels.weixin.qq.com")) return;

  if (DEBUG) {
    const ct = response.headers()["content-type"] ?? "";
    if (ct.includes("json")) console.log(`  [debug] json response: ${url}`);
  }

  if (
    !url.includes("mmfindertrip") &&
    !url.includes("findertrip") &&
    !url.includes("finder/post") &&
    !url.includes("search")
  ) return;

  const ct = response.headers()["content-type"] ?? "";
  if (!ct.includes("json")) return;

  try {
    const body = await response.json() as WechatApiResponse;
    const items = extractItems(body);

    for (const item of items) {
      const meta = parseFeedItem(item, KEYWORD);
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
  console.log("1. Scan the QR code with your WeChat app to log in.");
  console.log("2. The session saves automatically once login is detected.");
  console.log("   (max wait: 3 minutes)\n");

  await page.goto("https://channels.weixin.qq.com/", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  const deadline = Date.now() + 180_000;
  let saved = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3_000);
    const cookies = await ctx.cookies();
    // WeChat Channels sets these cookies after QR scan login
    const isLoggedIn = cookies.some((c: any) =>
      ["wxuin", "skey", "wxsessid", "data_ticket", "uin"].includes(c.name)
    );
    // Also check if the page URL has moved past the login screen
    const currentUrl = page.url();
    const pastLogin = !currentUrl.includes("login") && currentUrl.includes("channels.weixin");

    if (isLoggedIn || pastLogin) {
      await ctx.storageState({ path: COOKIE_FILE });
      console.log(`\nLogged in! Session saved to ${COOKIE_FILE}`);
      console.log(`You can now run: KEYWORD="关键词" node --loader ts-node/esm src/crawl_wechat.ts`);
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
await dismissModals(page);

if (HEADED) {
  console.log("\nBrowser is open. Solve any CAPTCHA manually.");
  console.log("Waiting 45 seconds for interaction…");
  await page.waitForTimeout(45_000);
} else {
  await page.waitForTimeout(4_000);
}

// If no results yet, try re-triggering search
if (collected.size === 0) {
  try {
    const input = page.locator('input[type="search"], input[placeholder*="搜索"]').first();
    if (await input.isVisible({ timeout: 2_000 })) {
      await input.click();
      await input.press("Enter");
      await page.waitForTimeout(3_000);
    }
  } catch { /* ignore */ }
}

// Scroll to load more results
let scrolls = 0;
while (collected.size < MAX_VIDEOS && scrolls < 8) {
  try {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
  } catch {
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
  console.log("Tips:");
  console.log("  1. Run with HEADED=1 to check for login prompts or CAPTCHAs.");
  console.log("  2. If not logged in, run: LOGIN=1 HEADED=1 node --loader ts-node/esm src/crawl_wechat.ts");
  console.log(`  3. Try: HEADED=1 KEYWORD="${KEYWORD}" node --loader ts-node/esm src/crawl_wechat.ts`);
} else {
  const scored: ScoredVideo[] = videos.map(score);
  printResults(scored, KEYWORD);

  process.stdout.write("\nSaving to Supabase…");
  await upsertVideos(scored);
  console.log(` ${scored.length} rows upserted into hot_posts (platform=wechat).`);
}
