/**
 * wechat_login_worker.ts — relays the 视频号助手 QR to guests for self-service bind.
 *
 * Polls wechat_login_requests for a guest-initiated request, opens the 助手 login
 * page, screenshots the QR card (the iframe.display region) into the request row,
 * refreshes it as it rotates, and on scan-success captures the session +
 * account-level data, then marks the request done. No CAPTCHA here, so it can run
 * headless on a small always-on box (set HEADED=0).
 *
 *   HEADED=1 node --loader ts-node/esm src/wechat_login_worker.ts
 *
 * Env: HEADED (1 show browser, default 1) · POLL_MS · QR_TTL_MIN (give up, default 5)
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { parseWechatAccount } from "./parse.js";
import { upsertWechatAccount, writeAccountSnapshot, saveSession } from "./db/accounts.js";
import { claimPendingRequest, updateQr, setRequestStatus, setRequestSuccess, type LoginRequest } from "./db/login_requests.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
chromium.use(StealthPlugin());

const HEADED = (process.env.HEADED ?? "1") === "1";
const POLL_MS = parseInt(process.env.POLL_MS ?? "8000", 10);
const QR_TTL_MS = parseInt(process.env.QR_TTL_MIN ?? "5", 10) * 60_000;
const LOGIN_COOKIES = ["wxuin", "skey", "wxsessid", "data_ticket", "uin"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function processRequest(req: LoginRequest): Promise<void> {
  console.log(`\n[req ${req.id}] guest ${req.guest_id} — opening login…`);
  const browser = await chromium.launch({ headless: !HEADED, args: ["--lang=zh-CN", "--no-sandbox"] });
  const ctx = await browser.newContext({
    locale: "zh-CN",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();
  let authData: any = null;
  page.on("response", async (res) => {
    if (!res.url().includes("auth/auth_data")) return;
    try { authData = await res.json(); } catch { /* skip */ }
  });

  try {
    await page.goto("https://channels.weixin.qq.com/login", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("iframe.display").first().waitFor({ timeout: 20_000 }).catch(() => {});

    const deadline = Date.now() + QR_TTL_MS;
    let loggedIn = false;
    while (Date.now() < deadline) {
      // (re)capture the QR card and push it to the request row
      const box = await page.locator("iframe.display").first().boundingBox().catch(() => null);
      if (box) {
        const buf = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
        await updateQr(req.id, `data:image/png;base64,${buf.toString("base64")}`);
      }
      // logged in?
      const url = page.url();
      const cookies = await ctx.cookies();
      const hasLogin = cookies.some((c) => LOGIN_COOKIES.includes(c.name));
      if (hasLogin || (!url.includes("/login") && url.includes("channels.weixin"))) { loggedIn = true; break; }
      await sleep(POLL_MS);
    }

    if (!loggedIn) {
      console.log(`[req ${req.id}] QR expired without scan.`);
      await setRequestStatus(req.id, "expired");
      return;
    }

    console.log(`[req ${req.id}] logged in — reading account…`);
    await page.goto("https://channels.weixin.qq.com/platform", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    for (let i = 0; i < 20 && !authData; i++) await sleep(1_000);

    const acct = parseWechatAccount(authData);
    if (!acct || !acct.uniq_id) {
      await setRequestStatus(req.id, "failed", "登录成功但未读到账号信息(auth_data)");
      return;
    }

    const accountId = await upsertWechatAccount(req.guest_id, acct.uniq_id, acct.nickname, "https://channels.weixin.qq.com/platform");
    await writeAccountSnapshot(accountId, { follower_count: acct.fans_count, total_likes: null, post_count: acct.feeds_count });
    await saveSession(accountId, await ctx.storageState());
    await setRequestSuccess(req.id, accountId);
    console.log(`[req ${req.id}] ✓ bound ${acct.nickname} (粉丝 ${acct.fans_count}, 作品 ${acct.feeds_count})`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[req ${req.id}] failed: ${msg}`);
    await setRequestStatus(req.id, "failed", msg);
  } finally {
    await browser.close();
  }
}

async function loop(): Promise<void> {
  console.log(`wechat login worker started — headed=${HEADED}, qr ttl ${QR_TTL_MS / 60000}min`);
  for (;;) {
    try {
      const req = await claimPendingRequest();
      if (!req) { await sleep(POLL_MS); continue; }
      await processRequest(req);
    } catch (e) {
      console.error("worker loop error:", e);
      await sleep(POLL_MS);
    }
  }
}

loop();
