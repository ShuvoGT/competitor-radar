# Competitor Radar → Marketing OS pipeline

Every day, after Competitor Radar emails the per-product intelligence report, it
also hands **that product's best competitor Facebook post** to **Marketing OS
(harness)**, which generates an **original, inspired-not-copied** post for the
matching brand page. Four product emails → four generation jobs, running
concurrently.

```
Competitor Radar  (daily 09:00 Asia/Dhaka)
  └─ per product:
       ├─ send the email report                (unchanged)
       └─ pickBestPost(data, {platform:'facebook'})
            ├─ build a creative brief (Claude CLI + KB, inspiration-not-copy)
            ├─ fetch the competitor creative URL (best effort)
            └─ POST /generate ─────────────►  Marketing OS jobServer (127.0.0.1:8765)
                                                 └─ createStudio.generate(...)
                                                      └─ agent renders ONE post
                                                           └─ (autoPublish) duplicate + QC gate → posts to the page
```

The "don't copy" guarantee is enforced twice: the brief explicitly forbids reusing
the competitor's words/imagery, and Marketing OS's publish gate blocks anything
that is a near-duplicate (pHash) of previously published content.

## What changed

**Marketing OS (`harness`)**
- `src/main/jobServer.js` — **new.** Localhost HTTP endpoint (127.0.0.1 only,
  token-gated) wrapping `createStudio.generate`/`list`/`publish`.
- `src/main/index.js` — starts the job server at boot.

**Competitor Radar**
- `src/report.js` — extracted the shared `byTraction` / `pickBestPost` helpers
  (the email and the trigger now pick the same post); calls the trigger after each
  product email is sent (both the normal and the `skipEmpty` paths), passing the
  report id; refreshes pending generation outcomes once per run. Fail-soft.
- `src/marketing-trigger.js` — **new.** Picks the best FB post, builds the brief,
  fetches the visual, claims an idempotent `(report id, product)` slot, POSTs one
  job per product, and records the outcome. Also `refreshOutcomes()` (polls
  `/status` for later permalinks) and `listGeneratedPosts()`.
- `config/schema.sql` — **new table** `radar_generated_posts` (one row per fired
  job; partial unique index makes the trigger idempotent).
- `cli.js` — **new** `generate` (manually trigger one product, `--dry` to preview)
  and `generated` (list outcomes, `--refresh` to poll statuses) commands.
- `src/ui.js` — the Reports tab lists Marketing OS generations and has a
  *Refresh statuses* button.
- `marketing-os.config.example.json` — **new.** The config block to paste in.

No existing behaviour changes when the feature is off (the default).

## Setup

1. **Start Marketing OS once.** On boot it creates a token and prints:
   `[jobServer] listening on http://127.0.0.1:8765 — token in settings.job_server_token (abc123…)`.
   Read the full token from its SQLite DB (`data/harness.db`, `settings` table,
   key `job_server_token`).
   - Change the port with setting `job_server_port`; disable entirely with
     `job_server_enabled` = `0`.

2. **Make sure each product's brand page is added & verified** in Marketing OS
   (Publish tab). Note its page name / page id.

3. **Configure Competitor Radar.** Copy the `marketingOs` block from
   `marketing-os.config.example.json` into `data/config.json`, then:
   - set `enabled: true`
   - paste the `token`
   - fill `products` — map each product (exactly as in `radar_sources.product`) to
     its page via `pageName`, `pageId`, or `accountId`.

4. **Choose autonomy.** `autoPublish: false` (default) renders and holds each post
   in Marketing OS → Create Studio for you to review and publish. `true` posts
   automatically through the duplicate + QC gate.

5. **(Recommended) Brand fidelity + reliable visuals.**
   - In Marketing OS, set each page's brand-assets Drive folder:
     `create_assets_<accountId>` = public Google Drive folder URL (logos, colours,
     fonts, `brand.json`). This is what makes generated posts on-brand.
   - In Competitor Radar, sign the capture Chrome profile into Facebook once
     (`config.chrome.userDataDir` + the login browser) so the competitor creative
     can be fetched reliably; the trigger also auto-falls-back to ad creatives.

## Observability, safety & manual control

**Outcomes are persisted.** Every fired job records a row in
`radar_generated_posts` (report id, product, kind, page, competitor, best post,
job id, session id, status, permalink, the visual reference, the raw response).
Status starts `generating` and moves to `ready` → `posting` → `posted` (or
`failed`) as Marketing OS renders and publishes. `sendReport` polls `/status`
once per run to fold those later states back in; you can also poll on demand:

```bash
node cli.js generated              # recent generations + status
node cli.js generated --refresh    # poll Marketing OS and update rows
```

The same list is shown in the Radar dashboard's **Reports** tab (with a
*Refresh statuses* button).

**A report cannot fire twice for the same product.** Two layers: the trigger
atomically claims the `(report id, product)` pair before POSTing (partial unique
index), and — because a rebuilt report gets a *new* id — it also skips a product
that already has a live (non-failed) job inside `dedupeHours` (default 20). A
`failed` row is re-claimable so a transient error can retry; manual
`cli.js generate` bypasses the guard on purpose.

**Manual trigger** — generate one product on demand, without sending an email:

```bash
node cli.js generate --product "TrackForce"          # render (honours autoPublish)
node cli.js generate --product "TrackForce" --dry    # build the brief only, no POST
node cli.js generate --product "TrackForce" --kind static
```

**Captions.** The caption the brief produces is what gets posted — `createStudio`
stores it at generate time and passes it to `publish_gate.py`. If the brief
produced none, the trigger supplies a minimal on-brand fallback and Marketing OS
has a second fallback, so the gate never posts an empty caption.

## Test end to end

```bash
# 1) Marketing OS reachable?
curl http://127.0.0.1:8765/health
#    → { "ok": true, "service": "marketing-os", "accounts": [ ... ] }

# 2) One generation by hand (replace TOKEN + a real page name):
curl -X POST http://127.0.0.1:8765/generate \
  -H "Content-Type: application/json" -H "x-radar-key: TOKEN" \
  -d '{"kind":"static","prompt":"Test: original on-brand static for TrackForce.","pageName":"TrackForce","autoPublish":false}'
#    → { "ok": true, "id": "c...", "sessionId": 123, ... }   (watch it in Create Studio)

# 3) Dry-run the trigger for one product (builds the brief, no POST):
node cli.js generate --product "TrackForce" --dry
#    → { ok: true, preview: true, kind, page, competitor, bestPost, prompt, caption }

# 4) Full pipeline for one product (sends the email AND triggers generation):
node cli.js report --product "TrackForce"     # or `node cli.js report` for all

# 5) See what fired and poll its status:
node cli.js generated --refresh
```

> Marketing OS must be **restarted** after `jobServer.js` is added/changed —
> the server starts at boot (`src/main/index.js`). A running instance started
> before the code landed will not answer `/health`.

Each product's report result now carries a `marketing` field showing what the
trigger did (`ok`, chosen `kind`, `page`, `competitor`, `bestPost`, the created
job `id`, or a `skipped`/`error` reason) — handy for debugging without opening
Marketing OS.

## Ad-inspired briefs (Ads tab)

Separate from the social-post pipeline, Radar can turn competitors' **ads** into
original content ideas for each of OUR products — captions, ad copy + headlines,
and visual direction. It is **text only**: nothing is rendered or posted.

- **Run it:** Ads tab → **✨ Content ideas from best ads**, or
  `node cli.js ads-brief [--product "Travilo"] [--days 120] [--top 5] [--dry]`.
- **Ranking:** per product, competitor ads are scored by still-active + days
  running (the Ad Library performance proxy) + a fetchable creative + copy + an
  offer + video. Briefs are stored in `radar_ad_briefs` and listed in the Ads tab
  (View opens the full brief).
- **LLM:** written by the Claude CLI, grounded in the KB (`src/ads-brief.js`). If
  the CLI is unavailable, a **data-only fallback** brief is returned instead of
  failing.
- **Data caveat:** real longevity needs **Meta Ad Library** capture (it exposes
  "Started running" + the ad copy). Google Ads Transparency exposes neither, so
  those rank on active / first-seen only. `started_running` is now captured and
  persisted on later scans (previously it was never updated after insert).

## Notes & limits

- **Best post = best Facebook post** by real engagement (reactions+comments+shares),
  significance score as tiebreak. Set `anyPlatform: true` to fall back to the best
  post on any platform when there's no FB post that day.
- **Visual reference** (improved). The trigger now: (1) renders the post permalink
  and **downloads** its creative to a stable local file under
  `work/marketing-refs/` (fbcdn URLs expire, so a local file is handed over, not a
  link); (2) if the social post has no fetchable media, **falls back to a recent
  ad creative** for the same competitor/product from `radar_ads`
  (`creative_path` / `creative_url` — a real downloadable asset); (3) if both fail,
  proceeds text-only. It's always given to the agent as *inspiration only* — never
  as an "exact asset" to reproduce. Signing the capture Chrome profile into
  Facebook (`config.chrome.userDataDir`) makes step 1 far more reliable.
- **Brand assets in Create Studio** (fixed). Create Studio now injects a **brand
  block** (names the page, sets `{{brand}}`) and, when configured, a **brand-assets
  block** that fetches the real logo/colours/fonts for that page from a Google
  Drive folder. Set it per page in Marketing OS settings: key
  `create_assets_<accountId>` = the brand's public Drive folder URL (or a global
  `create_assets` for all). Without it, generation falls back to the skill + KB as
  before. You can still also point a product's `skill` at a brand-aware skill.
- **autoPublish runs QC.** When a job is queued for auto-publish, Marketing OS
  generation records the asset and runs the `creative-qc-approver` rubric
  (`runQc`), because the publish gate requires a recorded `pass` verdict. The
  gate then re-checks duplicates + QC before posting. With `autoPublish: false`
  (default) the post renders and waits in Create Studio for review. Without the
  QC step the gate blocks with `qc_not_passed`, so it is always requested
  alongside auto-publish.
- **Concurrency.** Each POST returns as soon as the job starts, so four products
  fan out to four concurrent Marketing OS sessions (capped by the runner). Because
  Create Studio shares one `renders/` folder, every run is tagged with a unique
  per-run token and its render file must contain that token, so concurrent runs
  can never be mistaken for each other (a batch of products is safe to run).
```
