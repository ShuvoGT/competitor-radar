-- Competitor Radar — schema (PostgreSQL)
-- Standalone project: ad intelligence, social/web sources, brand monitoring,
-- competitor analysis, reports and briefs.

-- 1. Ad Intelligence -------------------------------------------------------
-- Every competitor ad seen on Meta Ad Library / Google Ads Transparency.
CREATE TABLE IF NOT EXISTS radar_ads (
  id             BIGSERIAL PRIMARY KEY,
  platform       TEXT NOT NULL,          -- meta | google
  competitor     TEXT,
  product        TEXT,
  ad_key         TEXT NOT NULL,          -- library id / ad id
  page_name      TEXT,
  copy           TEXT,
  headline       TEXT,
  cta            TEXT,
  offer          TEXT,
  landing_url    TEXT,
  creative_url   TEXT,
  creative_path  TEXT,
  format         TEXT,                   -- image | video | carousel | text
  started_running DATE,
  active         BOOLEAN,
  baseline       BOOLEAN NOT NULL DEFAULT false,  -- true = was already running at first scan
  first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw            JSONB,
  UNIQUE (platform, ad_key)
);
-- Migration for databases created before the baseline column existed.
ALTER TABLE radar_ads ADD COLUMN IF NOT EXISTS baseline BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_ads_comp ON radar_ads (competitor, first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_ads_platform ON radar_ads (platform, active);

-- 2. Sources + snapshots (websites, social, blogs, review sites) ------------
CREATE TABLE IF NOT EXISTS radar_sources (
  id            BIGSERIAL PRIMARY KEY,
  competitor    TEXT,                    -- competitor name, or 'BRAND' for our own brand
  product       TEXT,
  kind          TEXT NOT NULL,           -- website | pricing | blog | facebook | linkedin | x | reddit | quora | youtube | review | adlib | google_ads
  url           TEXT NOT NULL,
  render        BOOLEAN DEFAULT false,   -- needs headless browser
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (url)
);
CREATE INDEX IF NOT EXISTS idx_src_comp ON radar_sources (competitor);

CREATE TABLE IF NOT EXISTS radar_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  source_id     BIGINT NOT NULL REFERENCES radar_sources(id) ON DELETE CASCADE,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT,
  http_status   INTEGER,
  text          TEXT,
  content_hash  TEXT,
  raw           JSONB,
  screenshot    TEXT,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_snap_src ON radar_snapshots (source_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS radar_changes (
  id            BIGSERIAL PRIMARY KEY,
  source_id     BIGINT REFERENCES radar_sources(id) ON DELETE CASCADE,
  competitor    TEXT,
  product       TEXT,
  kind          TEXT,                    -- text | pricing | cta | new_ad | stopped_ad | new_product | feature | activity
  severity      TEXT,                    -- critical | high | medium | low
  score         INTEGER,
  summary       TEXT,
  recommended   TEXT,
  before_text   TEXT,
  after_text    TEXT,
  diff          JSONB,
  analysis      JSONB,
  alerted       BOOLEAN NOT NULL DEFAULT false,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chg_comp ON radar_changes (competitor, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_chg_sev ON radar_changes (severity, detected_at DESC);

-- 3. Brand monitoring -------------------------------------------------------
CREATE TABLE IF NOT EXISTS radar_brand_keywords (
  id            BIGSERIAL PRIMARY KEY,
  keyword       TEXT NOT NULL UNIQUE,    -- e.g. "Akij iBOS", "iBOS", "TrackForce"
  product       TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS radar_mentions (
  id            BIGSERIAL PRIMARY KEY,
  source_id     BIGINT REFERENCES radar_sources(id) ON DELETE SET NULL,
  platform      TEXT,
  keyword       TEXT,
  url           TEXT,
  title         TEXT,
  text          TEXT,
  author        TEXT,
  sentiment     TEXT,                    -- positive | neutral | negative
  sentiment_score REAL,
  is_customer   BOOLEAN DEFAULT false,   -- feedback / review / complaint
  analysis      JSONB,
  notified      BOOLEAN NOT NULL DEFAULT false,
  found_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (url, keyword)
);
CREATE INDEX IF NOT EXISTS idx_men_sent ON radar_mentions (sentiment, found_at DESC);
CREATE INDEX IF NOT EXISTS idx_men_kw ON radar_mentions (keyword, found_at DESC);

-- 4. Reports + briefs -------------------------------------------------------
CREATE TABLE IF NOT EXISTS radar_reports (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT DEFAULT 'daily',
  period_start  DATE,
  period_end    DATE,
  body_md       TEXT,
  html          TEXT,
  summary       JSONB,
  data          JSONB,
  sent          BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS radar_briefs (
  id            BIGSERIAL PRIMARY KEY,
  product       TEXT,
  competitor    TEXT,
  title         TEXT,
  brief_md      TEXT,
  angle         TEXT,
  audience      TEXT,
  status        TEXT DEFAULT 'new',
  source_change BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS radar_runs (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  stats         JSONB,
  error         TEXT
);

-- 5. Scheduled runs ---------------------------------------------------------
-- Every scheduled, catch-up or manual run of the daily pipeline. Mirrored to
-- data/run-history.json so a run that failed because Postgres was unreachable
-- is still recorded somewhere.
CREATE TABLE IF NOT EXISTS radar_schedule_runs (
  id            BIGSERIAL PRIMARY KEY,
  trigger       TEXT NOT NULL,           -- schedule | catchup | manual | scan
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  local_date    DATE,                    -- the date in the configured timezone
  status        TEXT NOT NULL DEFAULT 'running',  -- running | ok | fail
  message       TEXT,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sched_runs ON radar_schedule_runs (local_date DESC, started_at DESC);

-- 5b. Competitor blog / newsletter posts ------------------------------------
-- Actual published posts (title, link, date) read from a site's WordPress REST
-- API or RSS feed, so the report can list what was published today / yesterday.
CREATE TABLE IF NOT EXISTS radar_articles (
  id            BIGSERIAL PRIMARY KEY,
  source_id     BIGINT REFERENCES radar_sources(id) ON DELETE CASCADE,
  competitor    TEXT,
  kind          TEXT,                    -- blog | newsletter
  title         TEXT,
  url           TEXT,
  published     TIMESTAMPTZ,             -- real publish date from the feed/API
  summary       TEXT,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (competitor, url)
);
CREATE INDEX IF NOT EXISTS idx_articles_comp ON radar_articles (competitor, published DESC);

-- 5c. Competitor social posts (exact permalinks) ----------------------------
-- Individual posts read from the RENDERED social page (signed-in capture
-- browser), each with its own permalink and — where the platform exposes them —
-- reaction / comment / share counts. This is what lets the report link to the
-- exact post and pick the one with the most traction, instead of only diffing
-- the page text. Facebook today; other platforms as capture is added.
CREATE TABLE IF NOT EXISTS radar_social_posts (
  id            BIGSERIAL PRIMARY KEY,
  source_id     BIGINT REFERENCES radar_sources(id) ON DELETE CASCADE,
  competitor    TEXT,
  platform      TEXT,                    -- facebook | ...
  url           TEXT,                    -- exact post permalink
  text          TEXT,
  posted_at     TIMESTAMPTZ,             -- best-effort real post time (from the page)
  reactions     INTEGER,
  comments      INTEGER,
  shares        INTEGER,
  engagement    INTEGER,                 -- reactions+comments+shares, for ranking
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (competitor, url)
);
CREATE INDEX IF NOT EXISTS idx_social_posts_comp ON radar_social_posts (competitor, engagement DESC);
CREATE INDEX IF NOT EXISTS idx_social_posts_seen ON radar_social_posts (platform, first_seen DESC);

-- 5d. Competitor website pages (new-page detection) -------------------------
-- Every page a competitor's website publishes, discovered from its sitemap. The
-- first scan records all current pages as a baseline (baseline = true, never
-- reported). After that, any page NOT in the baseline is a brand-new page and is
-- reported with its title + summary + link.
CREATE TABLE IF NOT EXISTS radar_pages (
  id            BIGSERIAL PRIMARY KEY,
  source_id     BIGINT REFERENCES radar_sources(id) ON DELETE CASCADE,
  competitor    TEXT,
  url           TEXT,
  title         TEXT,
  summary       TEXT,
  baseline      BOOLEAN NOT NULL DEFAULT false,  -- seen on the first scan (not "new")
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (competitor, url)
);
CREATE INDEX IF NOT EXISTS idx_pages_comp ON radar_pages (competitor, first_seen DESC);

-- 6. One-time content-page render migration (idempotent) --------------------
-- Modern blog / pricing / newsletter pages are rendered with JavaScript, so a
-- plain fetch only ever saw an empty shell and no new post was detected. Switch
-- those sources to render with a real browser, and clear their stale shell-only
-- snapshots so the first real render becomes the baseline (no bogus giant diff).
-- After render flips to true these WHERE clauses match nothing, so it is safe to
-- run on every startup.
DELETE FROM radar_snapshots WHERE source_id IN (
  SELECT id FROM radar_sources WHERE kind IN ('blog','pricing','newsletter') AND render = false
);
UPDATE radar_sources SET render = true WHERE kind IN ('blog','pricing','newsletter') AND render = false;

-- 7. One-time Google Ads URL fix (idempotent) -------------------------------
-- Google Ads Transparency only LISTS ads for a DOMAIN search. The old
-- "?query=Name" URLs just opened the search box and returned nothing, so no
-- Google ads were ever collected. Re-point any query-form google_ads source to
-- the domain of that competitor's own website. After the update the URL contains
-- "domain=" not "query=", so this matches nothing on later startups.
UPDATE radar_sources g
SET url = 'https://adstransparency.google.com/?region=anywhere&domain=' ||
          regexp_replace(regexp_replace(w.url, '^https?://(www\.)?', ''), '/.*$', '')
FROM radar_sources w
WHERE g.kind = 'google_ads'
  AND w.competitor = g.competitor AND w.kind = 'website'
  AND g.url LIKE '%query=%';
