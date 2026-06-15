/**
 * probe_wechat_login.ts — open 视频号助手 login page LOGGED OUT and dump what's
 * there, so we can locate the QR element for the self-service bind flow.
 *
 * Uses a FRESH context (no wechat_cookies.json) so the QR login screen shows.
 * Saves a full screenshot, an element inventory, and cropped screenshots of
 * square-ish candidates (the QR is almost certainly one of them).
 *
 *   node --loader ts-node/esm src/probe_wechat_login.ts
 *
 * Output: ./capture/wechat_login/{page.png, elements.json, cand_*.png}
 * Nothing is uploaded; press ENTER to close.
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import readline from "readline";

/* eslint-disable @typescript-eslint/no-explicit-any */
chromium.use(StealthPlugin());

const OUT = "./capture/wechat_login";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: false, args: ["--lang=zh-CN", "--no-sandbox"] });
const ctx = await browser.newContext({
  locale: "zh-CN",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  // NO storageState — we want the logged-out QR screen
});
const page = await ctx.newPage();

console.log("\n打开视频号助手登录页(未登录)…二维码出现后别扫,等脚本截图。");
await page.goto("https://channels.weixin.qq.com/login", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
await page.waitForTimeout(6_000);

await page.screenshot({ path: join(OUT, "page.png"), fullPage: false });

const els: any[] = await page.evaluate(() => {
  const out: any[] = [];
  const sel = "img, canvas, iframe, [class*='qr' i], [class*='code' i], [id*='qr' i]";
  for (const el of Array.from(document.querySelectorAll(sel))) {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width < 40 || r.height < 40) continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      id: (el as HTMLElement).id || null,
      cls: (el.getAttribute("class") || "").slice(0, 140),
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.left), y: Math.round(r.top),
      src: el.tagName === "IMG" ? (el.getAttribute("src") || "").slice(0, 100) : null,
    });
  }
  return out;
});
writeFileSync(join(OUT, "elements.json"), JSON.stringify(els, null, 2));

// Crop square-ish candidates — the QR is very likely one of these.
let i = 0;
for (const e of els) {
  if (Math.abs(e.w - e.h) <= 40 && e.w >= 80 && e.w <= 420 && e.x >= 0 && e.y >= 0) {
    await page
      .screenshot({ path: join(OUT, `cand_${i}.png`), clip: { x: e.x, y: e.y, width: e.w, height: e.h } })
      .catch(() => {});
    console.log(`  cand_${i}.png  <${e.tag}> ${e.w}x${e.h} cls="${e.cls}"`);
    i++;
  }
}

console.log(`\n已保存 page.png + elements.json + ${i} 个候选裁图到 ${OUT}/`);
console.log("看一眼浏览器里二维码确实出来了,然后回终端按 ENTER 关闭。\n");

await new Promise<void>((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("", () => { rl.close(); resolve(); });
});

await browser.close();
process.exit(0);
