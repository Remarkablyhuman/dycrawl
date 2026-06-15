/**
 * capture.ts — interactive API-sample capturer.
 *
 * Opens a HEADED browser, lets you navigate/scroll/log in by hand, and saves the
 * FULL body of every JSON response to ./capture/<mode>/NNN.json plus an index.
 * Responses whose URL looks relevant to the chosen MODE are flagged [MATCH] in
 * the console and in the index, so the right endpoint is easy to spot.
 *
 * You press ENTER in the terminal when you're done — only then does it save
 * cookies and exit. Nothing is sent anywhere; files stay on your machine.
 *
 * Usage:
 *   # 1) Douyin top comments — open a VIDEO detail page, scroll the comments
 *   MODE=douyin_comment URL="https://www.douyin.com/video/XXXXXXXXXXXXX" \
 *     node --loader ts-node/esm src/capture.ts
 *
 *   # 2) Douyin account — open a CREATOR profile, scroll their works
 *   MODE=douyin_account URL="https://www.douyin.com/user/MS4wLjAB..." \
 *     node --loader ts-node/esm src/capture.ts
 *
 *   # 3) WeChat 视频号助手 — log in (QR), go to 数据中心, open a work's data
 *   MODE=wechat_assistant node --loader ts-node/esm src/capture.ts
 *
 * Env:
 *   MODE         douyin_comment | douyin_account | wechat_assistant
 *   URL          start URL (defaults: douyin home / 视频号助手 platform)
 *   COOKIE_FILE  storageState file (default: cookies.json, or wechat_cookies.json for wechat)
 *   OUT_DIR      output dir (default: ./capture)
 *   MAX_FILES    safety cap on saved files (default: 500)
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import readline from "readline";

chromium.use(StealthPlugin());

type Mode = "douyin_comment" | "douyin_account" | "wechat_assistant";

const MODE = (process.env.MODE ?? "") as Mode;
const VALID: Mode[] = ["douyin_comment", "douyin_account", "wechat_assistant"];
if (!VALID.includes(MODE)) {
  console.error(`\nMODE must be one of: ${VALID.join(" | ")}`);
  console.error(`Example: MODE=douyin_comment URL="https://www.douyin.com/video/123" npm run capture\n`);
  process.exit(1);
}

const isWechat = MODE === "wechat_assistant";
const COOKIE_FILE = process.env.COOKIE_FILE ?? (isWechat ? "./wechat_cookies.json" : "./cookies.json");
const OUT_DIR = join(process.env.OUT_DIR ?? "./capture", MODE);
const MAX_FILES = parseInt(process.env.MAX_FILES ?? "1200", 10);
const START_URL =
  process.env.URL ??
  (isWechat ? "https://channels.weixin.qq.com/platform" : "https://www.douyin.com/");

// URL substrings that mark a response as relevant to this mode (hint only —
// every JSON response is saved regardless, so nothing is missed).
const MATCHERS: Record<Mode, (url: string) => boolean> = {
  douyin_comment: (u) => u.includes("comment/"),
  douyin_account: (u) =>
    u.includes("aweme/post") || u.includes("web/aweme/post") || u.includes("user/profile") || u.includes("web/user"),
  wechat_assistant: (u) => u.includes("channels.weixin.qq.com") && /finder|statistic|data|post|helper|cgi-bin/.test(u),
};
const isMatch = MATCHERS[MODE];

// High-frequency telemetry / auth-poll noise — never saved, so the file budget
// is spent on real data endpoints (esp. WeChat 助手 polls these every few sec).
const IGNORE = /auth_login_status|auth_login_code|report-perf|report-error|report-idkey|report-custom|online_heartbeat|helper_report|_mmdata|weblog|monitor_web|zijieapi|abtest_config/i;

mkdirSync(OUT_DIR, { recursive: true });
const indexPath = join(OUT_DIR, "index.tsv");
writeFileSync(indexPath, "idx\tstatus\tmatch\turl\n");

const browser = await chromium.launch({
  headless: false, // always headed — this is an interactive capture
  args: ["--lang=zh-CN", "--no-sandbox"],
});

const ctx = await browser.newContext({
  locale: "zh-CN",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  ...(existsSync(COOKIE_FILE) ? { storageState: COOKIE_FILE } : {}),
});

const page = await ctx.newPage();

let saved = 0;
let matched = 0;

page.on("response", async (response) => {
  if (saved >= MAX_FILES) return;
  const url = response.url();
  if (IGNORE.test(url)) return; // drop telemetry/auth-poll noise
  const ct = response.headers()["content-type"] ?? "";
  if (!ct.includes("json")) return;

  try {
    const text = await response.text();
    if (text.length < 50) return; // skip tiny/empty payloads

    const idx = String(saved + 1).padStart(3, "0");
    const hit = isMatch(url);
    writeFileSync(join(OUT_DIR, `${idx}.json`), text);
    appendFileSync(indexPath, `${idx}\t${response.status()}\t${hit ? "MATCH" : "-"}\t${url}\n`);
    saved++;
    if (hit) matched++;
    console.log(`${hit ? "★ [MATCH]" : "  [json] "} ${idx}  ${url.slice(0, 130)}`);
  } catch {
    // body not retrievable (redirect, streamed, etc.) — skip
  }
});

console.log(`\n=== capture: ${MODE} ===`);
console.log(`cookies : ${COOKIE_FILE} ${existsSync(COOKIE_FILE) ? "(loaded)" : "(none — log in by hand)"}`);
console.log(`output  : ${OUT_DIR}/`);
console.log(`start   : ${START_URL}\n`);

if (MODE === "douyin_comment") {
  console.log("步骤：① 浏览器若弹登录/验证码，手动处理；② 等视频详情页加载；");
  console.log("      ③ 把评论区滚到底一两次，让评论接口触发（看终端出现 ★[MATCH] comment/...）。");
} else if (MODE === "douyin_account") {
  console.log("步骤：① 手动处理登录/验证码；② 等创作者主页加载；");
  console.log("      ③ 向下滚动加载作品列表，触发 aweme/post（终端出现 ★[MATCH]）。");
} else {
  console.log("步骤：① 用本人微信扫码登录视频号助手；② 进【数据中心】；");
  console.log("      ③ 点开一个作品看数据 / 看粉丝数据，让后台接口触发。");
}
console.log("\n抓够了就回到这个终端，按 ENTER 结束（会保存登录态再退出）。\n");

await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => {
  console.log(`(goto warning: ${e instanceof Error ? e.message : e} — 你也可以在浏览器里手动导航)`);
});

await new Promise<void>((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("", () => {
    rl.close();
    resolve();
  });
});

try {
  await ctx.storageState({ path: COOKIE_FILE });
  console.log(`\n登录态已保存到 ${COOKIE_FILE}`);
} catch {
  // non-fatal
}

await browser.close();

console.log(`\n完成：共保存 ${saved} 条 JSON（其中 ${matched} 条 ★MATCH）到 ${OUT_DIR}/`);
console.log(`索引看 ${indexPath}；把 ★MATCH 的那几个 .json 文件发我即可。\n`);
process.exit(0);
