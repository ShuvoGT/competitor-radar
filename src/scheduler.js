'use strict'

// Orchestration: scan sources -> detect changes -> collect ads -> brand
// monitoring -> AI analysis -> daily report. Plus the daily scheduler.

const { config, q, ensureSchema } = require('./db')
const { snapshot, diffLines, scoreAndRecord, isNoiseDiff } = require('./collect')
const { collectAds } = require('./ads')
const { collectArticles } = require('./articles')
const { collectPages } = require('./pages')
const { scanBrand } = require('./brand')
const { analyzeChanges } = require('./analyze')
const { sendReport } = require('./report')
const { notify } = require('./notify')

const AD_KINDS = new Set(['meta_adlib', 'google_ads'])

async function scanSources({ competitor = null, onProgress = null } = {}) {
  const rows = (await q(`SELECT * FROM radar_sources
                        WHERE active AND competitor <> 'BRAND'
                          AND ($1::text IS NULL OR competitor = $1)
                        ORDER BY competitor, kind`, [competitor])).rows || []
  let changed = 0, errors = 0, adsNew = 0, newArticles = 0, newPosts = 0, newPages = 0
  const results = []
  // Optional progress callback so a caller (the dashboard) can show which
  // source is being worked on instead of an unexplained wait.
  const tick = (done, src) => {
    if (!onProgress) return
    try { onProgress({ done, total: rows.length, current: src ? `${src.kind} / ${src.competitor || 'brand'}` : null }) } catch {}
  }
  for (let i = 0; i < rows.length; i++) {
    const src = rows[i]
    tick(i, src)
    if (AD_KINDS.has(src.kind)) {
      const a = await collectAds(src)
      adsNew += a.newAds
      results.push({ kind: src.kind, competitor: src.competitor, ads: a.ads, newAds: a.newAds, stopped: a.stopped, error: a.error })
      if (a.newAds || a.stopped) {
        changed++
        await q(`INSERT INTO radar_changes (source_id, competitor, product, kind, severity, score, summary, diff)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [src.id, src.competitor, src.product, a.newAds ? 'new_ad' : 'stopped_ad',
           a.newAds >= 3 ? 'high' : 'medium', a.newAds >= 3 ? 70 : 50,
           `${a.newAds} new ad(s), ${a.stopped} stopped (${src.competitor})`,
           JSON.stringify({ newAds: a.newAds, stopped: a.stopped, platform: a.platform })])
      }
      continue
    }
    const s = await snapshot(src)
    if (s.error) errors++
    if (s.newPosts) newPosts += s.newPosts
    if (s.changed && s.prevText && !s.error) {
      const { added, removed } = diffLines(s.prevText, s.text)
      if ((added.length || removed.length) && !isNoiseDiff(added, removed)) {
        changed++
        await scoreAndRecord({ sourceId: src.id, competitor: src.competitor, product: src.product, added, removed, beforeText: s.prevText, afterText: s.text })
      }
    }
    const row = { kind: src.kind, competitor: src.competitor, changed: s.changed, error: s.error, newPosts: s.newPosts || 0 }
    // Read the actual published items with exact links: blog / newsletter posts
    // (WordPress REST API or RSS) and YouTube videos (channel feed).
    if (src.kind === 'blog' || src.kind === 'newsletter' || src.kind === 'youtube') {
      try {
        const art = await collectArticles(src)
        row.articles = art.total
        row.newArticles = art.created
        newArticles += art.created || 0
      } catch (e) { row.articleError = String((e && e.message) || e).slice(0, 120) }
    }
    // Website sources also get new-page detection (sitemap-based): a brand-new
    // page on the site is reported with its title + summary + link.
    if (src.kind === 'website') {
      try {
        const pg = await collectPages(src)
        row.newPages = pg.new
        row.pagesBaseline = pg.baseline
        newPages += pg.new || 0
      } catch (e) { row.pageError = String((e && e.message) || e).slice(0, 120) }
    }
    results.push(row)
    await new Promise((r) => setTimeout(r, 250))
  }
  tick(rows.length, null)
  return { ok: true, sources: rows.length, changed, errors, newAds: adsNew, newArticles, newPosts, newPages, results }
}

async function brandScan() {
  const res = await scanBrand({ notify })
  return res
}

async function analyze({ days = 14, limit = 8, force = false } = {}) {
  return analyzeChanges({ days, limit, force })
}

async function report({ days = 1 } = {}) {
  return sendReport({ days })
}

// Full daily pipeline.
async function runDaily({ days = 1 } = {}) {
  const started = await q(`INSERT INTO radar_runs (kind) VALUES ('daily') RETURNING id`)
  const runId = started.rows[0].id
  const out = {}
  try {
    out.scan = await scanSources({})
    out.brand = await brandScan()
    out.analyze = await analyze({ days: 2, limit: 10 })
    out.report = await report({ days })
    await q(`UPDATE radar_runs SET finished_at=now(), stats=$2::jsonb WHERE id=$1`, [runId, JSON.stringify(out)])
    return { ok: true, runId, ...out }
  } catch (e) {
    await q(`UPDATE radar_runs SET finished_at=now(), error=$2 WHERE id=$1`, [runId, String(e.message || e)])
    return { ok: false, runId, error: String(e.message || e) }
  }
}

// The old 5-minute setInterval poll lived here. It fired only if a tick landed
// inside the target hour, kept "did it already run today" in memory, and was
// unref'd so it could not hold the process open — which is why 9 AM was missed
// after a sleep, a reboot, or when only the dashboard was running.
// Scheduling now lives in schedule-runner.js (node-cron + timezone + catch-up).
// This wrapper stays so any existing entry point keeps working.
function startScheduler() {
  return require('./schedule-runner').startRunner()
}

module.exports = { scanSources, brandScan, analyze, report, runDaily, startScheduler, ensureSchema }
