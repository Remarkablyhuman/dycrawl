/**
 * Debug script — intercepts ALL network responses to find Douyin's search API.
 * Run with HEADED=1 to solve CAPTCHA manually.
 *
 * Usage:
 *   HEADED=1 KEYWORD="搞笑" node --loader ts-node/esm src/debug.ts
 */
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { writeFileSync } from "fs";

chromium.use(StealthPlugin());

const KEYWORD = process.env.KEYWORD ?? "搞笑";
const HEADED = process.env.HEADED === "1";
const SEARCH_URL = `https://www.douyin.com/search/${encodeURIComponent(KEYWORD)}?type=video`;

const browser = await chromium.launch({
  headless: !HEADED,
  args: ["--lang=zh-CN", "--no-sandbox"],
});

const ctx = await browser.newContext({
  locale: "zh-CN",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});

const page = await ctx.newPage();
const jsonResponses: Array<{ url: string; bodySnippet: string }> = [];

page.on("response", async (response) => {
  const url = response.url();
  const ct = response.headers()["content-type"] ?? "";
  if (!ct.includes("json")) return;

  try {
    const text = await response.text();
    if (text.length < 50) return;

    jsonResponses.push({
      url,
      bodySnippet: text.slice(0, 200),
    });
    console.log(`[JSON] ${url.slice(0, 120)}`);
  } catch {
    // skip
  }
});

console.log("Opening", SEARCH_URL);
await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

if (HEADED) {
  console.log("\nSolve CAPTCHA in the browser window. Waiting 45s…");
  await page.waitForTimeout(45_000);
} else {
  await page.waitForTimeout(8_000);
}

// Scroll once to trigger more API calls
try {
  await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
  await page.waitForTimeout(3_000);
} catch {}

// Screenshot
await page.screenshot({ path: "debug_screenshot.png", fullPage: false });
console.log("\nScreenshot saved to debug_screenshot.png");

// Save all JSON URLs to file
writeFileSync(
  "debug_json_urls.txt",
  jsonResponses.map((r) => `${r.url}\n  ${r.bodySnippet}\n`).join("\n")
);
console.log(`\nSaved ${jsonResponses.length} JSON responses to debug_json_urls.txt`);

await browser.close();
