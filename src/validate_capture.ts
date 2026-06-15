/**
 * validate_capture.ts — run the parsers in parse.ts against captured samples and
 * print what they extract. Pure verification; no browser, no DB.
 *
 *   node --loader ts-node/esm src/validate_capture.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  parseDouyinComments, topComments,
  parseDouyinAccount, parseDouyinPosts,
  parseWechatAccount, parseWechatPosts,
} from "./parse.js";

const ROOT = process.env.CAPTURE_DIR ?? "./capture";

// Find the first captured file in <mode> whose URL contains `needle`.
function findFile(mode: string, needle: string): any | null {
  const dir = join(ROOT, mode);
  const idxPath = join(dir, "index.tsv");
  if (!existsSync(idxPath)) { console.log(`  (no capture for ${mode})`); return null; }
  const lines = readFileSync(idxPath, "utf8").split("\n").slice(1);
  for (const ln of lines) {
    const [idx, , , url] = ln.split("\t");
    if (url && url.includes(needle)) {
      try { return JSON.parse(readFileSync(join(dir, `${idx}.json`), "utf8")); }
      catch { /* keep looking */ }
    }
  }
  console.log(`  (no '${needle}' response captured in ${mode})`);
  return null;
}

function hr(t: string) { console.log(`\n${"─".repeat(70)}\n${t}\n${"─".repeat(70)}`); }

// ── A: douyin comments ───────────────────────────────────────────────────────
hr("A · 抖音高赞评论 (comment/list)");
{
  const j = findFile("douyin_comment", "comment/list");
  if (j) {
    const all = parseDouyinComments(j);
    console.log(`parsed ${all.length} comments from this page; top by likes:`);
    for (const c of topComments(all, 10)) {
      console.log(`  #${c.rank}  ❤${c.like_count}  @${c.author_name}: ${c.text.slice(0, 50)}`);
    }
  }
}

// ── B: douyin account ────────────────────────────────────────────────────────
hr("B · 抖音账号 (user/profile/other)");
{
  const j = findFile("douyin_account", "user/profile/other");
  if (j) console.log("account:", parseDouyinAccount(j));
}
hr("B · 抖音作品 (aweme/post)");
{
  const j = findFile("douyin_account", "aweme/post");
  if (j) {
    const vids = parseDouyinPosts(j);
    console.log(`parsed ${vids.length} videos; first 3:`);
    for (const v of vids.slice(0, 3)) {
      console.log(`  ${v.video_id}  ❤${v.like_count} 💬${v.comment_count} ↗${v.share_count} play=${v.play_count}  ${v.title.slice(0, 40)}`);
    }
  }
}

// ── C: wechat account + posts ────────────────────────────────────────────────
hr("C · 视频号账号 (auth_data)");
{
  const j = findFile("wechat_assistant", "auth/auth_data");
  if (j) console.log("account:", parseWechatAccount(j));
}
hr("C · 视频号作品 (post_list) — 含播放量/完播率");
{
  const j = findFile("wechat_assistant", "post/post_list");
  if (j) {
    const vids = parseWechatPosts(j);
    console.log(`parsed ${vids.length} videos; first 5:`);
    for (const v of vids.slice(0, 5)) {
      console.log(`  read=${v.read_count} ❤${v.like_count} 💬${v.comment_count} ↗${v.share_count} 完播=${v.full_play_rate}  ${v.title.slice(0, 36)}`);
    }
  }
}

console.log("\n(done)\n");
