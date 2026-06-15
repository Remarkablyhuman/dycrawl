/**
 * account_wechat.ts — capture a guest's 视频号 account data from 视频号助手.
 *
 * Attended, per-guest. Loads the guest's saved 助手 session if we have one
 * (no QR needed); otherwise opens a fresh window for QR login. You navigate to
 * 数据中心 → 内容数据 (and 粉丝数据); the script intercepts auth_data / post_list /
 * fans_trend, then on ENTER writes guest_accounts + account_snapshots +
 * account_videos (with 播放量 + 完播率) and saves/refreshes the session.
 *
 * Usage:
 *   GUEST_EMAIL="guest@example.com" node --loader ts-node/esm src/account_wechat.ts
 *
 * Env:
 *   GUEST_EMAIL   the guest's login email (maps to profiles.id) — required
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import readline from "readline";
import { parseWechatAccount, parseWechatPosts, type ParsedWxVideo } from "./parse.js";
import {
  getGuestIdByEmail, findWechatAccount, upsertWechatAccount,
  writeAccountSnapshot, writeAccountVideos, loadSession, saveSession,
} from "./db/accounts.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
chromium.use(StealthPlugin());

const GUEST_EMAIL = process.env.GUEST_EMAIL ?? "";
if (!GUEST_EMAIL) { console.error("GUEST_EMAIL is required."); process.exit(1); }

const guestId = await getGuestIdByEmail(GUEST_EMAIL);
if (!guestId) { console.error(`No profile found for ${GUEST_EMAIL}.`); process.exit(1); }

const existingAccountId = await findWechatAccount(guestId);
const session = existingAccountId ? await loadSession(existingAccountId) : null;

console.log(`\n视频号账号抓取 — ${GUEST_EMAIL}`);
console.log(`  session: ${session ? "已加载(免扫码)" : "无(需扫码登录)"}`);

const browser = await chromium.launch({ headless: false, args: ["--lang=zh-CN", "--no-sandbox"] });
const ctx = await browser.newContext({
  locale: "zh-CN",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  ...(session ? { storageState: session as any } : {}),
});
const page = await ctx.newPage();

let authData: any = null;
const posts = new Map<string, ParsedWxVideo>();
let fansTotal: number | null = null;

page.on("response", async (res) => {
  const url = res.url();
  if (!url.includes("mmfinderassistant-bin")) return;
  const ct = res.headers()["content-type"] ?? "";
  if (!ct.includes("json")) return;
  try {
    const json = await res.json();
    if (url.includes("auth/auth_data")) {
      authData = json;
      console.log("  ✓ 账号信息");
    } else if (url.includes("post/post_list")) {
      let n = 0;
      for (const v of parseWechatPosts(json)) { posts.set(v.video_id, v); n++; }
      console.log(`  ✓ 作品数据 +${n}(累计 ${posts.size})`);
    } else if (url.includes("statistic/fans_trend")) {
      const t = json?.data?.total;
      if (Array.isArray(t) && t.length) fansTotal = Number(t[t.length - 1]);
      console.log("  ✓ 粉丝数据");
    }
  } catch { /* skip */ }
});

console.log("\n步骤:① 若需登录,扫码;② 进【数据中心 → 内容数据】(下滑加载作品);③ 看一下【粉丝数据】。");
console.log("看到上面的 ✓ 账号信息 / ✓ 作品数据 后,回终端按 ENTER 写入。\n");

await page.goto("https://channels.weixin.qq.com/platform", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});

await new Promise<void>((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("", () => { rl.close(); resolve(); });
});

const acct = parseWechatAccount(authData);
if (!acct || !acct.uniq_id) {
  console.error("\n没抓到账号信息(auth_data)。确认已登录并进入助手后台,再重试。");
  await saveCookiesQuietly();
  await browser.close();
  process.exit(1);
}

const accountId = await upsertWechatAccount(guestId, acct.uniq_id, acct.nickname, "https://channels.weixin.qq.com/platform");
await writeAccountSnapshot(accountId, {
  follower_count: fansTotal ?? acct.fans_count,
  total_likes: null,
  post_count: acct.feeds_count,
});

const vids = [...posts.values()].map((p) => ({
  video_id: p.video_id,
  title: p.title,
  url: "",
  cover_image: p.cover_image,
  publish_time: p.publish_time,
  like_count: p.like_count,
  comment_count: p.comment_count,
  share_count: p.share_count,
  play_count: p.read_count,
  completion_rate: p.full_play_rate,
  avg_play_time_sec: p.avg_play_time_sec,
}));
await writeAccountVideos(accountId, vids);

await saveSession(accountId, await ctx.storageState());
await browser.close();

console.log(`\n完成:${acct.nickname} · 粉丝 ${fansTotal ?? acct.fans_count} · 作品 ${acct.feeds_count} · 写入 ${vids.length} 条作品(含播放量/完播率)。`);
process.exit(0);

async function saveCookiesQuietly() {
  try {
    if (existingAccountId) await saveSession(existingAccountId, await ctx.storageState());
  } catch { /* non-fatal */ }
}
