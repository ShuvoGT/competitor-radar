'use strict'

// Competitor Radar — reliable daily scheduling.
//
// This file decides WHEN the daily pipeline runs and records WHAT happened.
// It does not touch scraping, analysis, report rendering or email sending —
// those stay in collect.js / analyze.js / report.js / notify.js and are called
// through scheduler.js exactly as before.
//
// Three things make the 9 AM report dependable:
//   1. node-cron with an explicit timezone (Asia/Dhaka), not an hour-equality
//      poll, so the minute is hit exactly.
//   2. A catch-up check at startup and every 10 minutes: if today's time has
//      passed and no successful run is recorded for today, it runs once. This
//      covers a PC that was asleep, off, or rebooting at 9 AM — node-cron does
//      not replay a missed firing on its own.
//   3. Run history on disk (data/run-history.json) AND in Postgres
//      (radar_schedule_runs), so "did today's report go out" survives a
//      restart, and a run that failed because the database was down is still
//      recorded.

const fs = require('node:fs')
const path = require('node:path')
const { ROOT, config, saveConfig, q } = require('./db')

const HISTORY_PATH = path.join(ROOT, 'data', 'run-history.json')
const HISTORY_MAX = 50
const DEFAULT_TZ = 'Asia/Dhaka'
const CATCHUP_EVERY_MS = 10 * 60 * 1000   // how often the catch-up check runs
const CATCHUP_RETRY_MS = 55 * 60 * 1000   // wait this long before retrying a failed catch-up
const CATCHUP_MAX_PER_DAY = 3             // stop retrying after this many catch-up attempts
const SCAN_STALE_HOURS = 18               // re-scan before the report if data is older than this

// node-cron is the intended scheduler. If it is not installed yet, a 30-second
// tick keeps the feature working rather than silently doing nothing.
let cron = null
try { cron = require('node-cron') } catch { cron = null }

// ---- timezone helpers ------------------------------------------------------

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: String(tz) }); return true } catch { return false }
}

// Current date and clock in a given timezone. Returns { date: 'YYYY-MM-DD',
// hour, minute, minutes } where minutes is minutes since local midnight.
function zoned(tz, when = new Date()) {
  const use = validTimezone(tz) ? tz : DEFAULT_TZ
  const parts = {}
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: use, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  for (const p of f.formatToParts(when)) parts[p.type] = p.value
  const hour = Number(parts.hour) % 24
  const minute = Number(parts.minute)
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour, minute, minutes: hour * 60 + minute }
}

function parseTime(value, fallback = '09:00') {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim())
  if (!m) return parseTime(fallback, '09:00')
  const h = Number(m[1]), mi = Number(m[2])
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return parseTime(fallback, '09:00')
  return { h, m: mi, text: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`, minutes: h * 60 + mi }
}

// Absolute Date of the next occurrence of HH:MM in the given timezone.
function nextOccurrence(timeText, tz) {
  const t = parseTime(timeText)
  const now = zoned(tz)
  let delta = t.minutes - now.minutes
  if (delta <= 0) delta += 24 * 60
  const secondsIntoMinute = new Date().getSeconds()
  return new Date(Date.now() + delta * 60000 - secondsIntoMinute * 1000)
}

// ---- settings --------------------------------------------------------------

// Reads from data/config.json. Falls back to the original scanHour /
// reportHour / timezoneOffset keys so an un-migrated config still works.
function getSchedule() {
  const cfg = config()
  const s = cfg.schedule || {}
  const email = cfg.email || {}
  const tz = validTimezone(s.timezone) ? s.timezone : DEFAULT_TZ
  const report = parseTime(s.dailyTime, `${String(s.reportHour ?? 9).padStart(2, '0')}:00`)
  const scan = parseTime(s.scanTime, `${String(s.scanHour ?? 2).padStart(2, '0')}:00`)
  return {
    enabled: s.enabled !== false,
    dailyTime: report.text,
    scanTime: scan.text,
    timezone: tz,
    catchUp: s.catchUp !== false,
    autoScan: s.autoScan !== false,
    recipients: (Array.isArray(email.to) ? email.to : (email.to ? [email.to] : [])).filter(Boolean),
    cc: (Array.isArray(email.cc) ? email.cc : (email.cc ? [email.cc] : [])).filter(Boolean),
    engine: cron ? 'node-cron' : 'internal-timer',
  }
}

// Saves schedule settings and recipients, then re-arms the cron job live.
function saveSchedule(patch = {}) {
  const cur = config()
  const schedule = { ...(cur.schedule || {}) }
  const email = { ...(cur.email || {}) }

  if (patch.dailyTime != null) {
    const t = parseTime(patch.dailyTime, getSchedule().dailyTime)
    schedule.dailyTime = t.text
    schedule.reportHour = t.h          // keep the legacy key in step
  }
  if (patch.scanTime != null) {
    const t = parseTime(patch.scanTime, getSchedule().scanTime)
    schedule.scanTime = t.text
    schedule.scanHour = t.h
  }
  if (patch.timezone != null) {
    const tz = String(patch.timezone).trim()
    if (!validTimezone(tz)) return { ok: false, error: 'unknown timezone: ' + tz }
    schedule.timezone = tz
  }
  if (patch.enabled != null) schedule.enabled = Boolean(patch.enabled)
  if (patch.catchUp != null) schedule.catchUp = Boolean(patch.catchUp)
  if (patch.autoScan != null) schedule.autoScan = Boolean(patch.autoScan)

  if (Array.isArray(patch.recipients)) email.to = patch.recipients.map((x) => String(x).trim()).filter(Boolean)
  if (Array.isArray(patch.cc)) email.cc = patch.cc.map((x) => String(x).trim()).filter(Boolean)

  saveConfig({ ...cur, schedule, email })
  applySchedule()
  return { ok: true, schedule: getSchedule() }
}

// ---- run history (JSON file + Postgres) ------------------------------------

function readHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'))
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed.runs) ? parsed.runs : [])
  } catch { return [] }
}

function writeHistory(runs) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true })
    fs.writeFileSync(HISTORY_PATH, JSON.stringify({ runs: runs.slice(0, HISTORY_MAX) }, null, 2) + '\n', 'utf8')
  } catch (e) {
    console.error('[radar-schedule] could not write run history:', e.message)
  }
}

function upsertHistory(run) {
  const runs = readHistory().filter((r) => r.id !== run.id)
  runs.unshift(run)
  runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
  writeHistory(runs)
}

function tail(value, n = 600) {
  const s = String(value == null ? '' : value)
  return s.length > n ? '…' + s.slice(-n) : s
}

async function recordStart(trigger, tz) {
  const run = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    trigger,
    startedAt: new Date().toISOString(),
    localDate: zoned(tz).date,
    finishedAt: null,
    ok: null,
    message: 'running',
    error: null,
    dbId: null,
  }
  upsertHistory(run)
  // Best effort: the JSON file is the source of truth so a database outage
  // cannot hide the run that the outage itself caused to fail.
  try {
    const r = await q(
      `INSERT INTO radar_schedule_runs (trigger, started_at, local_date, status)
       VALUES ($1, now(), $2, 'running') RETURNING id`, [trigger, run.localDate])
    run.dbId = r.rows[0].id
    upsertHistory(run)
  } catch { /* table missing or db down — JSON history still has it */ }
  return run
}

async function recordFinish(run, { ok, message, error }) {
  run.finishedAt = new Date().toISOString()
  run.ok = Boolean(ok)
  run.message = tail(message, 300)
  run.error = error ? tail(error, 600) : null
  upsertHistory(run)
  if (run.dbId) {
    try {
      await q(`UPDATE radar_schedule_runs
               SET finished_at=now(), status=$2, message=$3, error=$4 WHERE id=$1`,
        [run.dbId, run.ok ? 'ok' : 'fail', run.message, run.error])
    } catch { /* ignore */ }
  }
  return run
}

function listRuns({ limit = HISTORY_MAX } = {}) {
  return readHistory().slice(0, limit)
}

function hasSuccessfulRunToday(tz) {
  const today = zoned(tz).date
  return readHistory().some((r) => r.ok === true && r.localDate === today && r.trigger !== 'scan')
}

function catchUpAttemptsToday(tz) {
  const today = zoned(tz).date
  return readHistory().filter((r) => r.trigger === 'catchup' && r.localDate === today)
}

// ---- running the pipeline --------------------------------------------------

let current = null          // in-flight run promise, or null
let currentTrigger = null
let progress = null         // { phase, done, total, current } while a run is going

function setPhase(phase, extra = {}) {
  progress = { phase, done: null, total: null, current: null, ...extra }
  console.log('[radar-schedule] ' + phase + (progress.current ? ' — ' + progress.current : ''))
}

function channelError(reportResult) {
  const ch = (reportResult && reportResult.channels) || {}
  for (const name of Object.keys(ch)) {
    const v = ch[name]
    if (v && !v.ok && v.error) return `${name}: ${v.error}`
  }
  return null
}

function summarize(out, recipients) {
  if (!out) return 'no result'
  const parts = []
  if (out.scan) parts.push(`${out.scan.sources || 0} sources, ${out.scan.changed || 0} changed, ${out.scan.newAds || 0} new ads`)
  if (out.brand && out.brand.mentions != null) parts.push(`${out.brand.mentions} mentions`)
  if (out.analyze && out.analyze.analyzed != null) parts.push(`${out.analyze.analyzed} AI-analysed`)
  if (out.report) {
    parts.push(out.report.ok
      ? `report #${out.report.id} emailed to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`
      : `email failed — ${out.report.error || channelError(out.report) || 'no channel accepted it'}`)
  }
  return parts.join(' · ') || 'completed'
}

function reportFailure(out) {
  if (!out) return 'no result returned'
  if (out.error) return out.error
  if (out.report && !out.report.ok) return out.report.error || channelError(out.report) || 'the report was built but no channel accepted it'
  if (!out.report) return 'the pipeline finished without producing a report'
  return 'unknown failure'
}

// Has anything been collected recently enough for a decision-ready report?
async function scanIsStale() {
  try {
    const r = await q(`SELECT max(captured_at) AS last FROM radar_snapshots`)
    const last = r.rows[0] && r.rows[0].last
    if (!last) return true
    return (Date.now() - new Date(last).getTime()) > SCAN_STALE_HOURS * 3600000
  } catch { return true }
}

// Logs one line per source so the console window shows movement, and keeps the
// same numbers on `progress` for the dashboard to poll.
function scanProgress({ done, total, current }) {
  progress = { phase: 'Collecting sources', done, total, current }
  if (current) console.log(`[radar-schedule] ${done + 1}/${total} ${current}`)
}

// full  — scan + brand + analyze + report (the "Run now" button, and the 9 AM
//         run when the overnight scan did not happen)
// scan  — the overnight collection pass only
// report— analyze + report over fresh data
async function execute({ trigger, mode, days, skipBrand = false, skipAnalyze = false }) {
  const s = getSchedule()
  const scheduler = require('./scheduler')   // required lazily: scheduler.js requires this file back
  const out = {}

  if (mode === 'scan') {
    setPhase('Collecting sources')
    out.scan = await scheduler.scanSources({ onProgress: scanProgress })
    setPhase('Checking brand mentions')
    out.brand = await scheduler.brandScan()
    return { out, ok: Boolean(out.scan && out.scan.ok), message:
      `${out.scan.sources || 0} sources, ${out.scan.changed || 0} changed, ${out.scan.newAds || 0} new ads, ${(out.brand && out.brand.mentions) || 0} mentions` }
  }

  const needScan = mode === 'full' || (s.autoScan && await scanIsStale())
  if (needScan) {
    setPhase('Collecting sources')
    out.scan = await scheduler.scanSources({ onProgress: scanProgress })
    if (!skipBrand) {
      setPhase('Checking brand mentions')
      out.brand = await scheduler.brandScan()
    }
  }
  if (!skipAnalyze) {
    setPhase('Running the AI analysis')
    out.analyze = await scheduler.analyze({ days: 2, limit: 10 })
  }
  setPhase('Building and emailing the report')
  out.report = await scheduler.report({ days })

  const ok = Boolean(out.report && out.report.ok)
  return { out, ok, message: summarize(out, s.recipients), error: ok ? null : reportFailure(out) }
}

// Runs the pipeline once. Concurrent calls are refused rather than queued, so
// a cron firing during a manual run can never send two emails.
function runNow({ trigger = 'manual', mode = 'full', days = 1, skipBrand = false, skipAnalyze = false } = {}) {
  if (current) {
    return Promise.resolve({ ok: false, busy: true, error: `a ${currentTrigger} run is already in progress` })
  }
  const s = getSchedule()
  currentTrigger = trigger
  current = (async () => {
    const run = await recordStart(trigger, s.timezone)
    try {
      if (mode !== 'scan' && !s.recipients.length) {
        await recordFinish(run, { ok: false, message: 'not sent', error: 'no recipients saved — add at least one email on the Schedule tab' })
        return { ok: false, run, error: 'no recipients saved' }
      }
      const r = await execute({ trigger, mode, days, skipBrand, skipAnalyze })
      await recordFinish(run, { ok: r.ok, message: r.message, error: r.error })
      console.log(`[radar-schedule] ${trigger} run ${r.ok ? 'ok' : 'FAILED'} — ${r.message}`)
      return { ok: r.ok, run, detail: r.out, error: r.error || null }
    } catch (e) {
      const err = String((e && e.stack) || e)
      await recordFinish(run, { ok: false, message: 'run failed', error: err })
      console.error('[radar-schedule] run failed:', err)
      return { ok: false, run, error: String((e && e.message) || e) }
    } finally {
      current = null
      currentTrigger = null
      progress = null
    }
  })()
  return current
}

function isRunning() { return Boolean(current) }
function runningTrigger() { return currentTrigger }

// ---- catch-up --------------------------------------------------------------

let lastCatchUpAt = 0

async function catchUpCheck({ reason = 'timer' } = {}) {
  const s = getSchedule()
  if (!s.enabled || !s.catchUp) return { ok: true, skipped: 'catch-up off' }
  if (current) return { ok: true, skipped: 'a run is already in progress' }

  const now = zoned(s.timezone)
  const target = parseTime(s.dailyTime)
  if (now.minutes < target.minutes) return { ok: true, skipped: 'today\'s time has not arrived yet' }
  if (hasSuccessfulRunToday(s.timezone)) return { ok: true, skipped: 'already sent today' }

  const attempts = catchUpAttemptsToday(s.timezone)
  if (attempts.length >= CATCHUP_MAX_PER_DAY) return { ok: true, skipped: 'catch-up attempts exhausted for today' }
  if (Date.now() - lastCatchUpAt < CATCHUP_RETRY_MS) return { ok: true, skipped: 'waiting before the next catch-up attempt' }

  lastCatchUpAt = Date.now()
  console.log(`[radar-schedule] catch-up (${reason}) — ${s.dailyTime} ${s.timezone} passed with no successful run today`)
  return runNow({ trigger: 'catchup', mode: 'full', days: 1 })
}

// ---- arming the schedule ---------------------------------------------------

let reportTask = null
let scanTask = null
let fallbackTimer = null
let catchUpTimer = null
let started = false
let lastFallbackFire = { report: '', scan: '' }

function stopTasks() {
  for (const t of [reportTask, scanTask]) {
    if (!t) continue
    try { t.stop() } catch {}
    try { if (typeof t.destroy === 'function') t.destroy() } catch {}
  }
  reportTask = null
  scanTask = null
  if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null }
}

function fallbackTick() {
  const s = getSchedule()
  if (!s.enabled) return
  const now = zoned(s.timezone)
  const clock = `${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`
  if (clock === s.dailyTime && lastFallbackFire.report !== now.date) {
    lastFallbackFire.report = now.date
    runNow({ trigger: 'schedule', mode: 'auto', days: 1 }).catch(() => {})
  }
  if (clock === s.scanTime && lastFallbackFire.scan !== now.date) {
    lastFallbackFire.scan = now.date
    runNow({ trigger: 'scan', mode: 'scan' }).catch(() => {})
  }
}

// Re-arms the cron jobs from the current settings. Called on startup and after
// every save, so a schedule change takes effect without restarting anything.
function applySchedule() {
  stopTasks()
  const s = getSchedule()
  if (!s.enabled) {
    console.log('[radar-schedule] schedule is turned off')
    return s
  }
  const report = parseTime(s.dailyTime)
  const scan = parseTime(s.scanTime)

  if (cron) {
    reportTask = cron.schedule(`${report.m} ${report.h} * * *`,
      () => { runNow({ trigger: 'schedule', mode: 'auto', days: 1 }).catch(() => {}) },
      { scheduled: true, timezone: s.timezone })
    scanTask = cron.schedule(`${scan.m} ${scan.h} * * *`,
      () => { runNow({ trigger: 'scan', mode: 'scan' }).catch(() => {}) },
      { scheduled: true, timezone: s.timezone })
    console.log(`[radar-schedule] node-cron armed — report ${s.dailyTime}, scan ${s.scanTime} (${s.timezone})`)
  } else {
    fallbackTimer = setInterval(fallbackTick, 30000)
    console.log(`[radar-schedule] node-cron is not installed — using the built-in timer for report ${s.dailyTime}, scan ${s.scanTime} (${s.timezone}). Run: npm install node-cron`)
  }
  return s
}

// Starts the scheduler inside the calling process. Safe to call twice.
function startRunner() {
  if (started) return getSchedule()
  started = true
  const s = applySchedule()
  catchUpTimer = setInterval(() => { catchUpCheck({ reason: 'timer' }).catch(() => {}) }, CATCHUP_EVERY_MS)
  setTimeout(() => { catchUpCheck({ reason: 'startup' }).catch(() => {}) }, 20000)
  return s
}

function stopRunner() {
  stopTasks()
  if (catchUpTimer) { clearInterval(catchUpTimer); catchUpTimer = null }
  started = false
}

// Everything the Schedule tab needs, in one call.
function getState() {
  const s = getSchedule()
  const runs = listRuns({ limit: HISTORY_MAX })
  const lastOk = runs.find((r) => r.ok === true && r.trigger !== 'scan') || null
  return {
    ok: true,
    schedule: s,
    running: isRunning(),
    runningTrigger: runningTrigger(),
    progress,
    nextRunAt: s.enabled ? nextOccurrence(s.dailyTime, s.timezone).toISOString() : null,
    nextScanAt: s.enabled ? nextOccurrence(s.scanTime, s.timezone).toISOString() : null,
    localNow: zoned(s.timezone),
    sentToday: hasSuccessfulRunToday(s.timezone),
    lastSuccess: lastOk,
    runs,
  }
}

module.exports = {
  startRunner, stopRunner, applySchedule,
  getSchedule, saveSchedule, getState,
  runNow, isRunning, listRuns, getProgress: () => progress,
  zoned, parseTime, nextOccurrence, validTimezone,
  hasSuccessfulRunToday, catchUpCheck,
}
