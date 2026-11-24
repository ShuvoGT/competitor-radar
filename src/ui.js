'use strict'

// Competitor Radar — local dashboard.
// Dependency-light: Node's built-in http only (no Express, nothing to install).
//   node src/ui.js         (or: npm run ui)
// Then open http://localhost:7070
//
// Read-only views over the radar_* tables plus action buttons (scan / brand /
// analyze / report / run) and a config editor that persists to data/config.json.

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { URL } = require('node:url')

const { ROOT, config, saveConfig, q, connect, close, ensureSchema } = require('./db')
const { scanSources, brandScan, analyze, report, runDaily } = require('./scheduler')
const { listAds, adStats, deleteAd, deleteAds } = require('./ads')
const { listMentions, mentionStats, listKeywords, addKeyword, removeKeyword } = require('./brand')
const { listSources, addSource, removeSource, updateSource, seedCompetitorSources, seedBrandSources, planCompetitorSources, planBrandSources, removeCompetitor } = require('./sources')
const { suggestCompetitors } = require('./analyze')
const { launchLoginBrowser, profileBusy, checkTools, testAuthCapture, clearChromeProfile, resetEngineCache, installPlaywright } = require('./collect')
const { listReports, getReport } = require('./report')
const { status: notifyStatus } = require('./notify')
const runner = require('./schedule-runner')
const kb = require('./kb')
const { discoverSources, verifyCompetitor, verifyAndFix, verifySource } = require('./discover')

const PORT = Number(process.env.RADAR_UI_PORT || (config().ui && config().ui.port) || 7070)
const HOST = process.env.RADAR_UI_HOST || '127.0.0.1'
const CREATIVES_DIR = path.join(ROOT, 'data', 'creatives')

// ---- background jobs -------------------------------------------------------
// Authenticated-capture test: renders a few signed-in-only pages so you can
// see whether the Chrome profile is really logged in.
let chromeTest = { running: false, startedAt: null, finishedAt: null, progress: null, rows: [], error: null }

// Verified source discovery for one competitor: propose, check, then you pick.
let discovery = { running: false, competitor: null, startedAt: null, finishedAt: null, progress: null, result: null, error: null }
let recheck = { running: false, competitor: null, startedAt: null, finishedAt: null, progress: null, result: null, error: null }
// Competitor suggestion runs server-side so it survives the user changing tabs.
// id orphans a stale job so its late finish cannot revive a reset/replaced run.
let suggestion = { running: false, id: 0, startedAt: null, finishedAt: null, product: null, region: null, result: null, error: null }
let pwInstall = { running: false, startedAt: null, finishedAt: null, line: null, ok: null, error: null, log: null }

const jobs = []              // { id, name, state, startedAt, finishedAt, result, error }
const running = new Set()    // names currently running (one at a time per name)
let jobSeq = 0

const ACTIONS = {
  scan: () => scanSources({}),
  brand: () => brandScan(),
  analyze: () => analyze({ days: 3, limit: 12 }),
  report: () => report({ days: 1 }),
  // "Run daily" and the Schedule tab's Run now button share one lock in the
  // runner, so a cron firing mid-run can never send a second email.
  run: () => runner.runNow({ trigger: 'manual', mode: 'full', days: 1 }),
}

function startJob(name) {
  if (!ACTIONS[name]) return { ok: false, error: 'unknown action: ' + name }
  if (running.has(name)) return { ok: false, error: name + ' already running' }
  running.add(name)
  const job = { id: ++jobSeq, name, state: 'running', startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null }
  jobs.unshift(job)
  if (jobs.length > 40) jobs.length = 40
  Promise.resolve()
    .then(() => ACTIONS[name]())
    .then((r) => { job.state = 'done'; job.result = r })
    .catch((e) => { job.state = 'error'; job.error = String((e && e.message) || e) })
    .finally(() => { job.finishedAt = new Date().toISOString(); running.delete(name) })
  return { ok: true, job: { id: job.id, name, state: job.state } }
}

// ---- config redaction / safe merge ----------------------------------------
const MASK = '********'
const SECRET_KEYS = /pass|password|token|secret|webhook|key/i

function redact(obj) {
  if (Array.isArray(obj)) return obj.map(redact)
  if (obj && typeof obj === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEYS.test(k) && typeof v === 'string' && v) out[k] = MASK
      else out[k] = redact(v)
    }
    return out
  }
  return obj
}

// Merge an incoming (possibly redacted) patch into the current config without
// overwriting real secrets with the mask placeholder.
function mergeConfig(base, patch) {
  if (Array.isArray(patch)) return patch
  if (patch && typeof patch === 'object') {
    const out = Array.isArray(base) ? {} : { ...(base && typeof base === 'object' ? base : {}) }
    for (const [k, v] of Object.entries(patch)) {
      if (typeof v === 'string' && v === MASK) continue // keep existing secret
      if (v && typeof v === 'object') out[k] = mergeConfig(base && base[k], v)
      else out[k] = v
    }
    return out
  }
  return patch
}

// ---- data queries ----------------------------------------------------------
async function getStats() {
  const c = await q(`SELECT
    (SELECT count(*)::int FROM radar_sources WHERE active) sources,
    (SELECT count(*)::int FROM radar_sources WHERE active AND competitor <> 'BRAND') competitor_sources,
    (SELECT count(DISTINCT competitor)::int FROM radar_sources WHERE active AND competitor <> 'BRAND') competitors,
    (SELECT count(*)::int FROM radar_ads) ads,
    (SELECT count(*)::int FROM radar_ads WHERE active) active_ads,
    (SELECT count(*)::int FROM radar_ads WHERE first_seen > now() - interval '1 day') new_ads_1d,
    (SELECT count(*)::int FROM radar_changes WHERE detected_at > now() - interval '1 day') changes_1d,
    (SELECT count(*)::int FROM radar_changes WHERE detected_at > now() - interval '7 day') changes_7d,
    (SELECT count(*)::int FROM radar_changes WHERE severity IN ('critical','high') AND detected_at > now() - interval '7 day') hot_changes,
    (SELECT count(*)::int FROM radar_mentions) mentions,
    (SELECT count(*)::int FROM radar_mentions WHERE sentiment='negative') negative_mentions,
    (SELECT count(*)::int FROM radar_mentions WHERE found_at > now() - interval '1 day') mentions_1d`)
  return { ...c.rows[0], notify: notifyStatus() }
}

async function getCompetitors() {
  const r = await q(`
    SELECT s.competitor,
           max(s.product) AS product,
           count(DISTINCT s.id)::int AS sources,
           (SELECT count(*)::int FROM radar_ads a WHERE a.competitor=s.competitor AND a.active) AS active_ads,
           (SELECT count(*)::int FROM radar_changes c WHERE c.competitor=s.competitor AND c.detected_at > now() - interval '7 day') AS changes_7d,
           (SELECT coalesce(max(c.score),0)::int FROM radar_changes c WHERE c.competitor=s.competitor AND c.detected_at > now() - interval '7 day') AS max_score
    FROM radar_sources s
    WHERE s.active AND s.competitor <> 'BRAND'
    GROUP BY s.competitor
    ORDER BY max_score DESC, changes_7d DESC, s.competitor`)
  return r.rows
}

async function getChanges({ days = 7, limit = 100, severity = null, competitor = null } = {}) {
  const r = await q(`
    SELECT c.id, c.competitor, c.product, c.kind, c.severity, c.score, c.summary, c.recommended,
           c.analysis, c.before_text, c.after_text, c.diff, c.detected_at,
           s.kind AS source_kind, s.url AS source_url
    FROM radar_changes c LEFT JOIN radar_sources s ON s.id = c.source_id
    WHERE c.detected_at > now() - ($1::int * interval '1 day')
      AND ($2::text IS NULL OR c.severity = $2)
      AND ($3::text IS NULL OR c.competitor = $3)
    ORDER BY c.detected_at DESC, c.score DESC
    LIMIT $4`, [days, severity, competitor, limit])
  return r.rows
}

// ---- http helpers ----------------------------------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}
function sendText(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(body)
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (d) => { b += d; if (b.length > 2_000_000) req.destroy() })
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

// Serve a creative by basename only (no path traversal outside the folder).
function serveCreative(res, name) {
  const safe = path.basename(String(name || ''))
  const p = path.join(CREATIVES_DIR, safe)
  if (!p.startsWith(CREATIVES_DIR) || !fs.existsSync(p)) return sendText(res, 404, 'not found')
  const ext = path.extname(p).toLowerCase()
  const type = ext === '.mp4' ? 'video/mp4' : ext === '.webm' ? 'video/webm'
    : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' })
  fs.createReadStream(p).pipe(res)
}

async function handleApi(req, res, url) {
  const seg = url.pathname.replace(/^\/api\//, '').split('/')
  const p0 = seg[0]
  const qs = url.searchParams
  const days = Number(qs.get('days')) || undefined
  const limit = Number(qs.get('limit')) || undefined

  try {
    if (req.method === 'GET') {
      switch (p0) {
        case 'health': {
          let db = false, dberr = null
          try { await q('SELECT 1'); db = true } catch (e) { dberr = String(e.message || e) }
          return sendJson(res, 200, { ok: true, db, dberr, notify: notifyStatus(), port: PORT })
        }
        case 'stats': return sendJson(res, 200, await getStats())
        case 'competitors': return sendJson(res, 200, { rows: await getCompetitors() })
        case 'sources': return sendJson(res, 200, await listSources({ competitor: qs.get('competitor') || null }))
        case 'ads': {
          const st = await adStats({ days: days || 30 })
          const ads = await listAds({ competitor: qs.get('competitor') || null, platform: qs.get('platform') || null, days: days || 30, limit: limit || 100 })
          return sendJson(res, 200, { stats: st.rows, rows: ads.rows })
        }
        case 'changes': return sendJson(res, 200, { rows: await getChanges({ days: days || 7, limit: limit || 100, severity: qs.get('severity') || null, competitor: qs.get('competitor') || null }) })
        case 'mentions': {
          const st = await mentionStats({ days: days || 30 })
          const m = await listMentions({ sentiment: qs.get('sentiment') || null, days: days || 30, limit: limit || 100 })
          return sendJson(res, 200, { stats: st.rows[0], rows: m.rows })
        }
        case 'keywords': return sendJson(res, 200, await listKeywords())
        case 'reports': {
          if (seg[1]) { const r = await getReport({ id: Number(seg[1]) }); return sendJson(res, 200, r.rows[0] || null) }
          return sendJson(res, 200, await listReports({ limit: limit || 30 }))
        }
        case 'jobs': return sendJson(res, 200, { rows: jobs, running: [...running] })
        case 'competitor': {
          if (seg[1] === 'plan') {
            const competitor = qs.get('competitor') || ''
            if (!competitor.trim()) return sendJson(res, 200, { rows: [] })
            const rows = planCompetitorSources({ competitor: competitor.trim(), domain: qs.get('domain'), handles: { facebook: qs.get('facebook'), instagram: qs.get('instagram'), linkedin: qs.get('linkedin'), youtube: qs.get('youtube'), tiktok: qs.get('tiktok'), threads: qs.get('threads'), pinterest: qs.get('pinterest') } })
            return sendJson(res, 200, { rows })
          }
          return sendJson(res, 404, { ok: false, error: 'unknown endpoint' })
        }
        case 'brand': {
          if (seg[1] === 'plan') {
            const b = config().brand || {}
            return sendJson(res, 200, { rows: planBrandSources({ brand: b.name, products: b.products || [] }), brand: b.name, products: b.products || [] })
          }
          return sendJson(res, 404, { ok: false, error: 'unknown endpoint' })
        }
        case 'schedule': {
          if (seg[1] === 'runs') return sendJson(res, 200, { rows: runner.listRuns({ limit: 50 }) })
          return sendJson(res, 200, runner.getState())
        }
        case 'chrome': {
          if (seg[1] === 'install') return sendJson(res, 200, pwInstall)
          if (seg[1] === 'tools') return sendJson(res, 200, await checkTools())
          if (seg[1] === 'test') return sendJson(res, 200, { ...chromeTest, profileBusy: profileBusy(), runBusy: runner.isRunning() })
          return sendJson(res, 404, { ok: false, error: 'unknown endpoint' })
        }
        case 'discover': return sendJson(res, 200, discovery)
        case 'recheck': return sendJson(res, 200, recheck)
        case 'suggestion': return sendJson(res, 200, suggestion)
        case 'kb': return sendJson(res, 200, kb.status())
        case 'config': return sendJson(res, 200, redact(config()))
        case 'creative': return serveCreative(res, qs.get('name'))
        default: return sendJson(res, 404, { ok: false, error: 'unknown endpoint' })
      }
    }

    if (req.method === 'POST') {
      const body = await readBody(req)
      switch (p0) {
        case 'action': return sendJson(res, 200, startJob(seg[1]))
        case 'keywords': {
          if (body.remove) { await removeKeyword(Number(body.remove)); return sendJson(res, 200, { ok: true }) }
          const r = await addKeyword({ keyword: String(body.keyword || '').trim(), product: body.product || null })
          return sendJson(res, 200, r)
        }
        case 'sources': {
          if (body.remove) { await removeSource(Number(body.remove)); return sendJson(res, 200, { ok: true }) }
          if (body.update) { const r = await updateSource({ id: Number(body.update), url: body.url }); return sendJson(res, 200, r) }
          const r = await addSource({ competitor: body.competitor || null, product: body.product || null, kind: body.kind, url: body.url })
          return sendJson(res, 200, r)
        }
        case 'ads': {
          // Delete ads by hand: one by id, or every ad for a competitor/platform.
          if (body.deleteAll) {
            const r = await deleteAds({ competitor: body.competitor || null, platform: body.platform || null })
            return sendJson(res, 200, { ok: true, deleted: r.rowCount || 0 })
          }
          if (body.delete) {
            const r = await deleteAd(Number(body.delete))
            return sendJson(res, 200, { ok: true, deleted: r.rowCount || 0 })
          }
          return sendJson(res, 200, { ok: false, error: 'nothing to delete' })
        }
        case 'verify-source': {
          // Verify one source on its own; repair it in place when it is broken.
          const r = await verifySource({ id: Number(body.id), apply: body.apply !== false })
          return sendJson(res, 200, r)
        }
        case 'schedule': {
          if (seg[1] === 'run-now') {
            if (runner.isRunning()) return sendJson(res, 200, { ok: false, busy: true, error: 'a run is already in progress' })
            // Fire and forget: the run takes minutes, the page polls for the result.
            // Optional skips (from the Run-now checkboxes) make the run faster:
            // still collect sources and send the report, but leave out the brand
            // mention scrape and/or the AI analysis step.
            runner.runNow({ trigger: 'manual', mode: 'full', days: 1, skipBrand: body.skipBrand === true, skipAnalyze: body.skipAnalyze === true }).catch((e) => console.error('[radar-ui] run-now:', e.message))
            return sendJson(res, 200, { ok: true, started: true })
          }
          const r = runner.saveSchedule(body || {})
          if (!r.ok) return sendJson(res, 400, r)
          return sendJson(res, 200, { ok: true, ...runner.getState() })
        }
        case 'config': {
          const next = mergeConfig(config(), body || {})
          saveConfig(next)
          runner.applySchedule()   // hours edited here take effect without a restart
          resetEngineCache()       // re-check whether Playwright is installed
          return sendJson(res, 200, { ok: true, config: redact(next) })
        }
        case 'competitor': {
          if (body.resetSuggest) {
            // Unblock a stuck suggestion on demand. Bumping the id orphans any
            // in-flight job so its late finish cannot revive this state.
            suggestion = { running: false, id: (suggestion.id || 0) + 1, startedAt: null, finishedAt: new Date().toISOString(), product: null, region: null, result: suggestion.result, error: null }
            return sendJson(res, 200, { ok: true, reset: true })
          }
          if (seg[1] === 'suggest' || body.suggest) {
            // Run in the background and poll via GET /api/suggestion, so leaving
            // the Add tab does not cancel a suggestion in progress. A job that has
            // run over 5 minutes is treated as stale so it can never block forever.
            const startedMs = suggestion.startedAt ? Date.parse(suggestion.startedAt) : 0
            const stale = suggestion.running && startedMs && (Date.now() - startedMs > 5 * 60000)
            if (suggestion.running && !stale) return sendJson(res, 200, { ok: false, busy: true, error: 'a suggestion is already running' })
            const b = config().brand || {}
            const product = body.product || null, region = body.region || '', existing = body.existing || []
            const jobId = (suggestion.id || 0) + 1
            suggestion = { running: true, id: jobId, startedAt: new Date().toISOString(), finishedAt: null, product, region, result: null, error: null }
            suggestCompetitors({ product, brand: b.name, existing, region })
              .then((r) => { if (suggestion.id !== jobId) return; if (r && r.ok) suggestion.result = r; else suggestion.error = (r && r.error) || 'suggestion failed' })
              .catch((e) => { if (suggestion.id !== jobId) return; suggestion.error = String((e && e.message) || e) })
              .finally(() => { if (suggestion.id !== jobId) return; suggestion.running = false; suggestion.finishedAt = new Date().toISOString() })
            return sendJson(res, 200, { ok: true, started: true })
          }
          if (body.removeCompetitor) {
            const r = await removeCompetitor({ competitor: String(body.removeCompetitor), purgeAds: body.keepAds !== true })
            return sendJson(res, 200, r)
          }
          const r = await seedCompetitorSources({
            competitor: String(body.competitor || '').trim(), product: body.product || null,
            domain: body.domain || null,
            handles: { facebook: body.facebook || null, instagram: body.instagram || null, linkedin: body.linkedin || null, youtube: body.youtube || null, tiktok: body.tiktok || null, threads: body.threads || null, pinterest: body.pinterest || null },
          })
          return sendJson(res, 200, r)
        }
        case 'kb': {
          if (seg[1] === 'sync') {
            const r = await kb.sync({ force: true })
            return sendJson(res, 200, r)
          }
          return sendJson(res, 404, { ok: false, error: 'unknown endpoint' })
        }
        case 'discover': {
          if (discovery.running) return sendJson(res, 200, { ok: false, busy: true, error: 'a check is already running' })
          const competitor = String(body.competitor || '').trim()
          if (!competitor) return sendJson(res, 200, { ok: false, error: 'enter the competitor name first' })
          discovery = { running: true, competitor, startedAt: new Date().toISOString(), finishedAt: null, progress: null, result: null, error: null }
          discoverSources({
            competitor, product: body.product || null, domain: body.domain || null, region: body.region || '',
            handles: { facebook: body.facebook, instagram: body.instagram, linkedin: body.linkedin, youtube: body.youtube, tiktok: body.tiktok, threads: body.threads, pinterest: body.pinterest },
            onProgress: (p) => { discovery.progress = p },
          })
            .then((r) => { if (r.ok) discovery.result = r; else discovery.error = r.error || 'check failed' })
            .catch((e) => { discovery.error = String((e && e.message) || e) })
            .finally(() => { discovery.running = false; discovery.finishedAt = new Date().toISOString(); discovery.progress = null })
          return sendJson(res, 200, { ok: true, started: true })
        }
        case 'recheck': {
          if (recheck.running) return sendJson(res, 200, { ok: false, busy: true, error: 'a re-check is already running' })
          const competitor = String(body.competitor || '').trim()
          if (!competitor) return sendJson(res, 200, { ok: false, error: 'competitor required' })
          // apply:true repairs broken sources and adds verified missing ones
          // automatically (used when connecting from a suggestion). Default is
          // the review flow, where the user picks what to apply.
          const apply = body.apply === true
          recheck = { running: true, competitor, apply, startedAt: new Date().toISOString(), finishedAt: null, progress: null, result: null, error: null }
          const runFn = apply ? verifyAndFix : verifyCompetitor
          runFn({ competitor, product: body.product || null, onProgress: (p) => { recheck.progress = p } })
            .then((r) => { if (r.ok) recheck.result = r; else recheck.error = r.error || 're-check failed' })
            .catch((e) => { recheck.error = String((e && e.message) || e) })
            .finally(() => { recheck.running = false; recheck.finishedAt = new Date().toISOString(); recheck.progress = null })
          return sendJson(res, 200, { ok: true, started: true })
        }
        case 'fix': {
          const competitor = String(body.competitor || '').trim()
          if (!competitor) return sendJson(res, 200, { ok: false, error: 'competitor required' })
          let updated = 0, removed = 0, added = 0
          for (const u of (body.updates || [])) { const r = await updateSource({ id: Number(u.id), url: u.url }); if (r.ok) updated++ }
          for (const id of (body.removes || [])) { const r = await removeSource(Number(id)); if (r.ok) removed++ }
          for (const a of (body.adds || [])) { const r = await addSource({ competitor, product: body.product || null, kind: a.kind, url: a.url }); if (r.ok) added++ }
          return sendJson(res, 200, { ok: true, updated, removed, added })
        }
        case 'connect': {
          const competitor = String(body.competitor || '').trim()
          const rows = Array.isArray(body.rows) ? body.rows : []
          if (!competitor || !rows.length) return sendJson(res, 200, { ok: false, error: 'nothing selected to connect' })
          let added = 0
          const failed = []
          for (const r of rows) {
            if (!r || !r.kind || !r.url) continue
            const a = await addSource({ competitor, product: body.product || null, kind: r.kind, url: r.url })
            if (a.ok) added++; else failed.push(r.url)
          }
          return sendJson(res, 200, { ok: true, added, failed })
        }
        case 'chrome': {
          if (seg[1] === 'login') {
            if (runner.isRunning()) return sendJson(res, 200, { ok: false, busy: true, error: 'A report run is using that Chrome profile right now. Wait for it to finish, then open the login browser.' })
            return sendJson(res, 200, await launchLoginBrowser())
          }
          if (seg[1] === 'install') {
            if (pwInstall.running) return sendJson(res, 200, { ok: false, busy: true, error: 'the install is already running' })
            pwInstall = { running: true, startedAt: new Date().toISOString(), finishedAt: null, line: 'starting pip…', ok: null, error: null, log: null }
            installPlaywright({ onLine: (l) => { if (l) pwInstall.line = l } })
              .then((r) => { pwInstall.ok = r.ok; pwInstall.error = r.error || null; pwInstall.log = r.log || null })
              .catch((e) => { pwInstall.ok = false; pwInstall.error = String((e && e.message) || e) })
              .finally(() => { pwInstall.running = false; pwInstall.finishedAt = new Date().toISOString(); pwInstall.line = null })
            return sendJson(res, 200, { ok: true, started: true })
          }
          if (seg[1] === 'clear') {
            if (runner.isRunning()) return sendJson(res, 200, { ok: false, busy: true, error: 'A report run is using that Chrome profile right now. Wait for it to finish, then clear it.' })
            if (chromeTest.running) return sendJson(res, 200, { ok: false, busy: true, error: 'The capture test is using that profile. Wait for it to finish.' })
            return sendJson(res, 200, clearChromeProfile())
          }
          if (seg[1] === 'test') {
            if (chromeTest.running) return sendJson(res, 200, { ok: false, busy: true, error: 'the test is already running' })
            if (runner.isRunning()) return sendJson(res, 200, { ok: false, busy: true, error: 'A report run is using that Chrome profile right now. Wait for it to finish, then test.' })
            chromeTest = { running: true, startedAt: new Date().toISOString(), finishedAt: null, progress: null, rows: [], error: null }
            testAuthCapture({ onProgress: (p) => { chromeTest.progress = p } })
              .then((r) => { chromeTest.rows = r.rows || []; chromeTest.error = r.ok ? null : (r.error || 'test failed') })
              .catch((e) => { chromeTest.error = String((e && e.message) || e) })
              .finally(() => { chromeTest.running = false; chromeTest.finishedAt = new Date().toISOString(); chromeTest.progress = null })
            return sendJson(res, 200, { ok: true, started: true })
          }
          return sendJson(res, 404, { ok: false, error: 'unknown endpoint' })
        }
        case 'brand': {
          if (seg[1] === 'seed') {
            const b = config().brand || {}
            const brand = body.brand || b.name
            const products = Array.isArray(body.products) ? body.products : (b.products || [])
            const r = await seedBrandSources({ brand, products })
            let kw = 0
            for (const k of [brand, ...products].filter(Boolean)) { const a = await addKeyword({ keyword: k }); if (a.ok) kw++ }
            return sendJson(res, 200, { ...r, keywords: kw })
          }
          return sendJson(res, 404, { ok: false, error: 'unknown endpoint' })
        }
        default: return sendJson(res, 404, { ok: false, error: 'unknown endpoint' })
      }
    }

    return sendJson(res, 405, { ok: false, error: 'method not allowed' })
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
  }
}

const server = http.createServer(async (req, res) => {
  let url
  try { url = new URL(req.url, `http://${req.headers.host || HOST}`) } catch { return sendText(res, 400, 'bad request') }
  if (url.pathname === '/' || url.pathname === '/index.html') return sendText(res, 200, PAGE, 'text/html; charset=utf-8')
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url)
  return sendText(res, 404, 'not found')
})

server.listen(PORT, HOST, () => {
  console.log(`[radar-ui] dashboard on http://${HOST}:${PORT}`)
  // Bring the schema up to date (adds radar_schedule_runs on first run).
  // Non-fatal: the dashboard and the run history still work without the db.
  ensureSchema()
    .then((r) => console.log(r.ok ? '[radar-ui] schema ready' : '[radar-ui] schema not applied: ' + r.error))
    .catch((e) => console.error('[radar-ui] schema:', e.message))
  // The scheduler lives in this process. One process, one cron, one email.
  const s = runner.startRunner()
  console.log(`[radar-ui] daily report ${s.enabled ? 'at ' + s.dailyTime + ' ' + s.timezone : 'is turned off'} (${s.engine})`)
})
process.on('SIGINT', async () => { try { await close() } catch {} ; process.exit(0) })
process.on('SIGTERM', async () => { try { await close() } catch {} ; process.exit(0) })

// ---- single-page app -------------------------------------------------------
const PAGE = /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Competitor Radar</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    --blue:#1E4CCC;--blue-d:#1C2880;--green:#34A853;--orange:#FF9700;--red:#FD0000;
    --bg:#F8FAFC;--panel:#FFFFFF;--panel2:#F1F5FB;--line:#E3E9F2;--txt:#002142;--mut:#5B6B82;
    --crit:#FD0000;--high:#FF6700;--med:#8A96A8;--low:#AEB8C7;--pos:#34A853;--neg:#E23B3B;--neu:#8A96A8;
    --shadow:0 1px 2px rgba(2,33,66,.05),0 6px 18px rgba(2,33,66,.06);
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font-family:'Poppins','Segoe UI',Roboto,Arial,sans-serif;font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}
  .app{display:grid;grid-template-columns:236px 1fr;min-height:100vh}
  /* sidebar */
  .side{background:linear-gradient(180deg,var(--blue-d),var(--blue));color:#fff;padding:18px 14px;position:sticky;top:0;height:100vh;overflow:auto}
  .side .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px;padding:4px 8px 16px}
  .side .brand .logo{width:30px;height:30px;border-radius:8px;background:rgba(255,255,255,.15);display:grid;place-items:center;font-size:16px}
  .side .brand small{display:block;font-weight:400;font-size:11px;opacity:.75;letter-spacing:.3px}
  .navi{display:flex;flex-direction:column;gap:2px;margin-top:6px}
  .navi button{display:flex;align-items:center;gap:11px;width:100%;text-align:left;background:none;border:none;color:rgba(255,255,255,.82);padding:10px 12px;border-radius:9px;cursor:pointer;font:inherit;font-size:13.5px;transition:.15s}
  .navi button:hover{background:rgba(255,255,255,.10);color:#fff}
  .navi button.act{background:#fff;color:var(--blue-d);font-weight:600}
  .navi button .ic{width:18px;text-align:center;font-size:15px}
  .side .foot{margin-top:18px;padding:10px 12px;font-size:11px;opacity:.7;border-top:1px solid rgba(255,255,255,.15)}
  /* topbar + content */
  .topbar{display:flex;align-items:center;gap:12px;padding:14px 26px;background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10;flex-wrap:wrap}
  .topbar h2{margin:0;font-size:17px;font-weight:600}
  .topbar .sp{flex:1}
  .status{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--mut);background:var(--panel2);padding:5px 11px;border-radius:20px}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--low);display:inline-block}
  .dot.on{background:var(--green)} .dot.off{background:var(--red)}
  main{padding:22px 26px 70px;max-width:1280px}
  .btn{background:var(--panel);color:var(--txt);border:1px solid var(--line);border-radius:9px;padding:8px 14px;font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:.15s}
  .btn:hover{border-color:var(--blue);color:var(--blue)} .btn:disabled{opacity:.5;cursor:default}
  .btn.p{background:var(--blue);border-color:var(--blue);color:#fff} .btn.p:hover{background:var(--blue-d);color:#fff}
  .btn.g{background:var(--green);border-color:var(--green);color:#fff} .btn.g:hover{filter:brightness(.94);color:#fff}
  .btn.sm{padding:5px 10px;font-size:12px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:22px}
  .kpi{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:15px 16px;box-shadow:var(--shadow);position:relative;overflow:hidden}
  .kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--blue)}
  .kpi.k-warn::before{background:var(--orange)} .kpi.k-bad::before{background:var(--red)} .kpi.k-good::before{background:var(--green)}
  .kpi .v{font-size:26px;font-weight:700;letter-spacing:-.5px} .kpi .l{font-size:12px;color:var(--mut);margin-top:3px}
  .sec-title{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;margin:22px 0 10px}
  table{width:100%;border-collapse:separate;border-spacing:0;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:var(--shadow)}
  th,td{text-align:left;padding:11px 13px;border-bottom:1px solid var(--line);vertical-align:top;font-size:13px}
  th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px;background:var(--panel2)}
  tbody tr:hover{background:#FafcFF} tr:last-child td{border-bottom:none}
  .badge{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;color:#fff;font-weight:600}
  .b-critical{background:var(--crit)} .b-high{background:var(--high)} .b-medium{background:var(--med)} .b-low{background:var(--low)}
  .b-positive{background:var(--pos)} .b-negative{background:var(--neg)} .b-neutral{background:var(--neu)}
  .b-inference{background:#E7ECF4;color:var(--mut)} .b-confirmed{background:var(--blue)}
  .pill{display:inline-block;background:var(--panel2);border:1px solid var(--line);border-radius:20px;padding:3px 11px;margin:2px;font-size:12px;color:var(--txt)}
  .pill a{color:var(--mut)}
  .muted{color:var(--mut)} .sm{font-size:12px} .mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
  a{color:var(--blue);text-decoration:none} a:hover{text-decoration:underline}
  .creatives{display:flex;gap:6px;flex-wrap:wrap} .creatives img,.creatives video{width:76px;height:76px;object-fit:cover;border-radius:8px;border:1px solid var(--line);background:#0b1220}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:14px;box-shadow:var(--shadow)}
  .card h3{margin:0 0 4px;font-size:15px;font-weight:600}
  .filters{display:flex;gap:9px;margin-bottom:14px;flex-wrap:wrap;align-items:center}
  select,input,textarea{background:var(--panel);color:var(--txt);border:1px solid var(--line);border-radius:9px;padding:8px 11px;font:inherit;font-size:13px}
  textarea{width:100%;resize:vertical;line-height:1.5}
  .spin{display:inline-block;width:13px;height:13px;border:2px solid var(--line);border-top-color:var(--blue);border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px;margin-right:7px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .bar{height:6px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-top:9px}
  .bar>i{display:block;height:100%;background:var(--blue);width:0;transition:width .5s ease}
  select:focus,input:focus,textarea:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(30,76,204,.12)}
  .toast{position:fixed;right:18px;bottom:18px;background:var(--txt);color:#fff;border-radius:12px;padding:12px 16px;font-size:13px;z-index:50;max-width:360px;box-shadow:var(--shadow)}
  details summary{cursor:pointer;color:var(--blue);font-size:12px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px} @media(max-width:900px){.grid2{grid-template-columns:1fr}}
  label.f{display:block;font-size:12px;color:var(--mut);margin:10px 0 4px;font-weight:500} .frow{display:flex;gap:9px;align-items:center;flex-wrap:wrap}
  h3{margin:4px 0 8px;font-size:14px}
  .modal-bg{position:fixed;inset:0;background:rgba(2,33,66,.45);display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;z-index:60;overflow:auto}
  .modal-card{background:var(--panel);border:1px solid var(--line);border-radius:16px;max-width:640px;width:100%;box-shadow:0 20px 60px rgba(2,33,66,.25);overflow:hidden}
  .modal-head{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid var(--line)}
  .modal-head h3{margin:0;font-size:16px;font-weight:700} .modal-head .x{margin-left:auto;cursor:pointer;color:var(--mut);font-size:20px;line-height:1;background:none;border:none}
  .modal-body{padding:14px 20px;max-height:66vh;overflow:auto}
  .srow{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)} .srow:last-child{border:none}
  .srow .k{width:96px;font-size:12px;font-weight:600;color:var(--ink);text-transform:capitalize}
  .srow .meta{flex:1;min-width:0} .srow .meta a{font-size:12px}
  .clk{cursor:pointer;color:var(--blue)} .clk:hover{text-decoration:underline}
  #pop{position:absolute;z-index:70;width:340px;max-width:92vw;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 14px 44px rgba(2,33,66,.22);padding:12px 14px;display:none}
  #pop.on{display:block}
  #pop .prow{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px} #pop .prow .pk{width:82px;text-transform:capitalize;color:var(--ink)}
  .empty{text-align:center;color:var(--mut);padding:34px 16px;background:var(--panel);border:1px dashed var(--line);border-radius:14px}
  .empty .big{font-size:30px;margin-bottom:6px}
  .hint{font-size:12px;color:var(--mut);margin-bottom:10px}
  @media(max-width:760px){.app{grid-template-columns:1fr}.side{position:static;height:auto}.navi{flex-direction:row;flex-wrap:wrap}.side .foot{display:none}}
</style></head>
<body>
<div class="app">
  <aside class="side">
    <div class="brand"><span class="logo">📡</span><div>Competitor Radar<small>Akij iBOS intelligence</small></div></div>
    <div class="navi" id="nav"></div>
    <div class="foot" id="sidefoot">—</div>
  </aside>
  <div>
    <div class="topbar">
      <h2 id="pgtitle">Overview</h2>
      <span class="sp"></span>
      <span class="status" id="hstat"><span class="dot"></span>checking…</span>
      <button class="btn p" data-act="scan">▶ Scan now</button>
      <button class="btn" data-act="brand">Brand check</button>
      <button class="btn" data-act="analyze">Analyze</button>
      <button class="btn" data-act="report">Report</button>
      <button class="btn" data-act="run">Run daily</button>
    </div>
    <main id="main">Loading…</main>
  </div>
</div>
<div id="toast"></div>
<div id="modal"></div>
<div id="pop"></div>
<script>
const $=(s,r=document)=>r.querySelector(s); const E=(h)=>{const d=document.createElement('div');d.innerHTML=h;return d.firstElementChild}
const esc=(s)=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const fmt=(s,n=140)=>{s=String(s||'');return s.length>n?esc(s.slice(0,n))+'…':esc(s)}
const badge=(s,t)=>'<span class="badge b-'+esc(s)+'">'+esc(t||s)+'</span>'
const dt=(s)=>String(s||'').slice(0,16).replace('T',' ')
let toastT
function toast(m){const t=$('#toast');t.innerHTML='<div class="toast">'+esc(m)+'</div>';clearTimeout(toastT);toastT=setTimeout(()=>t.innerHTML='',3500)}
async function api(p,opt){const r=await fetch('/api/'+p,opt);const ct=r.headers.get('content-type')||'';return ct.includes('json')?r.json():r.text()}
function openModal(title,html){$('#modal').innerHTML='<div class="modal-bg" id="mbg"><div class="modal-card"><div class="modal-head"><h3>'+esc(title)+'</h3><button class="x" id="mx">×</button></div><div class="modal-body">'+html+'</div></div></div>'
  $('#mx').onclick=closeModal;$('#mbg').onclick=(e)=>{if(e.target.id==='mbg')closeModal()}}
function closeModal(){$('#modal').innerHTML=''}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()})
document.addEventListener('click',e=>{const el=e.target.closest('[data-srccomp]');if(el){e.preventDefault();showCompSources(el.getAttribute('data-srccomp'))}})
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-delcomp]');if(!b)return
  e.preventDefault();e.stopPropagation()
  const name=b.getAttribute('data-delcomp')
  if(!confirm('Remove '+name+' completely?\\n\\nThis deletes its sources, snapshots, detected changes and collected ads. It cannot be undone.'))return
  b.disabled=true;b.textContent='…'
  const r=await api('competitor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({removeCompetitor:name})})
  if(r.ok){toast('Removed '+name+' — '+r.sources+' sources, '+r.changes+' changes, '+r.ads+' ads');delete srcCache[name];draw()}
  else{b.disabled=false;b.textContent='Remove';toast(r.error||'Remove failed')}
})
// hover popover
const srcCache={}
async function ensureSources(name){if(srcCache[name])return srcCache[name];const d=await api('sources?competitor='+encodeURIComponent(name));srcCache[name]=d.rows||[];return srcCache[name]}
function popHtml(name,rows){if(!rows.length)return '<div style="font-weight:700">'+esc(name)+'</div><div class="muted sm">No sources connected yet.</div>'
  const c={ok:0,weak:0,error:0,never:0,ad:0};rows.forEach(s=>{const co=srcCondition(s);if(co.note==='ad source')c.ad++;else if(co.label==='ok')c.ok++;else if(co.label==='weak')c.weak++;else if(co.label==='error')c.error++;else c.never++})
  return '<div style="font-weight:700;margin-bottom:6px">'+esc(name)+' · '+rows.length+' sources</div>'+
    '<div style="margin-bottom:8px"><span class="badge b-positive">OK '+c.ok+'</span> <span class="badge b-high">Weak '+c.weak+'</span> <span class="badge b-critical">Err '+c.error+'</span> <span class="badge b-low">New '+c.never+'</span> <span class="pill">Ads '+c.ad+'</span></div>'+
    rows.map(s=>{const co=srcCondition(s);return '<div class="prow"><span class="pk">'+esc(s.kind)+'</span>'+badge(co.cls,co.label)+'<span class="muted" style="margin-left:auto">'+(s.last_at?dt(s.last_at).slice(5,16):'never')+'</span></div>'}).join('')+
    '<div class="muted sm" style="margin-top:8px">Click to open full view.</div>'}
let popHideT
function placePop(el){const p=$('#pop');const r=el.getBoundingClientRect();p.style.top=(window.scrollY+r.bottom+6)+'px';p.style.left=(window.scrollX+Math.max(8,Math.min(r.left,document.documentElement.clientWidth-352)))+'px'}
async function showPop(el,name){clearTimeout(popHideT);const p=$('#pop');placePop(el);p.classList.add('on')
  const cached=srcCache[name];p.innerHTML=cached?popHtml(name,cached):'<div style="font-weight:700">'+esc(name)+'</div><div class="muted sm">Loading…</div>'
  if(!cached){const rows=await ensureSources(name);if(p.classList.contains('on')){p.innerHTML=popHtml(name,rows);placePop(el)}}}
function hidePop(){popHideT=setTimeout(()=>$('#pop').classList.remove('on'),140)}
document.addEventListener('mouseover',e=>{const el=e.target.closest('[data-srccomp]');if(el)showPop(el,el.getAttribute('data-srccomp'))})
document.addEventListener('mouseout',e=>{const el=e.target.closest('[data-srccomp]');if(el)hidePop()})
$('#pop').addEventListener('mouseover',()=>clearTimeout(popHideT))
$('#pop').addEventListener('mouseout',hidePop)
const SRC_KINDS=['website','pricing','blog','facebook','instagram','linkedin','x','youtube','tiktok','threads','pinterest','reddit','quora','review','meta_adlib','google_ads']
async function showCompSources(name){openModal(name+' — connected sources','<div class="muted sm">Loading…</div>');await renderCompModal(name)}
async function renderCompModal(name){
  delete srcCache[name]
  const d=await api('sources?competitor='+encodeURIComponent(name));const rows=d.rows||[]
  const body=$('#modal .modal-body');if(!body)return
  const c={ok:0,weak:0,error:0,never:0,ad:0}
  rows.forEach(s=>{const co=srcCondition(s);if(co.note==='ad source')c.ad++;else if(co.label==='ok')c.ok++;else if(co.label==='weak')c.weak++;else if(co.label==='error')c.error++;else c.never++})
  const head='<div class="filters" style="margin-bottom:8px"><span class="pill">'+rows.length+' sources</span><span class="badge b-positive">OK '+c.ok+'</span> <span class="badge b-high">Weak '+c.weak+'</span> <span class="badge b-critical">Error '+c.error+'</span> <span class="badge b-low">Never '+c.never+'</span> <span class="pill">Ads '+c.ad+'</span></div>'
  const list=rows.map(s=>{const co=srcCondition(s);return '<div class="srow" data-row="'+s.id+'"><div class="k">'+esc(s.kind)+'</div>'+
    '<div class="meta"><div>'+badge(co.cls,co.label)+' <span class="muted sm">'+fmt(co.note,40)+'</span></div>'+
    '<div class="sm mono urlview"><a href="'+esc(s.url)+'" target="_blank" rel="noreferrer">'+fmt(s.url,50)+'</a></div>'+
    '<div class="sm muted">last check: '+(s.last_at?dt(s.last_at):'never')+' · '+s.snapshots+' snaps · '+s.changes+' changes</div></div>'+
    '<div style="display:flex;flex-direction:column;gap:5px"><button class="btn sm p" data-verify="'+s.id+'">Verify</button><button class="btn sm" data-edit="'+s.id+'" data-url="'+esc(s.url)+'">Edit URL</button><button class="btn sm" data-del="'+s.id+'">Remove</button></div>'+
  '</div>'}).join('')
  const addForm='<div class="card" style="margin-top:12px;box-shadow:none"><div style="font-weight:600;margin-bottom:6px;font-size:13px">Add a source</div><div class="frow"><select id="ns-kind">'+SRC_KINDS.map(k=>'<option>'+k+'</option>').join('')+'</select><input id="ns-url" placeholder="full URL" style="flex:1;min-width:160px"><button class="btn p" id="ns-add">Add</button></div></div>'
  const tools='<div class="frow" style="margin:10px 0 2px"><button class="btn p" id="cm-verify">Verify &amp; fix sources</button><button class="btn" id="cm-del" style="color:var(--red);border-color:var(--red)">Remove competitor</button><span id="cm-msg" class="muted sm"></span></div><div id="cm-out"></div>'
  body.innerHTML=head+tools+(list||'<div class="muted">No sources yet.</div>')+addForm
  // remove
  body.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{b.disabled=true;await api('sources',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({remove:Number(b.dataset.del)})});toast('Source removed');renderCompModal(name)})
  // edit
  body.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{const row=b.closest('.srow');const view=row.querySelector('.urlview')
    view.innerHTML='<div class="frow"><input class="editurl" value="'+esc(b.dataset.url)+'" style="flex:1;min-width:150px"><button class="btn p sm save">Save</button></div>'
    view.querySelector('.save').onclick=async()=>{const u=view.querySelector('.editurl').value.trim();if(!u)return;const r=await api('sources',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({update:Number(b.dataset.edit),url:u})});toast(r.ok?'URL updated (scan to refresh)':'update failed');renderCompModal(name)}})
  // ---- verify one source at a time --------------------------------------
  const VS={verified:['positive','reachable'],search:['confirmed','search'],login:['medium','login wall — reachable'],unverified:['medium','reachable, not confirmed'],fixed:['positive','fixed'],dead:['negative','not reachable'],unreachable:['negative','not reachable']}
  body.querySelectorAll('[data-verify]').forEach(b=>b.onclick=async()=>{
    const row=b.closest('.srow');const slot=row&&row.querySelector('.meta > div:first-child')
    b.disabled=true;const label=b.textContent;b.innerHTML='<span class="spin"></span>'
    let r;try{r=await api('verify-source',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:Number(b.dataset.verify)})})}catch(e){r=null}
    b.disabled=false;b.textContent=label
    if(!r||!r.ok){toast((r&&r.error)||'verify failed');return}
    const bd=VS[r.status]||['medium',r.status||'checked']
    let extra=''
    if(r.status==='fixed')extra=' <span class="muted sm">→ '+esc(fmt(r.url,44))+'</span>'
    else if(!r.reachable&&r.replacement)extra=' <span class="muted sm">fix found: '+esc(fmt(r.replacement,40))+'</span>'
    else if(!r.reachable)extra=' <span class="muted sm">'+esc(fmt(r.aiError||r.note||'no fix found',48))+'</span>'
    else if(r.note)extra=' <span class="muted sm">'+esc(fmt(r.note,48))+'</span>'
    if(slot)slot.innerHTML=badge(bd[0],bd[1])+extra
    if(r.status==='fixed'){toast('Fixed '+esc(r.kind)+' → new URL');renderCompModal(name)}
    else if(!r.reachable&&!r.replacement)toast(r.kind+': not reachable, no replacement found')
  })
  // ---- verify & fix (whole competitor) ----------------------------------
  const mmsg=(h)=>{const e=$('#cm-msg');if(e)e.innerHTML=h}
  const mout=(h)=>{const e=$('#cm-out');if(e)e.innerHTML=h}
  let rTimer
  function drawRecheck(d){
    const r=d.result;if(!r)return
    const B={verified:['positive','verified'],search:['confirmed','search'],login:['medium','login wall'],unverified:['medium','unconfirmed'],dead:['negative','not found'],unreachable:['negative','unreachable']}
    const bad=(r.existing||[]).filter(x=>x.status==='dead'||x.status==='unreachable'||x.status==='unverified')
    let html='<div class="frow" style="margin:8px 0">'+Object.keys(B).filter(k=>(r.counts||{})[k]).map(k=>'<span class="pill">'+esc(B[k][1])+' '+r.counts[k]+'</span>').join('')+'</div>'
    if(r.aiError)html+='<div class="hint" style="color:var(--red)">Claude CLI: '+esc(r.aiError)+'</div>'
    if(!bad.length&&!(r.additions||[]).length){html+='<div class="hint">Every connected source checks out and nothing is missing.</div>';mout(html);return}
    if(bad.length){
      html+='<div style="font-weight:600;font-size:13px;margin-top:8px">Problems found</div><table style="margin-top:6px"><thead><tr><th style="width:26px"></th><th>Kind</th><th>Check</th><th>Current URL</th><th>Suggested fix</th></tr></thead><tbody>'+
      bad.map((x,i)=>{const fx=(r.fixes||[]).find(f=>f.id===x.id)
        const rep=fx&&fx.replacement
        return '<tr><td><input type="checkbox" class="f-pick" data-i="'+i+'" '+(rep?'checked':'')+'></td><td class="sm">'+esc(x.kind)+'</td><td>'+badge((B[x.status]||['medium'])[0],(B[x.status]||[0,x.status])[1])+'</td>'+
        '<td class="sm mono">'+fmt(x.url,40)+'<div class="muted">'+fmt(x.note,50)+'</div></td>'+
        '<td class="sm mono">'+(rep?'<span style="color:var(--green)">'+fmt(rep,40)+'</span>':'<span class="muted">no replacement found — tick to remove it</span>')+'</td></tr>'}).join('')+'</tbody></table>'
    }
    if((r.additions||[]).length){
      html+='<div style="font-weight:600;font-size:13px;margin-top:12px">Missing, and verified as real</div><table style="margin-top:6px"><thead><tr><th style="width:26px"></th><th>Kind</th><th>URL</th><th>Evidence</th></tr></thead><tbody>'+
      r.additions.map((x,i)=>'<tr><td><input type="checkbox" class="a-pick" data-i="'+i+'" checked></td><td class="sm">'+esc(x.kind)+'</td><td class="sm mono">'+fmt(x.url,50)+'</td><td class="sm muted">'+fmt(x.note,60)+'</td></tr>').join('')+'</tbody></table>'
    }
    html+='<div class="frow" style="margin-top:10px"><button class="btn p" id="f-apply">Apply selected</button><span class="muted sm">Ticked problems are repaired where a replacement was found, and removed where none was.</span></div>'
    mout(html)
    $('#f-apply').onclick=async()=>{
      const updates=[],removes=[],adds=[]
      document.querySelectorAll('.f-pick:checked').forEach(el=>{const x=bad[Number(el.dataset.i)];const fx=(r.fixes||[]).find(f=>f.id===x.id)
        if(fx&&fx.replacement)updates.push({id:x.id,url:fx.replacement});else removes.push(x.id)})
      document.querySelectorAll('.a-pick:checked').forEach(el=>{const x=r.additions[Number(el.dataset.i)];adds.push({kind:x.kind,url:x.url})})
      if(!updates.length&&!removes.length&&!adds.length)return toast('Nothing selected')
      const rr=await api('fix',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({competitor:r.competitor,product:r.product,updates,removes,adds})})
      toast(rr.ok?('Fixed: '+rr.updated+' updated, '+rr.removed+' removed, '+rr.added+' added'):'Apply failed')
      if(rr.ok)renderCompModal(name)
    }
  }
  async function pollRecheck(){
    clearTimeout(rTimer)
    let d;try{d=await api('recheck')}catch(e){rTimer=setTimeout(pollRecheck,3000);return}
    if(!$('#cm-verify'))return
    if(d.running){const p=d.progress
      mmsg('<span class="spin"></span>'+esc((p&&p.phase)||'Working')+(p&&p.total?' — '+Math.min(p.done+1,p.total)+' of '+p.total:''))
      rTimer=setTimeout(pollRecheck,2000);return}
    $('#cm-verify').disabled=false
    if(d.error){mmsg('<b style="color:var(--red)">'+esc(d.error)+'</b>');return}
    if(d.result&&d.result.competitor===name){mmsg('checked '+(d.result.existing||[]).length+' source(s)');drawRecheck(d)}
  }
  $('#cm-verify').onclick=async()=>{
    $('#cm-verify').disabled=true;mout('');mmsg('<span class="spin"></span>starting…')
    const r=await api('recheck',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({competitor:name})})
    if(!r.ok){$('#cm-verify').disabled=false;mmsg('<b style="color:var(--red)">'+esc(r.error||'could not start')+'</b>');return}
    pollRecheck()
  }
  pollRecheck()

  // ---- remove the whole competitor --------------------------------------
  $('#cm-del').onclick=async()=>{
    if(!confirm('Remove '+name+' completely?\\n\\nThis deletes its sources, snapshots, detected changes and collected ads. It cannot be undone.'))return
    $('#cm-del').disabled=true;mmsg('<span class="spin"></span>removing…')
    const r=await api('competitor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({removeCompetitor:name})})
    if(r.ok){toast('Removed '+name+' — '+r.sources+' sources, '+r.changes+' changes, '+r.ads+' ads');closeModal();delete srcCache[name];draw()}
    else{$('#cm-del').disabled=false;mmsg('<b style="color:var(--red)">'+esc(r.error||'failed')+'</b>')}
  }

  // add
  const add=$('#ns-add');if(add)add.onclick=async()=>{const url=$('#ns-url').value.trim();if(!url)return toast('Enter a URL');const r=await api('sources',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({competitor:name,kind:$('#ns-kind').value,url})});toast(r.ok?'Source added':(r.error||'failed'));if(r.ok){$('#ns-url').value='';renderCompModal(name)}}
}

const TABS=['Overview','Competitors','Add','Ads','Changes','Mentions','Sources','Reports','Schedule','Config']
const ICON={Overview:'📊',Competitors:'🏢',Add:'➕',Ads:'📣',Changes:'🔔',Mentions:'💬',Sources:'🌐',Reports:'📄',Schedule:'⏰',Config:'⚙️'}
let tab='Overview'
function renderNav(){const n=$('#nav');n.innerHTML='';TABS.forEach(t=>{const b=E('<button><span class="ic">'+ICON[t]+'</span>'+t+'</button>');if(t===tab)b.className='act';b.onclick=()=>{tab=t;$('#pgtitle').textContent=t;draw()};n.appendChild(b)});$('#pgtitle').textContent=tab}

document.querySelectorAll('.topbar [data-act]').forEach(b=>b.onclick=async()=>{
  b.disabled=true;const r=await api('action/'+b.dataset.act,{method:'POST'});b.disabled=false
  toast(r.ok?(b.dataset.act+' started (job #'+r.job.id+')'):(r.error||'failed'));pollJobs()
})

async function refreshHealth(){try{const h=await api('health');$('#hstat').innerHTML='<span class="dot '+(h.db?'on':'off')+'"></span>DB '+(h.db?'connected':'offline')+' · email '+(h.notify.email?'on':'off');const f=$('#sidefoot');if(f)f.innerHTML='DB '+(h.db?'✓ connected':'✗ offline')+'<br>Email '+(h.notify.email?'on':'off')+' · port '+h.port}catch(e){$('#hstat').innerHTML='<span class="dot off"></span>server offline'}}
let jobTimer
let schedPoll
async function pollJobs(){const j=await api('jobs');const busy=j.running.length;if(tab==='Overview')drawJobs(j.rows);clearTimeout(jobTimer);if(busy)jobTimer=setTimeout(pollJobs,2000)}
function drawJobs(rows){const el=$('#jobs');if(!el)return;el.innerHTML=rows.length?rows.map(j=>'<span class="pill">#'+j.id+' '+esc(j.name)+' · '+esc(j.state)+(j.error?' · '+fmt(j.error,60):'')+'</span>').join(''):'<span class="muted sm">no jobs yet</span>'}

async function draw(){clearTimeout(schedPoll);renderNav();const m=$('#main');m.innerHTML='Loading…';try{await VIEWS[tab](m)}catch(e){m.innerHTML='<div class="card">Error: '+esc(e.message||e)+'</div>'}}

const VIEWS={
  async Overview(m){
    const s=await api('stats')
    const k=(v,l)=>'<div class="kpi"><div class="v">'+v+'</div><div class="l">'+l+'</div></div>'
    m.innerHTML='<div class="kpis">'+
      k(s.competitors,'Competitors')+k(s.sources,'Active sources')+k(s.active_ads,'Active ads')+
      k(s.new_ads_1d,'New ads (24h)')+k(s.changes_1d,'Changes (24h)')+k(s.hot_changes,'Hot changes (7d)')+
      k(s.mentions_1d,'Mentions (24h)')+k(s.negative_mentions,'Negative mentions')+
    '</div><h3>Recent jobs</h3><div id="jobs" class="card"></div>'+
    '<h3>Top competitors (7d)</h3><div id="ovcomp"></div>'
    const c=await api('competitors');const rows=c.rows.slice(0,8)
    $('#ovcomp').innerHTML=tableComp(rows)
    pollJobs()
  },
  async Competitors(m){const c=await api('competitors');m.innerHTML=tableComp(c.rows,{del:true})},
  async Ads(m){
    m.innerHTML='<div class="filters"><select id="af-plat"><option value="">all platforms</option><option>meta</option><option>google</option></select><input id="af-comp" placeholder="competitor…"><button class="btn" id="af-go">Filter</button></div><div id="ads"></div>'
    const load=async()=>{const plat=$('#af-plat').value,comp=$('#af-comp').value.trim()
      const d=await api('ads?days=60&limit=120'+(plat?'&platform='+plat:'')+(comp?'&competitor='+encodeURIComponent(comp):''))
      $('#ads').innerHTML='<div class="filters">'+d.stats.map(x=>'<span class="pill">'+esc(x.platform)+' · '+esc(x.competitor||'—')+' · '+x.active+'/'+x.ads+' active · '+x.new_ads+' new</span>').join('')+'<button class="btn sm" id="ad-delall" style="color:var(--red);border-color:var(--red)">🗑 Delete all shown</button></div>'+tableAds(d.rows)
      $('#ads').querySelectorAll('button[data-delad]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this ad?'))return;const r=await api('ads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({delete:Number(b.dataset.delad)})});toast(r.ok?'Ad deleted':'Delete failed');if(r.ok)load()})
      const da=$('#ad-delall');if(da)da.onclick=async()=>{const p=$('#af-plat').value,c=$('#af-comp').value.trim();const scope=(c?('for '+c):'for ALL competitors')+(p?(' on '+p):'');if(!confirm('Delete every ad '+scope+'? This cannot be undone.'))return;const r=await api('ads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deleteAll:true,competitor:c||null,platform:p||null})});toast(r.ok?('Deleted '+r.deleted+' ad(s)'):'Delete failed');if(r.ok)load()}}
    $('#af-go').onclick=load;await load()
  },
  async Changes(m){
    m.innerHTML='<div class="filters"><select id="cf-sev"><option value="">all severity</option><option>critical</option><option>high</option><option>medium</option><option>low</option></select><select id="cf-days"><option value="7">7 days</option><option value="30">30 days</option><option value="1">24h</option></select><button class="btn" id="cf-go">Filter</button></div><div id="chg"></div>'
    const load=async()=>{const sev=$('#cf-sev').value,days=$('#cf-days').value
      const d=await api('changes?limit=120&days='+days+(sev?'&severity='+sev:''));$('#chg').innerHTML=tableChanges(d.rows)}
    $('#cf-go').onclick=load;await load()
  },
  async Mentions(m){
    m.innerHTML='<div class="filters"><select id="mf-sent"><option value="">all sentiment</option><option>negative</option><option>positive</option><option>neutral</option></select><button class="btn" id="mf-go">Filter</button></div><div id="men"></div>'
    const load=async()=>{const sent=$('#mf-sent').value;const d=await api('mentions?days=60&limit=150'+(sent?'&sentiment='+sent:''))
      const s=d.stats||{};$('#men').innerHTML='<div class="filters"><span class="pill">total '+(s.total||0)+'</span><span class="pill">pos '+(s.positive||0)+'</span><span class="pill">neg '+(s.negative||0)+'</span><span class="pill">neu '+(s.neutral||0)+'</span><span class="pill">customer '+(s.customer||0)+'</span></div>'+tableMentions(d.rows)}
    $('#mf-go').onclick=load;await load()
  },
  async Sources(m){const d=await api('sources');m.innerHTML=sourceSummary(d.rows)+tableSources(d.rows)},
  async Add(m){await drawAdd(m)},
  async Reports(m){
    const d=await api('reports');m.innerHTML='<div class="grid2"><div id="rlist"></div><div id="rview" class="card muted">Select a report to preview.</div></div>'
    $('#rlist').innerHTML='<table><thead><tr><th>ID</th><th>Kind</th><th>Period</th><th>Sent</th></tr></thead><tbody>'+
      d.rows.map(r=>'<tr><td><a href="#" data-r="'+r.id+'">#'+r.id+'</a></td><td>'+esc(r.kind)+'</td><td class="sm">'+esc(r.period_start)+'→'+esc(r.period_end)+'</td><td>'+(r.sent?'✓':'—')+'</td></tr>').join('')+'</tbody></table>'
    $('#rlist').querySelectorAll('a[data-r]').forEach(a=>a.onclick=async(e)=>{e.preventDefault();const r=await api('reports/'+a.dataset.r);$('#rview').classList.remove('muted');$('#rview').innerHTML=r&&r.html?r.html:'<span class="muted">no HTML body</span>'})
  },
  async Schedule(m){await drawSchedule(m)},
  async Config(m){await drawConfig(m)},
}

function emptyState(icon,msg,hint){return '<div class="empty"><div class="big">'+icon+'</div><div>'+esc(msg)+'</div>'+(hint?'<div class="hint" style="margin-top:6px">'+esc(hint)+'</div>':'')+'</div>'}
function tableComp(rows,opt){if(!rows.length)return emptyState('🏢','No competitors tracked yet','Go to the Add tab to add competitors and their data sources.')
  const del=opt&&opt.del
  return '<div class="hint">Click a competitor or its Sources count to see each connected source and its status.</div><table><thead><tr><th>Competitor</th><th>Product</th><th>Sources</th><th>Active ads</th><th>Changes 7d</th><th>Max score</th>'+(del?'<th></th>':'')+'</tr></thead><tbody>'+
  rows.map(c=>'<tr><td><b class="clk" data-srccomp="'+esc(c.competitor)+'">'+esc(c.competitor)+'</b></td><td class="muted">'+esc(c.product||'—')+'</td><td><span class="clk" data-srccomp="'+esc(c.competitor)+'">'+c.sources+' ›</span></td><td>'+c.active_ads+'</td><td>'+c.changes_7d+'</td><td>'+c.max_score+'</td>'+
    (del?'<td><button class="btn sm" data-delcomp="'+esc(c.competitor)+'" style="color:var(--red);border-color:var(--red)">Remove</button></td>':'')+'</tr>').join('')+'</tbody></table>'}

function creativeTag(a){const p=a.creative_path?a.creative_path.split(/[\\\\/]/).pop():'';if(!p)return '';const isV=/\\.(mp4|webm|mov|m4v)$/i.test(p);const u='/api/creative?name='+encodeURIComponent(p);return isV?'<video src="'+u+'" muted></video>':'<img src="'+u+'" loading="lazy" onerror="this.style.display=\\'none\\'">'}
function tableAds(rows){if(!rows.length)return emptyState('📣','No ads collected yet','Run a Scan once Meta Ad Library / Google Ads sources are added.');return '<table><thead><tr><th>Platform</th><th>Competitor</th><th>Status</th><th>Creative</th><th>Copy / CTA</th><th>Started</th><th></th></tr></thead><tbody>'+
  rows.map(a=>'<tr><td>'+esc(a.platform)+'</td><td><b>'+esc(a.competitor||'—')+'</b></td><td>'+(a.active?badge('positive','active'):badge('neutral','stopped'))+'</td><td><div class="creatives">'+creativeTag(a)+'</div></td><td>'+fmt(a.copy,180)+(a.cta?'<div class="pill">'+esc(a.cta)+'</div>':'')+'</td><td class="sm muted">'+(a.started_running?String(a.started_running).slice(0,10):'—')+'</td><td><button class="btn sm" data-delad="'+a.id+'" title="Delete this ad" style="color:var(--red);border-color:var(--red)">✕</button></td></tr>').join('')+'</tbody></table>'}

function anaBadges(an){if(!an)return '';const b=[];if(an.basis)b.push(badge(an.basis));if(an.content_angle)b.push('<span class="pill">'+esc(an.content_angle)+'</span>');if(an.funnel_stage)b.push('<span class="pill">'+esc(an.funnel_stage)+'</span>');if(an.cta&&an.cta!=='none')b.push('<span class="pill">CTA: '+esc(an.cta)+'</span>');return b.join(' ')}
function isRawSummary(s){return /^\\s*\\d+\\s*added\\s*\\/\\s*\\d+\\s*removed/i.test(String(s||''))||/^\\s*\\d+\\s+new ad/i.test(String(s||''))}
function diffHtml(d){
  if(!d)return '';
  const clean=(arr)=>(arr||[]).map(x=>String(x||'').replace(/\\s+/g,' ').trim()).filter(x=>x.length>2).slice(0,6);
  const add=clean(d.added),rem=clean(d.removed);
  if(!add.length&&!rem.length)return '';
  return '<div style="margin-top:5px;font-size:12px;line-height:1.55;background:#F8FAFD;border:1px solid #E3E9F2;border-radius:6px;padding:6px 8px">'+
    add.map(l=>'<div style="color:#146c2e"><b>+</b> '+esc(l.slice(0,180))+'</div>').join('')+
    rem.map(l=>'<div style="color:#b02a2a"><b>&minus;</b> '+esc(l.slice(0,180))+'</div>').join('')+'</div>';
}
function tableChanges(rows){if(!rows.length)return emptyState('🔔','No changes detected in this window','Changes appear after a Scan finds a difference on a watched source.');return '<table><thead><tr><th>When</th><th>Competitor</th><th>Type</th><th>Sev</th><th>Score</th><th>What changed (added / removed)</th></tr></thead><tbody>'+
  rows.map(c=>{const an=c.analysis;const dh=diffHtml(c.diff);return '<tr><td class="sm muted">'+dt(c.detected_at)+'</td><td><b>'+esc(c.competitor||'—')+'</b></td><td class="sm">'+esc(String(c.kind||'').replace('_',' '))+'</td><td>'+badge(c.severity||'low')+'</td><td>'+(c.score??'—')+'</td><td>'+
    (isRawSummary(c.summary)?(dh?'':'<span class="muted sm">minor change — no readable text captured</span>'):'<div>'+fmt(c.summary,220)+'</div>')+
    dh+
    (c.recommended?'<div style="color:var(--acc);margin-top:3px">→ '+esc(c.recommended)+'</div>':'')+
    (an?'<div style="margin-top:4px">'+anaBadges(an)+'</div>':'')+
    (c.source_url?'<div class="sm" style="margin-top:3px"><a href="'+esc(c.source_url)+'" target="_blank" rel="noreferrer">source ↗</a></div>':'')+
    '</td></tr>'}).join('')+'</tbody></table>'}

function hostOf(u){try{return new URL(u).hostname.replace(/^www\\./,'')}catch(e){return ''}}
function tableMentions(rows){if(!rows.length)return emptyState('💬','No brand mentions found yet','Run Brand check after seeding brand sources on the Add tab.');return '<table><thead><tr><th>When</th><th>Keyword</th><th>Platform</th><th>Sentiment</th><th>Mention</th><th>Source</th></tr></thead><tbody>'+
  rows.map(m=>'<tr><td class="sm muted">'+dt(m.found_at)+'</td><td><b>'+esc(m.keyword)+'</b></td><td class="sm">'+esc(m.platform||'—')+'</td><td>'+badge(m.sentiment||'neutral')+(m.is_customer?' <span class="pill">customer</span>':'')+'</td><td>'+fmt(m.text,220)+'</td>'+
  '<td class="sm">'+(m.url?'<a href="'+esc(m.url)+'" target="_blank" rel="noreferrer">'+esc(hostOf(m.url)||'open')+' ↗</a>':'<span class="muted">no link captured</span>')+'</td></tr>').join('')+'</tbody></table>'}

function srcCondition(s){
  const isAd=s.kind==='meta_adlib'||s.kind==='google_ads'
  if(isAd)return {label:(s.ad_count||0)+' ads',cls:(s.ad_count>0?'positive':'neutral'),note:'ad source'}
  if(!s.last_status)return {label:'never',cls:'low',note:'not scanned yet'}
  if(s.last_status==='error')return {label:'error',cls:'critical',note:s.last_error||'fetch failed'}
  if((s.last_len||0)<200)return {label:'weak',cls:'high',note:'only '+(s.last_len||0)+' chars (bot/login wall)'}
  return {label:'ok',cls:'positive',note:(s.last_len||0)+' chars captured'}
}
function sourceSummary(rows){if(!rows.length)return '';const c={ok:0,weak:0,error:0,never:0,ad:0}
  rows.forEach(s=>{const k=srcCondition(s).label;if(k==='ok')c.ok++;else if(k==='weak')c.weak++;else if(k==='error')c.error++;else if(k==='never')c.never++;else c.ad++})
  return '<div class="filters"><span class="pill">Total '+rows.length+'</span><span class="badge b-positive">OK '+c.ok+'</span> <span class="badge b-high">Weak '+c.weak+'</span> <span class="badge b-critical">Error '+c.error+'</span> <span class="badge b-low">Never '+c.never+'</span> <span class="pill">Ad sources '+c.ad+'</span></div>'}
function tableSources(rows){if(!rows.length)return emptyState('🌐','No sources yet','Add competitors on the Add tab, or run seed from the CLI.');return '<table><thead><tr><th>Competitor</th><th>Kind</th><th>Condition</th><th>Last check</th><th>URL</th><th>Snaps</th><th>Changes</th></tr></thead><tbody>'+
  rows.map(s=>{const co=srcCondition(s);return '<tr><td>'+esc(s.competitor||'—')+'</td><td class="sm">'+esc(s.kind)+'</td><td>'+badge(co.cls,co.label)+'<div class="sm muted" style="margin-top:2px">'+fmt(co.note,42)+'</div></td><td class="sm muted">'+(s.last_at?dt(s.last_at):'—')+'</td><td class="sm mono"><a href="'+esc(s.url)+'" target="_blank" rel="noreferrer">'+fmt(s.url,48)+'</a></td><td>'+s.snapshots+'</td><td>'+s.changes+'</td></tr>'}).join('')+'</tbody></table>'}

async function drawAdd(m){
  const c=await api('config');const b=c.brand||{};const products=b.products||[]
  const comp=await api('competitors');const existing=comp.rows.map(x=>x.competitor)
  const prodOpts='<option value="">(no product)</option>'+products.map(p=>'<option>'+esc(p)+'</option>').join('')
  const prodOpts2=products.map(p=>'<option>'+esc(p)+'</option>').join('')
  m.innerHTML='<div class="grid2">'+
   '<div class="card"><h3>Add competitor</h3><div class="muted sm" style="margin-bottom:8px">Enter a name (custom is fine). Domain and handles are optional. Radar auto-adds website, pricing, blog, Google Ads, Meta Ad Library, Reddit, Quora, X and any social profiles you provide.</div>'+
     '<label class="f">Competitor name *</label><input id="ac-name" placeholder="e.g. Hubstaff">'+
     '<label class="f">Attach to your product</label><select id="ac-prod">'+prodOpts+'</select>'+
     '<label class="f">Website domain</label><input id="ac-dom" placeholder="hubstaff.com">'+
     '<div class="grid2"><div><label class="f">Facebook</label><input id="ac-fb" placeholder="page or URL"></div><div><label class="f">Instagram</label><input id="ac-ig" placeholder="@handle or URL"></div></div>'+
     '<div class="grid2"><div><label class="f">LinkedIn</label><input id="ac-li" placeholder="company slug or URL"></div><div><label class="f">YouTube</label><input id="ac-yt" placeholder="@handle or URL"></div></div>'+
     '<div class="grid2"><div><label class="f">TikTok</label><input id="ac-tk" placeholder="@handle or URL"></div><div><label class="f">Threads</label><input id="ac-th" placeholder="@handle or URL"></div></div>'+
     '<label class="f">Pinterest</label><input id="ac-pin" placeholder="username or URL">'+
     '<div class="frow" style="margin-top:10px"><button class="btn p" id="ac-verify">Verify sources with AI</button><button class="btn" id="ac-prev">Preview only</button><button class="btn" id="ac-add">Add without checking</button></div>'+
     '<div class="hint" style="margin-top:7px">Verify asks the Claude CLI for the real pages, then opens every one to confirm it is really this company. Only what passes gets connected. It takes a minute or two.</div>'+
     '<div id="ac-verify-msg" class="muted sm" style="margin-top:8px"></div>'+
     '<div id="ac-plan" style="margin-top:10px"></div>'+
   '</div>'+
   '<div class="card"><h3>Find competitors with AI</h3><div class="muted sm" style="margin-bottom:8px">Uses the Claude CLI to suggest real competitors for a product, with their domain and social handles. Review, then add the ones you want.</div>'+
     '<label class="f">Product / category</label><select id="as-prod">'+(prodOpts2||'<option>software</option>')+'</select>'+
     '<label class="f">Focus region (optional)</label><input id="as-region" placeholder="e.g. Bangladesh / Global">'+
     '<div class="frow" style="margin-top:10px"><button class="btn p" id="as-go">Suggest competitors</button><span id="as-msg" class="muted sm"></span></div>'+
     '<div id="as-res" style="margin-top:10px"></div>'+
   '</div>'+
  '</div>'+
  '<div class="card"><h3>Brand monitoring</h3><div class="muted sm">Watches mentions of your brand and products across Reddit, Quora, X and Google reviews, and adds them as keywords.</div>'+
    '<div style="margin:8px 0">Brand: <b>'+esc(b.name||'—')+'</b> '+products.map(p=>'<span class="pill">'+esc(p)+'</span>').join('')+'</div>'+
    '<button class="btn p" id="ab-seed">Seed brand sources + keywords</button> <span id="ab-msg" class="muted sm"></span>'+
    '<div class="muted sm" style="margin-top:6px">Edit brand name, products and keywords in the Config tab.</div>'+
  '</div>'
  const HANDLES=[['facebook','#ac-fb'],['instagram','#ac-ig'],['linkedin','#ac-li'],['youtube','#ac-yt'],['tiktok','#ac-tk'],['threads','#ac-th'],['pinterest','#ac-pin']]
  const payload=()=>{const p={competitor:$('#ac-name').value.trim(),product:$('#ac-prod').value||null,domain:$('#ac-dom').value.trim()||null};HANDLES.forEach(([k,s])=>{p[k]=$(s).value.trim()||null});return p}
  const planTable=(rows)=>'<table><thead><tr><th>Kind</th><th>URL</th></tr></thead><tbody>'+rows.map(r=>'<tr><td class="sm">'+esc(r.kind)+'</td><td class="sm mono">'+fmt(r.url,70)+'</td></tr>').join('')+'</tbody></table>'
  $('#ac-prev').onclick=async()=>{const p=payload();if(!p.competitor)return toast('Enter a competitor name')
    const qs=new URLSearchParams({competitor:p.competitor});if(p.domain)qs.set('domain',p.domain);HANDLES.forEach(([k])=>{if(p[k])qs.set(k,p[k])})
    const d=await api('competitor/plan?'+qs.toString());$('#ac-plan').innerHTML='<div class="sm muted" style="margin-bottom:4px">'+d.rows.length+' sources will be added:</div>'+planTable(d.rows)}
  $('#ac-add').onclick=async()=>{const p=payload();if(!p.competitor)return toast('Enter a competitor name')
    const r=await api('competitor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)})
    if(r.ok){toast('Added '+p.competitor+' ('+r.added+' sources)');['#ac-name','#ac-dom'].concat(HANDLES.map(h=>h[1])).forEach(s=>$(s).value='');$('#ac-plan').innerHTML=''}else toast(r.error||'failed')}
  // ---- verified connect ------------------------------------------------
  const SRC_BADGE={verified:['positive','verified'],search:['confirmed','search'],login:['medium','login wall'],unverified:['medium','unconfirmed'],dead:['negative','not found'],unreachable:['negative','unreachable']}
  const FOUND_LABEL={ai:'Claude CLI',you:'you typed it',radar:'built by Radar'}
  let vRows=[]
  let vTimer
  const vmsg=(h)=>{const e=$('#ac-verify-msg');if(e)e.innerHTML=h}
  function drawVerify(d){
    const el=$('#ac-plan');if(!el)return
    const r=d.result;if(!r)return
    vRows=r.rows||[]
    const c=r.counts||{}
    const head='<div class="frow" style="margin-bottom:8px">'+
      Object.keys(SRC_BADGE).filter(k=>c[k]).map(k=>'<span class="pill">'+esc(SRC_BADGE[k][1])+' '+c[k]+'</span>').join('')+
      (r.kb&&r.kb.used?'<span class="pill">knowledge base used</span>':'')+'</div>'+
      (r.aiError?'<div class="hint" style="color:var(--red)">Claude CLI: '+esc(r.aiError)+'. Only what you typed and the search URLs were checked.</div>':'')
    el.innerHTML=head+'<table><thead><tr><th style="width:28px"></th><th>Kind</th><th>Check</th><th>URL</th><th>Found by</th><th>Evidence</th></tr></thead><tbody>'+
      vRows.map((x,i)=>{const b=SRC_BADGE[x.status]||['medium',x.status]
        const on=(x.status==='verified'||x.status==='search')?'checked':''
        return '<tr><td><input type="checkbox" class="v-pick" data-i="'+i+'" '+on+'></td>'+
          '<td class="sm">'+esc(x.kind)+'</td>'+
          '<td>'+badge(b[0],b[1])+'</td>'+
          '<td class="sm mono"><a href="'+esc(x.url)+'" target="_blank" rel="noreferrer">'+fmt(x.url,58)+'</a></td>'+
          '<td class="sm muted">'+esc(FOUND_LABEL[x.found]||x.found||'')+'</td>'+
          '<td class="sm muted">'+fmt(x.note||x.basis||'',90)+'</td></tr>'}).join('')+
      '</tbody></table>'+
      '<div class="frow" style="margin-top:10px"><button class="btn p" id="v-connect">Connect selected</button><button class="btn" id="v-all">Select all</button><button class="btn" id="v-none">Select none</button><span id="v-msg" class="muted sm"></span></div>'+
      '<div class="hint" style="margin-top:6px">Verified and search rows are ticked already. A login wall means the page exists but Radar could not read it signed out, so it is worth connecting only if the capture profile is signed in.</div>'
    $('#v-all').onclick=()=>document.querySelectorAll('.v-pick').forEach(x=>x.checked=true)
    $('#v-none').onclick=()=>document.querySelectorAll('.v-pick').forEach(x=>x.checked=false)
    $('#v-connect').onclick=async()=>{
      const picked=[...document.querySelectorAll('.v-pick:checked')].map(x=>vRows[Number(x.dataset.i)]).filter(Boolean)
      if(!picked.length)return toast('Nothing selected')
      $('#v-msg').innerHTML='<span class="spin"></span>connecting…'
      const rr=await api('connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({competitor:r.competitor,product:r.product,rows:picked.map(x=>({kind:x.kind,url:x.url}))})})
      $('#v-msg').textContent=rr.ok?('connected '+rr.added+' source(s)'+(rr.failed&&rr.failed.length?', '+rr.failed.length+' failed':'')):(rr.error||'failed')
      toast(rr.ok?('Connected '+rr.added+' sources to '+r.competitor):'Connect failed')
      if(rr.ok)srcCache[r.competitor]=null
    }
  }
  async function pollVerify(){
    clearTimeout(vTimer)
    let d;try{d=await api('discover')}catch(e){vTimer=setTimeout(pollVerify,3000);return}
    if(!$('#ac-verify'))return
    if(d.running){const p=d.progress
      vmsg('<span class="spin"></span>'+esc((p&&p.phase)||'Working')+(p&&p.total?' — '+Math.min(p.done+1,p.total)+' of '+p.total:'')+(p&&p.current?'<div class="mono muted" style="margin-top:3px">'+esc(p.current)+'</div>':''))
      vTimer=setTimeout(pollVerify,2000);return}
    $('#ac-verify').disabled=false
    if(d.error){vmsg('<b style="color:var(--red)">'+esc(d.error)+'</b>');return}
    if(d.result){vmsg('<b style="color:var(--green)">Checked '+(d.result.rows||[]).length+' source(s)</b> — review below, then connect.');drawVerify(d)}
  }
  $('#ac-verify').onclick=async()=>{
    const p=payload();if(!p.competitor)return toast('Enter a competitor name')
    p.region=''
    $('#ac-verify').disabled=true;$('#ac-plan').innerHTML=''
    vmsg('<span class="spin"></span>starting…')
    const r=await api('discover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)})
    if(!r.ok){$('#ac-verify').disabled=false;vmsg('<b style="color:var(--red)">'+esc(r.error||'could not start')+'</b>');return}
    pollVerify()
  }
  pollVerify()

  // Suggestions run server-side and are polled, so leaving this tab never
  // cancels one in progress; returning shows it running or its last result.
  function renderSuggestions(r){
    const box=$('#as-res');if(!box)return
    if(!r||!r.rows||!r.rows.length){box.innerHTML='<div class="muted sm">No suggestions returned'+(r&&r.note?': '+esc(r.note):'')+'.</div>';return}
    const kbNote=r.kb&&r.kb.used
      ? '<div class="hint">Grounded in the knowledge base — read '+(r.kb.files||[]).length+' file(s): <span class="mono">'+esc((r.kb.files||[]).slice(0,6).join(', '))+'</span></div>'
      : '<div class="hint">Knowledge base not used'+(r.kb&&r.kb.error?' ('+esc(r.kb.error)+')':'')+' — these come from general knowledge only. Set it up on the Config tab for sharper matches.</div>'
    box.innerHTML=kbNote+'<table><thead><tr><th>Company</th><th>Domain</th><th>Social</th><th>Overlap with us</th><th>Why</th><th></th></tr></thead><tbody>'+
      r.rows.map((x,i)=>'<tr><td><b>'+esc(x.name)+'</b>'+(x.source==='kb'?' '+badge('confirmed','in KB'):'')+'</td><td class="sm mono">'+esc(x.domain||'—')+'</td><td class="sm">'+[x.facebook&&'fb',x.linkedin&&'in',x.youtube&&'yt'].filter(Boolean).join(' · ')+'</td><td class="sm">'+fmt(x.overlap,70)+'</td><td class="sm muted">'+fmt(x.note,70)+'</td><td><button class="btn" data-i="'+i+'">Add</button></td></tr>').join('')+'</tbody></table>'
    box.querySelectorAll('button[data-i]').forEach(btn=>btn.onclick=async()=>{const x=r.rows[btn.dataset.i];const prod=$('#as-prod').value||null;btn.disabled=true;btn.textContent='…'
      const rr=await api('competitor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({competitor:x.name,product:prod,domain:x.domain,facebook:x.facebook,linkedin:x.linkedin,youtube:x.youtube})})
      if(!rr.ok){btn.textContent='err';toast(rr.error||'failed');return}
      existing.push(x.name);srcCache[x.name]=null;btn.textContent='✓ '+rr.added+' · verifying…'
      // Seed done — now verify and fix every source for this competitor.
      const st=await api('recheck',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({competitor:x.name,product:prod,apply:true})})
      if(!st.ok){btn.disabled=false;btn.textContent='✓ '+rr.added;toast('Added '+x.name+(st.busy?' — verify busy, try Verify in its sources':''));return}
      const poll=async()=>{let d;try{d=await api('recheck')}catch(e){return setTimeout(poll,3000)}
        if(d.running){const p=d.progress;btn.textContent='✓ '+rr.added+' · '+esc((p&&p.phase)||'verifying')+'…';return setTimeout(poll,2000)}
        if(d.result&&d.result.competitor===x.name){const ap=d.result.applied||{};btn.disabled=false;btn.textContent='✓ done';srcCache[x.name]=null;toast('Added '+x.name+' — fixed '+(ap.updated||0)+', added '+(ap.added||0)+(ap.unresolved?', '+ap.unresolved+' still broken':''))}
        else if(d.error){btn.disabled=false;btn.textContent='✓ '+rr.added;toast('Added '+x.name+' — verify failed: '+d.error)}
        else {btn.disabled=false;btn.textContent='✓ done'}}
      poll()})
  }
  async function pollSuggest(){
    clearTimeout(window.__sgTimer)
    if(!$('#as-res'))return
    let d;try{d=await api('suggestion')}catch(e){window.__sgTimer=setTimeout(pollSuggest,3000);return}
    if(!$('#as-go'))return
    if(d.running){
      $('#as-go').disabled=true
      const secs=d.startedAt?Math.max(0,Math.round((Date.now()-Date.parse(d.startedAt))/1000)):0
      $('#as-msg').innerHTML='<span class="spin"></span>searching… '+secs+'s'
      // Never leave the panel blank while it works — show live status here.
      $('#as-res').innerHTML='<div class="card" style="box-shadow:none;padding:16px"><div style="font-weight:600"><span class="spin"></span> Finding competitors from the knowledge base…</div><div class="muted sm" style="margin-top:6px">Running on the server ('+secs+'s). You can switch tabs — it keeps going, and the result appears here when it is ready.</div>'+(secs>60?'<div style="margin-top:10px"><button class="btn sm" id="as-reset">Taking too long? Reset</button></div>':'')+'</div>'
      const rb=$('#as-reset');if(rb)rb.onclick=async()=>{rb.disabled=true;await api('competitor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({resetSuggest:1})});clearTimeout(window.__sgTimer);$('#as-go').disabled=false;$('#as-msg').textContent='';$('#as-res').innerHTML='<div class="muted sm">Reset. Click Suggest competitors to run it again.</div>'}
      window.__sgTimer=setTimeout(pollSuggest,2000);return
    }
    $('#as-go').disabled=false;$('#as-msg').textContent=''
    if(d.error){$('#as-res').innerHTML='<div class="muted sm">Could not get suggestions: '+esc(d.error)+'</div>';return}
    if(d.result)renderSuggestions(d.result)
  }
  $('#as-go').onclick=async()=>{const prod=$('#as-prod').value,region=$('#as-region').value.trim()
    $('#as-res').innerHTML='';$('#as-go').disabled=true;$('#as-msg').innerHTML='<span class="spin"></span>starting…'
    const r=await api('competitor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({suggest:1,product:prod,region,existing})})
    if(!(r&&(r.started||r.ok))){if(r&&r.busy){pollSuggest();return}$('#as-go').disabled=false;$('#as-msg').textContent='';$('#as-res').innerHTML='<div class="muted sm">Could not start: '+esc((r&&r.error)||'')+'</div>';return}
    pollSuggest()
  }
  pollSuggest()
  $('#ab-seed').onclick=async()=>{$('#ab-msg').textContent='seeding…';const r=await api('brand/seed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});$('#ab-msg').textContent=r.ok?('added '+r.added+' sources, '+r.keywords+' keywords'):'error';toast(r.ok?'Brand sources seeded':'failed')}
}

async function drawConfig(m){
  const c=await api('config')
  const b=c.brand||{},sc=c.schedule||{},em=c.email||{},no=c.notify||{}
  m.innerHTML='<div class="grid2">'+
   '<div class="card"><h3>Brand & keywords</h3>'+
     '<label class="f">Brand name</label><input id="c-brand" value="'+esc(b.name||'')+'">'+
     '<label class="f">Keywords (comma separated)</label><input id="c-kw" value="'+esc((b.keywords||[]).join(', '))+'">'+
     '<div class="frow" style="margin-top:8px"><label><input type="checkbox" id="c-neg" '+(b.notifyNegative!==false?'checked':'')+'> notify on negative</label>'+
     '<label><input type="checkbox" id="c-pos" '+(b.notifyPositive===true?'checked':'')+'> notify on positive</label></div>'+
     '<label class="f">Alert severity threshold</label><select id="c-sev"><option value="">any negative</option>'+['low','medium','high','critical'].map(x=>'<option '+(b.alertThreshold===x?'selected':'')+'>'+x+'</option>').join('')+'</select>'+
   '</div>'+
   '<div class="card"><h3>Schedule (GMT+'+esc(sc.timezoneOffset??6)+')</h3>'+
     '<label class="f">Scan hour</label><input id="c-scan" type="number" min="0" max="23" value="'+esc(sc.scanHour??2)+'">'+
     '<label class="f">Report hour</label><input id="c-rep" type="number" min="0" max="23" value="'+esc(sc.reportHour??9)+'">'+
     '<label class="f">Timezone offset (hours)</label><input id="c-tz" type="number" value="'+esc(sc.timezoneOffset??6)+'">'+
   '</div>'+
   '<div class="card"><h3>Email</h3>'+
     '<div class="frow"><label><input type="checkbox" id="c-em-en" '+(em.enabled?'checked':'')+'> enabled</label></div>'+
     '<label class="f">SMTP host</label><input id="c-em-host" value="'+esc(em.host||'')+'">'+
     '<label class="f">Port</label><input id="c-em-port" type="number" value="'+esc(em.port||587)+'">'+
     '<label class="f">User</label><input id="c-em-user" value="'+esc(em.user||'')+'">'+
     '<label class="f">Password ('+(em.pass?'set — leave to keep':'empty')+')</label><input id="c-em-pass" type="password" placeholder="'+(em.pass?'********':'')+'">'+
     '<label class="f">Recipients — To (add several, comma separated)</label><input id="c-em-to" value="'+esc((em.to||[]).join(', '))+'" placeholder="a@ibos.io, b@ibos.io, c@ibos.io">'+
     '<label class="f">CC (optional, comma separated)</label><input id="c-em-cc" value="'+esc((em.cc||[]).join(', '))+'" placeholder="manager@ibos.io, team@ibos.io">'+
   '</div>'+
   '<div class="card"><h3>Notify channels</h3>'+
     ['email','teams','whatsapp'].map(ch=>'<label style="display:block"><input type="checkbox" class="c-ch" value="'+ch+'" '+((no.channels||['email']).includes(ch)?'checked':'')+'> '+ch+'</label>').join('')+
     '<label class="f">Teams webhook ('+(no.teamsWebhook?'set':'empty')+')</label><input id="c-teams" placeholder="'+(no.teamsWebhook?'********':'')+'">'+
   '</div>'+
   '<div class="card"><h3>Knowledge base (GitHub)</h3><div class="muted sm" style="margin-bottom:6px">Radar clones this repository and gives it to the Claude CLI, so competitor suggestions and change analysis follow our own positioning instead of generic model knowledge. Read only — nothing is ever pushed.</div>'+
     '<div class="frow"><label><input type="checkbox" id="c-kb-on" '+((c.kb&&c.kb.enabled)!==false?'checked':'')+'> Use the knowledge base</label></div>'+
     '<label class="f">Repository URL</label><input id="c-kb-repo" value="'+esc((c.kb&&c.kb.repo)||'https://gitlab.ibos.io/ibos-kb/ibos-kb')+'" placeholder="https://gitlab.ibos.io/group/repo">'+
     '<label class="f">Server type</label><select id="c-kb-prov">'+
       ['auto','gitlab','github','generic'].map(v=>'<option value="'+v+'" '+(((c.kb&&c.kb.provider)||'auto')===v?'selected':'')+'>'+(v==='auto'?'Auto (from the URL)':v==='generic'?'Other git server':v==='gitlab'?'GitLab':'GitHub')+'</option>').join('')+'</select>'+
     '<label class="f">Branch (leave empty for the default)</label><input id="c-kb-branch" value="'+esc((c.kb&&c.kb.branch)||'')+'" placeholder="main">'+
     '<label class="f">Access token ('+((c.kb&&c.kb.token)?'set — leave empty to keep':'needed for a private repo')+')</label><input id="c-kb-token" type="password" placeholder="'+((c.kb&&c.kb.token)?'********':'glpat-... or github_pat_...')+'">'+
     '<div class="muted sm" style="margin-top:4px">GitLab: a personal, project or group token with <b>read_repository</b>. GitHub: a fine-grained token with <b>Contents: Read</b>. Leave empty if git on this PC can already reach the server. Switching between GitLab and GitHub later is just a new URL and a new token.</div>'+
     '<label class="f">How much of the knowledge base to send (characters)</label><input id="c-kb-max" type="number" min="2000" max="60000" step="1000" value="'+esc((c.kb&&c.kb.maxChars)||12000)+'">'+
     '<div class="frow" style="margin-top:12px"><button class="btn p" id="c-kb-sync">Sync now</button><span id="c-kb-msg" class="muted sm"></span></div>'+
     '<div id="c-kb-out"></div>'+
   '</div>'+
   '<div class="card"><h3>Authenticated capture (Chrome profile)</h3><div class="muted sm" style="margin-bottom:6px">A logged-in Chrome profile lets Radar read Facebook, Instagram, LinkedIn, X, TikTok and Quora as a signed-in user. Use a separate profile folder, not your main Chrome.</div>'+
     '<label class="f">Chrome profile folder</label><input id="c-chrome-dir" value="'+esc((c.chrome&&c.chrome.userDataDir)||'')+'" placeholder="C:\\\\Users\\\\ibos\\\\radar-chrome">'+
     '<label class="f">Profile sub-directory (optional)</label><input id="c-chrome-prof" value="'+esc((c.chrome&&c.chrome.profileDirectory)||'')+'" placeholder="Default">'+
     '<label class="f">Chrome program (leave empty to find it automatically)</label><input id="c-chrome-bin" value="'+esc((c.chrome&&c.chrome.bin)||'')+'" placeholder="C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe">'+
     '<label class="f">Python program (runs the page fetcher)</label><input id="c-py-bin" value="'+esc((c.python&&c.python.bin)||'')+'" placeholder="C:\\\\Python312\\\\python.exe">'+
     '<label class="f">Page renderer</label><select id="c-chrome-engine">'+
       [['auto','Auto (Playwright when installed)'],['playwright','Playwright (waits for the page to finish)'],['dump-dom','Chrome snapshot (no waiting)']]
         .map(v=>'<option value="'+v[0]+'" '+(((c.chrome&&c.chrome.engine)||'auto')===v[0]?'selected':'')+'>'+v[1]+'</option>').join('')+'</select>'+
     '<div class="frow" style="margin-top:9px"><label><input type="checkbox" id="c-chrome-headful" '+((c.chrome&&c.chrome.headless)===false?'checked':'')+'> Use a real browser window (parked off screen)</label></div>'+
     '<div class="muted sm" style="margin-top:4px">A snapshot cannot wait for a page to load, which is why signed-in Facebook, X, TikTok and Quora come back empty. Playwright drives a real browser and waits. Install it once with <span class="mono">python -m pip install playwright</span> — no browser download needed. Tick the real window option if a site still refuses; it is the hardest to block.</div>'+
     '<div class="frow" style="margin-top:12px"><button class="btn" id="c-tools">Check Python and Chrome</button><button class="btn g" id="c-chrome-login">Open login browser</button><button class="btn p" id="c-chrome-test">Test capture</button><button class="btn" id="c-chrome-clear" style="color:var(--red);border-color:var(--red)">Clear profile</button></div>'+
     '<div class="frow" style="margin-top:9px"><button class="btn g" id="c-pw-install">Install Playwright</button><span id="c-pw-msg" class="muted sm"></span></div>'+
     '<div id="c-chrome-msg" class="muted sm" style="margin-top:8px"></div>'+
     '<div id="c-chrome-out"></div>'+
     '<div class="muted sm" style="margin-top:8px">Only one Chrome can use a profile folder at a time. Save, click <b>Open login browser</b>, sign in, then <b>close that window</b> before testing or running a scan.</div>'+
   '</div>'+
  '</div><button class="btn p" id="c-save">Save config</button> <span id="c-msg" class="muted sm"></span>'+
  '<div class="grid2" style="margin-top:14px">'+
   '<div class="card"><h3>Brand products</h3><div class="muted sm" style="margin-bottom:8px">These appear in the Add-competitor product picker. Add or remove one at a time.</div><div id="prodlist"></div><div class="frow" style="margin-top:10px"><input id="prod-new" placeholder="e.g. Managerium Health"><button class="btn p" id="prod-add">Add product</button></div></div>'+
   '<div class="card"><h3>Manage keywords</h3><div class="muted sm" style="margin-bottom:8px">Brand terms Radar watches for mentions.</div><div id="kwlist"></div><div class="frow" style="margin-top:10px"><input id="kw-new" placeholder="new keyword"><button class="btn" id="kw-add">Add</button></div></div>'+
  '</div>'
  const drawKw=async()=>{const k=await api('keywords');$('#kwlist').innerHTML=k.rows.map(x=>'<span class="pill">'+esc(x.keyword)+' <a href="#" data-k="'+x.id+'">✕</a></span>').join('')||'<span class="muted">none</span>'
    $('#kwlist').querySelectorAll('a[data-k]').forEach(a=>a.onclick=async(e)=>{e.preventDefault();await api('keywords',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({remove:Number(a.dataset.k)})});drawKw()})}
  $('#kw-add').onclick=async()=>{const v=$('#kw-new').value.trim();if(!v)return;await api('keywords',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keyword:v})});$('#kw-new').value='';drawKw()}
  await drawKw()
  // friendly product tags (saved to config.brand.products)
  let prods=(b.products||[]).slice()
  const saveProds=()=>api('config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({brand:{products:prods}})})
  const drawProds=()=>{$('#prodlist').innerHTML=prods.length?prods.map((p,i)=>'<span class="pill">'+esc(p)+' <a href="#" data-p="'+i+'">✕</a></span>').join(''):'<span class="muted sm">No products yet.</span>'
    $('#prodlist').querySelectorAll('a[data-p]').forEach(a=>a.onclick=async(e)=>{e.preventDefault();prods.splice(Number(a.dataset.p),1);drawProds();await saveProds();toast('Product removed')})}
  $('#prod-add').onclick=async()=>{const v=$('#prod-new').value.trim();if(!v)return;if(prods.some(p=>p.toLowerCase()===v.toLowerCase()))return toast('Already added');prods.push(v);$('#prod-new').value='';drawProds();await saveProds();toast('Product added: '+v)}
  $('#prod-new').onkeydown=(e)=>{if(e.key==='Enter')$('#prod-add').click()}
  drawProds()
  const kbDraw=(k)=>{const e=$('#c-kb-out');if(!e)return
    if(!k){e.innerHTML='';return}
    const when=k.lastSync?dt(k.lastSync):'never'
    e.innerHTML='<table style="margin-top:10px"><tbody>'+
      '<tr><td class="sm">Status</td><td>'+(k.present?badge('positive','cloned'):badge('negative','not cloned'))+'</td></tr>'+
      '<tr><td class="sm">Server</td><td class="sm">'+esc(k.provider||'')+(k.hasToken?' · token set':' · no token')+'</td></tr>'+
      '<tr><td class="sm">Repository</td><td class="sm mono">'+esc(k.repo||'')+'</td></tr>'+
      '<tr><td class="sm">Files indexed</td><td class="sm">'+(k.files||0)+' ('+Math.round((k.bytes||0)/1024)+' KB)</td></tr>'+
      '<tr><td class="sm">Last sync</td><td class="sm">'+esc(when)+'</td></tr>'+
      (k.head?'<tr><td class="sm">Latest commit</td><td class="sm mono">'+esc(k.head)+'</td></tr>':'')+
      (k.lastError?'<tr><td class="sm">Last error</td><td class="sm" style="color:var(--red)">'+esc(k.lastError)+'</td></tr>':'')+
      '</tbody></table>'+
      ((k.sample||[]).length?'<div class="muted sm mono" style="margin-top:7px">'+esc(k.sample.slice(0,12).join('  ·  '))+((k.files>12)?'  · +'+(k.files-12)+' more':'')+'</div>':'')}
  api('kb').then(kbDraw).catch(()=>{})
  $('#c-kb-sync').onclick=async()=>{
    $('#c-kb-msg').innerHTML='<span class="spin"></span>cloning / pulling…'
    const r=await api('kb/sync',{method:'POST'})
    $('#c-kb-msg').innerHTML=r.ok?'<b style="color:var(--green)">synced ✓</b>':'<b style="color:var(--red)">'+esc(r.error||'failed')+'</b>'
    toast(r.ok?'Knowledge base synced':'Sync failed')
    kbDraw(await api('kb'))
  }
  const cmsg=(h)=>{const e=$('#c-chrome-msg');if(e)e.innerHTML=h}
  const cout=(h)=>{const e=$('#c-chrome-out');if(e)e.innerHTML=h}
  $('#c-chrome-login').onclick=async()=>{
    cmsg('<span class="spin"></span>opening Chrome…');cout('')
    const r=await api('chrome/login',{method:'POST'})
    if(r.ok){cmsg('Chrome opened on your PC. Sign in to each site, then <b>close that window</b> and press Test capture.');toast('Login browser opened')}
    else{cmsg('<b style="color:var(--red)">Could not open Chrome.</b> '+esc(r.error||''));toast('Could not open Chrome')}
  }
  $('#c-tools').onclick=async()=>{
    cmsg('<span class="spin"></span>checking…');cout('')
    const t=await api('chrome/tools')
    const row=(label,ok,detail)=>'<tr><td>'+esc(label)+'</td><td>'+badge(ok?'positive':'negative',ok?'ok':'problem')+'</td><td class="sm mono">'+esc(detail||'')+'</td></tr>'
    cmsg('')
    cout('<table style="margin-top:10px"><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>'+
      row('Python',t.python.ok,t.python.version||t.python.error)+
      row('Page fetcher (fbfetch.py)',t.fetcher.ok,t.fetcher.path)+
      row('Chrome',t.chrome.ok,t.chrome.path||t.chrome.error)+
      row('Playwright',(t.engine&&t.engine.playwrightInstalled),(t.engine&&t.engine.playwrightInstalled)?'installed — using it':'not installed, run: python -m pip install playwright')+
      row('Renderer in use',(t.engine&&t.engine.name)==='playwright',(t.engine&&t.engine.name)==='playwright'?'Playwright (waits for pages)':'Chrome snapshot (cannot wait — signed-in pages may come back empty)')+
      row('Profile folder',t.profile.exists,(t.profile.dir||'not set')+(t.profile.busy?'  (in use by another Chrome right now)':''))+
      '</tbody></table>')
  }
  // ---- one-click Playwright install -------------------------------------
  let pwTimer
  const pwmsg=(h)=>{const e=$('#c-pw-msg');if(e)e.innerHTML=h}
  async function pollInstall(){
    clearTimeout(pwTimer)
    let d;try{d=await api('chrome/install')}catch(e){pwTimer=setTimeout(pollInstall,3000);return}
    if(!$('#c-pw-install'))return
    if(d.running){$('#c-pw-install').disabled=true
      pwmsg('<span class="spin"></span>installing… '+(d.line?'<span class="mono">'+esc(d.line)+'</span>':'this takes a minute'))
      pwTimer=setTimeout(pollInstall,2000);return}
    $('#c-pw-install').disabled=false
    if(d.ok===true)pwmsg('<b style="color:var(--green)">Playwright installed.</b> Press <b>Check Python and Chrome</b>, then <b>Test capture</b>.')
    else if(d.ok===false)pwmsg('<b style="color:var(--red)">'+esc(d.error||'install failed')+'</b>'+(d.log?'<div class="mono muted" style="margin-top:4px;white-space:pre-wrap">'+esc(String(d.log).slice(-500))+'</div>':''))
  }
  $('#c-pw-install').onclick=async()=>{
    $('#c-pw-install').disabled=true;pwmsg('<span class="spin"></span>starting…')
    const r=await api('chrome/install',{method:'POST'})
    if(!r.ok){$('#c-pw-install').disabled=false;pwmsg('<b style="color:var(--red)">'+esc(r.error||'could not start')+'</b>');return}
    toast('Installing Playwright')
    pollInstall()
  }
  pollInstall()

  $('#c-chrome-clear').onclick=async()=>{
    if(!confirm('Clear the Chrome capture profile?\\n\\nEvery saved sign-in in that folder is deleted and you will have to sign in again. Close any Chrome window using it first.'))return
    const b=$('#c-chrome-clear');b.disabled=true
    cmsg('<span class="spin"></span>clearing…');cout('')
    const r=await api('chrome/clear',{method:'POST'})
    b.disabled=false
    if(r.ok){cmsg('<b style="color:var(--green)">Profile cleared.</b> Now press <b>Open login browser</b> and sign in to each site, then close that window and press <b>Test capture</b>.');toast('Chrome profile cleared')}
    else{cmsg('<b style="color:var(--red)">'+esc(r.error||'could not clear it')+'</b>');toast('Could not clear the profile')}
  }
  let ctTimer
  $('#c-chrome-test').onclick=async()=>{
    const r=await api('chrome/test',{method:'POST'})
    if(!r.ok){cmsg('<b style="color:var(--red)">'+esc(r.error||'could not start')+'</b>');return toast(r.error||'Could not start')}
    toast('Testing the signed-in profile')
    pollChromeTest()
  }
  async function pollChromeTest(){
    clearTimeout(ctTimer)
    let t;try{t=await api('chrome/test')}catch(e){ctTimer=setTimeout(pollChromeTest,3000);return}
    if(!$('#c-chrome-msg'))return
    if(t.rows&&t.rows.length){
      cout('<table style="margin-top:10px"><thead><tr><th>Site</th><th>Result</th><th>What Radar saw</th></tr></thead><tbody>'+
        t.rows.map(r=>{const V={'signed-in':['positive','signed in'],login:['medium','login wall'],challenge:['high','bot check'],unclear:['medium','unclear'],blocked:['negative','blocked']}
          const b=V[r.verdict]||(r.ok?['medium','unclear']:['negative','failed'])
          return '<tr><td>'+esc(r.site)+'</td><td>'+badge(b[0],b[1])+'</td><td class="sm">'+esc(r.note||'')+(r.title?'<div class="mono muted" style="margin-top:3px">'+esc(r.title)+'</div>':'')+'</td></tr>'}).join('')+'</tbody></table>'+
        '<div class="muted sm" style="margin-top:6px"><b>signed in</b> means the page showed something only a signed-in user sees. <b>login wall</b> means sign in again through the login browser. <b>bot check</b> means a Cloudflare-style challenge stopped the page before it loaded — try the real browser window option. <b>blocked</b> means the site refused the browser entirely. <b>unclear</b> means the page loaded but proved nothing either way.</div>')
    }
    if(t.running){
      const p=t.progress
      cmsg('<span class="spin"></span>Testing'+(p&&p.current?' '+esc(p.current):'')+(p&&p.total?' ('+(p.done+1)+' of '+p.total+')':'')+'… each site takes up to 20 seconds.')
      ctTimer=setTimeout(pollChromeTest,2000);return}
    if(t.error)cmsg('<b style="color:var(--red)">'+esc(t.error)+'</b>')
    else if(t.finishedAt){const n=(t.rows||[]).filter(r=>r.signedIn).length;cmsg('<b style="color:'+(n?'var(--green)':'var(--red)')+'">'+n+' of '+(t.rows||[]).length+' sites signed in</b>')}
  }
  pollChromeTest()
  $('#c-save').onclick=async()=>{
    const patch={brand:{name:$('#c-brand').value.trim(),products:prods.slice(),keywords:$('#c-kw').value.split(',').map(s=>s.trim()).filter(Boolean),notifyNegative:$('#c-neg').checked,notifyPositive:$('#c-pos').checked,alertThreshold:$('#c-sev').value||null},
      chrome:{userDataDir:$('#c-chrome-dir').value.trim(),profileDirectory:$('#c-chrome-prof').value.trim()||null,bin:$('#c-chrome-bin').value.trim()||null,engine:$('#c-chrome-engine').value,headless:!$('#c-chrome-headful').checked},
      python:{bin:$('#c-py-bin').value.trim()||null},
      kb:{enabled:$('#c-kb-on').checked,repo:$('#c-kb-repo').value.trim(),provider:$('#c-kb-prov').value,branch:$('#c-kb-branch').value.trim()||null,maxChars:Number($('#c-kb-max').value)||12000},
      schedule:{scanHour:Number($('#c-scan').value),reportHour:Number($('#c-rep').value),timezoneOffset:Number($('#c-tz').value)},
      email:{enabled:$('#c-em-en').checked,host:$('#c-em-host').value.trim(),port:Number($('#c-em-port').value),user:$('#c-em-user').value.trim(),to:$('#c-em-to').value.split(',').map(s=>s.trim()).filter(Boolean),cc:$('#c-em-cc').value.split(',').map(s=>s.trim()).filter(Boolean)},
      notify:{channels:[...document.querySelectorAll('.c-ch:checked')].map(x=>x.value)}}
    const pw=$('#c-em-pass').value;if(pw)patch.email.pass=pw
    const tw=$('#c-teams').value;if(tw)patch.notify.teamsWebhook=tw
    const kt=$('#c-kb-token').value;if(kt)patch.kb.token=kt
    const r=await api('config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)})
    $('#c-msg').textContent=r.ok?'saved ✓':'error';toast(r.ok?'Config saved':'Save failed')
  }
}

// ---- Schedule tab ---------------------------------------------------------
const TZS=['Asia/Dhaka','Asia/Kolkata','Asia/Karachi','Asia/Dubai','Asia/Singapore','Asia/Jakarta','Europe/London','America/New_York','UTC']
function localTime(iso,tz){if(!iso)return '—';try{return new Intl.DateTimeFormat('en-GB',{timeZone:tz,day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso))}catch(e){return dt(iso)}}
function runBadge(r){if(r.ok===true)return badge('positive','sent');if(r.ok===false)return badge('negative','failed');return badge('medium','running')}
function runDur(r){if(!r.startedAt||!r.finishedAt)return '—';const ms=new Date(r.finishedAt)-new Date(r.startedAt);if(ms<1000)return '<1s';const t=Math.round(ms/1000);return t<60?t+'s':Math.floor(t/60)+'m '+(t%60)+'s'}
function runsTable(rows,tz){if(!rows||!rows.length)return emptyState('⏰','No runs recorded yet','The daily run, a catch-up and the Run now button all appear here.')
  return '<table><thead><tr><th>Started</th><th>Trigger</th><th>Result</th><th>Took</th><th>Detail</th></tr></thead><tbody>'+
    rows.map(r=>'<tr><td class="sm">'+esc(localTime(r.startedAt,tz))+'</td><td class="sm">'+esc(r.trigger)+'</td><td>'+runBadge(r)+'</td><td class="sm">'+runDur(r)+'</td><td class="sm">'+esc(r.message||'')+
      (r.error?'<div class="muted mono" style="margin-top:5px">'+fmt(r.error,400)+'</div>':'')+'</td></tr>').join('')+'</tbody></table>'}
function schedStatus(d){const s=d.schedule||{};const tz=s.timezone||'Asia/Dhaka';const on=s.enabled!==false
  const n=(s.recipients||[]).length
  const last=d.lastSuccess?localTime(d.lastSuccess.startedAt,tz)+' · '+esc(d.lastSuccess.message||''):'none recorded yet'
  return '<div id="s-stat" class="card"><div class="frow">'+
    '<span class="pill"><span class="dot '+(on?'on':'off')+'"></span> '+(on?'Schedule on':'Schedule off')+'</span>'+
    '<span class="pill">Next report '+esc(localTime(d.nextRunAt,tz))+'</span>'+
    '<span class="pill">Next collection '+esc(localTime(d.nextScanAt,tz))+'</span>'+
    '<span class="pill">Sent today: '+(d.sentToday?'yes':'no')+'</span>'+
    '<span class="pill">'+esc(n?n+' recipient'+(n===1?'':'s'):'no recipients')+'</span>'+
    '<span class="pill">'+esc(s.engine||'')+'</span></div>'+
    '<div class="muted sm" style="margin-top:9px">Last report that went out: '+last+'</div></div>'}
function progressHtml(p){if(!p)return ''
  const has=p.total>0&&p.done!=null
  const pct=has?Math.round(p.done/p.total*100):0
  return '<div class="sm" style="margin-top:12px"><b>'+esc(p.phase||'Working')+'</b>'+
    (has?' <span class="muted">'+p.done+' of '+p.total+'</span>':'')+
    (p.current?'<div class="muted mono" style="margin-top:3px">'+esc(p.current)+'</div>':'')+
    (has?'<div class="bar"><i style="width:'+pct+'%"></i></div>':'')+'</div>'}
async function drawSchedule(m){m.innerHTML='<div id="sched" class="muted">Loading…</div>';await renderSchedule()}
async function renderSchedule(){
  const d=await api('schedule');const s=d.schedule||{};const el=$('#sched');if(!el)return
  const tz=s.timezone||'Asia/Dhaka';const zones=TZS.indexOf(tz)<0?TZS.concat([tz]):TZS
  el.innerHTML='<div class="grid2">'+
   '<div class="card"><h3>Daily report</h3><div class="muted sm">Radar builds and emails the report at this time every day. Saving applies it straight away, no restart.</div>'+
     '<label class="f">Send the report at</label><input id="s-time" type="time" value="'+esc(s.dailyTime||'09:00')+'">'+
     '<label class="f">Time zone</label><select id="s-tz">'+zones.map(z=>'<option '+(z===tz?'selected':'')+'>'+esc(z)+'</option>').join('')+'</select>'+
     '<label class="f">Overnight collection at</label><input id="s-scan" type="time" value="'+esc(s.scanTime||'02:00')+'">'+
     '<div class="frow" style="margin-top:13px">'+
       '<label><input type="checkbox" id="s-on" '+(s.enabled!==false?'checked':'')+'> Daily schedule on</label>'+
       '<label><input type="checkbox" id="s-catch" '+(s.catchUp!==false?'checked':'')+'> Catch up a missed run</label></div>'+
     '<div class="muted sm" style="margin-top:8px">Catch-up covers the PC being off or asleep: if the time has passed and nothing went out today, Radar sends it as soon as it is running again.</div></div>'+
   '<div class="card"><h3>Recipients</h3><div class="muted sm">One email per line. The daily report and the Run now button both send to these addresses.</div>'+
     '<label class="f">To</label><textarea id="s-to" rows="5" placeholder="name@ibos.io">'+esc((s.recipients||[]).join('\\n'))+'</textarea>'+
     '<label class="f">CC (optional)</label><textarea id="s-cc" rows="3">'+esc((s.cc||[]).join('\\n'))+'</textarea></div>'+
   '</div>'+
   '<div class="frow" style="margin-bottom:14px"><button class="btn p" id="s-save">Save schedule</button><span id="s-msg" class="muted sm"></span></div>'+
   schedStatus(d)+
   '<div class="card"><h3>Run the full report now</h3><div class="muted sm">Collects every source, runs the analysis and emails the complete report for the last day to the recipients above. It can take several minutes.</div>'+
     '<div class="frow" style="margin-top:10px;gap:18px">'+
       '<label><input type="checkbox" id="s-skipbrand"> Skip brand sentiment scan</label>'+
       '<label><input type="checkbox" id="s-skipai"> Skip AI analysis</label>'+
     '</div>'+
     '<div class="muted sm" style="margin-top:4px">Both are off by default (full run). Ticking one skips just that step to finish faster — sources are still collected and the report is still emailed.</div>'+
     '<div class="frow" style="margin-top:12px"><button class="btn g" id="s-run">▶ Run full report and send now</button><span id="s-runmsg" class="muted sm"></span></div>'+
     '<div id="s-prog"></div></div>'+
   '<h3>Run history</h3><div id="s-runs">'+runsTable(d.runs,tz)+'</div>'
  const lines=(v)=>v.split(/[\\n,;]/).map(x=>x.trim()).filter(Boolean)
  $('#s-save').onclick=async()=>{
    const body={dailyTime:$('#s-time').value,scanTime:$('#s-scan').value,timezone:$('#s-tz').value,
      enabled:$('#s-on').checked,catchUp:$('#s-catch').checked,
      recipients:lines($('#s-to').value),cc:lines($('#s-cc').value)}
    if(!body.recipients.length&&body.enabled){if(!confirm('No recipients. The daily report will have nowhere to go. Save anyway?'))return}
    const r=await api('schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    $('#s-msg').textContent=r.ok?'saved ✓':(r.error||'error')
    toast(r.ok?'Schedule saved':'Save failed: '+(r.error||''))
    if(r.ok)await renderSchedule()
  }
  $('#s-run').onclick=async()=>{
    const b=$('#s-run');b.disabled=true
    $('#s-runmsg').innerHTML='<span class="spin"></span>Starting…'
    const body={skipBrand:$('#s-skipbrand').checked,skipAnalyze:$('#s-skipai').checked}
    const r=await api('schedule/run-now',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    if(!r.ok){b.disabled=false;$('#s-runmsg').textContent=r.error||'could not start';return toast(r.error||'Could not start')}
    toast('Run started')
    pollSchedule()
  }
  if(d.running)pollSchedule()
}
async function pollSchedule(){
  clearTimeout(schedPoll)
  let d;try{d=await api('schedule')}catch(e){schedPoll=setTimeout(pollSchedule,4000);return}
  const tz=(d.schedule||{}).timezone||'Asia/Dhaka'
  const runsEl=$('#s-runs');if(!runsEl)return
  runsEl.innerHTML=runsTable(d.runs,tz)
  const st=$('#s-stat');if(st)st.outerHTML=schedStatus(d)
  const b=$('#s-run'),msg=$('#s-runmsg')
  const prog=$('#s-prog')
  if(d.running){if(b)b.disabled=true
    if(msg)msg.innerHTML='<span class="spin"></span>Running ('+esc(d.runningTrigger||'manual')+')… you can switch tabs, it keeps going.'
    if(prog)prog.innerHTML=progressHtml(d.progress)
    schedPoll=setTimeout(pollSchedule,3000);return}
  if(b)b.disabled=false
  if(prog)prog.innerHTML=''
  const last=(d.runs||[])[0]
  if(msg&&last&&last.finishedAt){msg.innerHTML=last.ok
    ?'<b style="color:var(--green)">Sent ✓</b> '+esc(last.message||'')
    :'<b style="color:var(--red)">Failed</b> '+esc(last.error||last.message||'')}
}

refreshHealth();draw();setInterval(refreshHealth,20000)
</script>
</body></html>`
