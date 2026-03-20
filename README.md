# DYCrawler

Douyin search crawler for discovering trending videos by keyword. Outputs ranked results to console with trend and opportunity scores.

**Not for Vercel.** Runs locally or on a VPS. Results are written to Supabase; the Next.js app reads from there.

---

## Setup

```bash
npm install
npx playwright install chromium
```

---

## Login (required once, and every ~2 weeks)

Douyin requires a logged-in session for news/geo keywords (e.g. 洛杉矶) and to avoid bot detection generally. Run this once to save your session:

```bash
LOGIN=1 HEADED=1 node --loader ts-node/esm src/crawl.ts
```

A browser window opens. Log into your Douyin account. The script detects login automatically and saves the session to `cookies.json`, then exits.

Session cookies expire in ~13 days. Re-run the login command when crawls start returning empty results.

---

## Running a crawl

```bash
# Default (keyword: 搞笑, 20 videos, headless)
node --loader ts-node/esm src/crawl.ts

# Custom keyword and count
KEYWORD="洛杉矶" MAX_VIDEOS=30 node --loader ts-node/esm src/crawl.ts

# Headed mode — required for news/geo keywords that trigger a login modal
HEADED=1 KEYWORD="洛杉矶" node --loader ts-node/esm src/crawl.ts
```

### When to use headed mode

| Keyword type | Headless works? |
|---|---|
| Entertainment (搞笑, 美食, 健身) | Yes |
| News, geography, foreign cities | No — use `HEADED=1` |
| Anything returning 0 results | Try `HEADED=1` first |

---

## Output

Results are sorted by `trend_score` descending. Each video shows:

```
#1  Video title here
    Author : @username  (12.3K followers)
    Engage : ❤ 45.2K  💬 1.2K  🔁 3.4K
    Posted : 14h ago
    Scores : trend=198,400  opportunity=3.67
    URL    : https://www.douyin.com/video/...
```

### Scoring

```
trend_score      = likes×1 + comments×3 + shares×4 + recency_boost − creator_size_penalty
opportunity_score = likes ÷ follower_count
```

- **trend_score** — overall momentum. Weighted toward shares and comments over raw likes.
- **opportunity_score** — likes relative to follower count. High values = breakout content from small accounts. This is the primary signal for finding underrated creators.
- **recency_boost** — decays to zero over 72 hours.
- **creator_size_penalty** — deducts points for accounts over 100K followers (we want small creators).

---

## How often to run

Douyin tracks IP, device fingerprint (`webid`), session, and request patterns. There are no published rate limits, but based on observed behavior:

| Frequency | Risk |
|---|---|
| A few times per day | Low — looks like normal human usage |
| Every 30 minutes | Low-medium — fine for a handful of keywords |
| Every 5–10 minutes | Medium — gets suspicious |
| Continuous | High — expect session bans |

**Practical recommendation:** run once in the morning and once in the evening, across 5–10 keywords, with a 5–10 second pause between each keyword. That's ~200–400 API calls/day — comfortably within normal browsing behavior.

**Watch for:** `aweme_list: null` on keywords that normally return results. This is Douyin's soft-ban signal — your session may have been flagged. Re-login and wait a few hours before retrying.

---

## Architecture

The crawler is intentionally separate from the Next.js app. **Playwright cannot run on Vercel** (Chromium is ~300MB, Vercel's limit is ~50MB; headed mode is impossible without a display).

```
Vercel (Next.js)              Your machine / VPS
─────────────────             ──────────────────────────
Admin UI              ←────  Supabase (Postgres)
API routes                          ↑
Read results only             This crawler writes here
```

The crawler runs locally or on a residential VPS, writes to Supabase, and the Next.js admin board reads the results.

> A datacenter VPS (DigitalOcean, AWS, etc.) has a higher ban risk than a residential IP because Douyin fingerprints known datacenter IP ranges. Running locally is safest.

---

## Cookie portability across machines

`cookies.json` is a Playwright `storageState` file. To share a session across machines:

1. Run `LOGIN=1 HEADED=1` on one machine → generates `cookies.json`
2. Copy `cookies.json` to the other machine (or store it in Supabase as a config row)
3. Future crawls on that machine pick it up automatically

For a multi-machine setup, store cookies as a JSON blob in a `crawler_config` Supabase table (key: `douyin_session`) and have the crawler load/save from there instead of the filesystem.

---

## Files

```
src/
  crawl.ts      — main crawler (intercepts Douyin's search API responses)
  scorer.ts     — trend/opportunity scoring logic + console output formatter
  debug.ts      — dumps all network JSON responses, useful for inspecting API changes
cookies.json    — saved Playwright session (gitignored)
```

---

## Troubleshooting

**0 videos returned (headless)**
→ Run with `HEADED=1` and check for a CAPTCHA or login modal.

**0 videos returned (headed, logged in)**
→ Session may be expired or soft-banned. Re-login with `LOGIN=1 HEADED=1`.

**Login modal keeps reappearing after dismiss**
→ The search API already fired and returned null before the modal was closed. The crawler re-triggers the search automatically — if it still fails, use `HEADED=1` so you can interact manually.

**Session expired before 13 days**
→ Douyin may have flagged the session for unusual activity. Re-login and reduce crawl frequency.
