# Competitor Radar

Standalone competitor & brand intelligence service for **Akij iBOS**.
Separate project, separate Postgres database (`competitor_radar`).

| # | Feature | What it does |
|---|---|---|
| 1 | **Ad Intelligence** | Collects competitor ads from **Meta Ad Library** and **Google Ads Transparency**; stores every ad (library id, copy, CTA, format, started date, active/stopped) plus the **creative image/video** locally. |
| 2 | **Data Sources** | Watches **Facebook, LinkedIn, X, Reddit, Quora**, plus competitor **websites, pricing pages, blogs, YouTube** — snapshots + change detection. |
| 3 | **Brand Monitoring** | Tracks mentions of **Akij iBOS / iBOS / TrackForce / PeopleDesk / Managerium / PrimeVAT / Travilo / Turbo Guard** across social + review sources; scores sentiment and **notifies on negative** (real-time email/Teams/WhatsApp). |
| 4 | **Competitor Analysis** | Detects new products, features and market activity via page diffs + **AI classification** (objective, audience, pain point, angle, CTA, funnel, threat, recommended response). |

## First-time setup

Secrets and local data are not in this repository. Before the first run:

1. Copy `data/config.example.json` to `data/config.json` and fill in the
   Postgres connection, the SMTP account and the report recipients (or set
   them later on the dashboard's Config tab).
2. Set `chrome.userDataDir` to a local Chrome profile folder (for example
   `radar-chrome/`) and sign in once from the dashboard.
3. To use the knowledge base, set `kb.token`; it is cloned into `data/kb/` on
   the first analysis run.

`node_modules/`, `.venv/`, `radar-chrome/`, `data/kb/`, `data/config.json`,
`.env` and runtime output (`data/creatives/`, `logs/`, reports) are ignored by git.

## Quick start

```bash
npm start              # everything: installs on first run, applies the schema,
                       # arms the daily schedule, serves the dashboard
```

Then open http://127.0.0.1:7070. On Windows, double-clicking `start-radar.cmd`
does the same thing.

That one command is all you need day to day. The CLI is still there for one-off
jobs:

```bash
node cli.js seed       # seed competitor + brand sources
node cli.js scan       # scan all sources (once)
node cli.js report     # build + email today's report
node cli.js schema     # create/upgrade tables by hand
```

Requires `ffmpeg` and a Python with Chrome access for the headless fetcher
(`scripts/fbfetch.py`); set `RADAR_PYTHON` to point at a specific Python.

## CLI

| Command | Purpose |
|---|---|
| `schema` | Create/upgrade tables |
| `seed` | Seed all source kinds for every competitor + brand sources |
| `scan [--competitor X]` | Collect ads + snapshots, detect changes |
| `ads [--competitor X] [--platform meta\|google]` | List collected ads |
| `brand [--add "keyword"]` | Brand keywords + run a brand-mention scan |
| `mentions [--sentiment negative]` | List brand mentions |
| `analyze [--days N] [--force]` | AI-classify changes (Claude CLI) |
| `report [--days N]` | Build + email the report |
| `sources` | List monitored sources |
| `stats` | Totals + notification status |
| `run` | Full daily pipeline (scan → brand → analyze → report) |

## Scheduling

Everything runs in **one process**: `node src/ui.js` (or `npm start`, or double-click
`start-radar.cmd`). That process serves the dashboard on
http://127.0.0.1:7070 **and** holds the schedule, so a change made on the
Schedule tab takes effect immediately with no restart.

- **Schedule tab** — daily report time, time zone, on/off, overnight collection
  time, and the recipient list (one email per line). Saving re-arms the job live.
- **Run full report and send now** — runs the complete pipeline for the last day
  and emails the finished report to the saved recipients.
- **Run history** — the last 50 runs with trigger, start, finish, result and the
  tail of any error, kept in `data/run-history.json` and in the
  `radar_schedule_runs` table.

Timing is node-cron with an explicit timezone (`Asia/Dhaka` by default), so the
minute is hit exactly. node-cron does not replay a firing that was missed while
the PC was asleep or off, so a **catch-up** check runs at startup and every ten
minutes: if the daily time has passed and no successful run is recorded for
today, it runs once.

To make sure something is awake at report time, run `install-autostart.cmd`
once. It registers a Windows task that starts Radar 30 seconds after you log in.
`uninstall-autostart.cmd` removes it.

Settings live in `data/config.json` under `schedule`
(`enabled`, `dailyTime`, `scanTime`, `timezone`, `catchUp`, `autoScan`);
recipients live under `email.to` and `email.cc`. The older `scanHour` /
`reportHour` / `timezoneOffset` keys are still read as a fallback and kept in
step when you save.

## Data

Postgres **`competitor_radar`** (separate from Marketing OS):

| Table | Holds |
|---|---|
| `radar_ads` | every competitor ad + creative |
| `radar_sources` / `radar_snapshots` / `radar_changes` | watched sources, snapshots, detected changes |
| `radar_brand_keywords` / `radar_mentions` | brand keywords + mentions with sentiment |
| `radar_reports` / `radar_briefs` | generated reports + campaign briefs |
| `radar_runs` | run log |

## Config (`data/config.json`)

- `db` — Postgres connection (this project's own database).
- `brand` — brand name, products, keywords, notify on positive/negative.
- `email` / `notify` — SMTP + Teams webhook + WhatsApp Cloud API.
- `schedule` — scan/report hours (GMT+6).

## Notes

- Ads/creative capture uses headless Chrome via `scripts/fbfetch.py`; creatives are saved to `data/creatives/`.
- Google Ads Transparency exposes a **summary** (advertiser, ad count, formats) — Meta is parsed **per ad**.
- AI analysis uses the **Claude CLI** (your existing login) — no API key needed.
- `data/config.json` holds credentials — it is gitignored; never commit it.
