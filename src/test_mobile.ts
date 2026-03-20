/**
 * Quick test: try Douyin search with mobile user-agent to see if it bypasses login gate.
 */
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const KEYWORD = process.env.KEYWORD ?? "洛杉矶";
const URL = `https://www.douyin.com/search/${encodeURIComponent(KEYWORD)}?type=video`;

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({
  locale: "zh-CN",
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_34.6.0 " +
    "JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/zh_CN ByteFullLocale/zh_CN",
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

const page = await ctx.newPage();
let found = false;

page.on("response", async (response) => {
  const url = response.url();
  if (!url.includes("search") || !url.includes("aweme") && !url.includes("item")) return;
  const ct = response.headers()["content-type"] ?? "";
  if (!ct.includes("json")) return;
  try {
    const body = await response.json() as any;
    const list = body.aweme_list ?? body.data;
    console.log(`[API] ${url.slice(0, 100)}`);
    console.log(`  aweme_list: ${JSON.stringify(list)?.slice(0, 100)}`);
    if (list && list.length > 0) found = true;
  } catch {}
});

console.log("Opening:", URL);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
await page.waitForTimeout(6_000);

await page.screenshot({ path: "debug_mobile.png" });
console.log(found ? "\nGot results!" : "\nNo results.");
await browser.close();
