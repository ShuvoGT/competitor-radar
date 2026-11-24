'use strict'

// Collection + change engine: fetch a source, normalise visible text, hash it,
// diff against the previous snapshot and score the change.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { ROOT, q, config } = require('./db')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 CompetitorRadar/0.1'

const PRICE_RE = /\b(price|pricing|discount|offer|free trial|trial|deal|save|৳|bdt|usd|\$|%)\b/i
const CTA_RE = /\b(demo|contact|sign\s?up|start|try|book|download|subscribe|get started)\b/i

const MOJI = '\u251c\u252c\u2563\u2557\u2550\u2500\u00c2\u00c3\u00e2\u00e9\u0393\u00c7\u00a3\u00a5\u00e4\u00f3\u00ed\u20ac\u2122\u0153\u017e\u0161\u201a\u201e\u2026\u2020\u2021\u2030\u2039\u203a\u02c6\u02dc'
const MOJI_RE = new RegExp(`[${MOJI}][${MOJI}\u0080-\u009f\u2013\u2014\u2018\u2019\u201c\u201d\u00bf\u00a1]*`, 'g')

function cleanMojibake(s) {
  return String(s || '').replace(MOJI_RE, ' ').replace(/[\u0080-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r/g, '').replace(/\t/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 1)
    .filter((l) => !/^\d{1,2}:\d{2}(:\d{2})?$/.test(l))
    .filter((l) => !/^\d{4}[-/]\d{2}[-/]\d{2}/.test(l))
    .filter((l) => !/^[\d.,%৳$]+$/.test(l) || l.length > 5)
    .join('\n')
}

function diffLines(a, b) {
  const A = new Set(String(a || '').split('\n').map((s) => s.trim()).filter(Boolean))
  const B = new Set(String(b || '').split('\n').map((s) => s.trim()).filter(Boolean))
  return { added: [...B].filter((x) => !A.has(x)), removed: [...A].filter((x) => !B.has(x)) }
}

function scoreChange(added, removed) {
  const text = [...added, ...removed].join(' \n ')
  let score = 30
  const flags = []
  if (PRICE_RE.test(text)) { score += 25; flags.push('pricing/offer') }
  if (CTA_RE.test(text)) { score += 15; flags.push('cta') }
  const n = added.length + removed.length
  if (n >= 8) { score += 20; flags.push('positioning') }
  else if (n >= 3) { score += 10; flags.push('content') }
  if (added.length >= 12) { score += 10; flags.push('novelty') }
  score = Math.min(100, score)
  const severity = score >= 80 ? 'critical' : score >= 60 ? 'high' : score >= 40 ? 'medium' : 'low'
  const kind = flags.includes('pricing/offer') ? 'pricing' : flags.includes('cta') ? 'cta' : 'text'
  return { score, severity, flags, kind }
}

// A "change" that is really just UI chrome re-rendering — a rotating word, a
// typing effect, a spinner — flips a short line to a near-identical one. Real
// copy edits, price moves and new sections never look like that. When every
// added line is a near-copy of a removed line (and vice versa), drop it as noise.
function _nearCopy(a, b) {
  a = String(a || '').trim().toLowerCase()
  b = String(b || '').trim().toLowerCase()
  const n = Math.min(a.length, b.length)
  if (n < 8) return a === b
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i / Math.max(a.length, b.length, 1) >= 0.6
}
function isNoiseDiff(added, removed) {
  const A = (added || []).map((s) => String(s || '').trim()).filter(Boolean)
  const R = (removed || []).map((s) => String(s || '').trim()).filter(Boolean)
  if (!A.length || !R.length) return false
  return A.every((a) => R.some((b) => _nearCopy(a, b))) && R.every((b) => A.some((a) => _nearCopy(a, b)))
}

function htmlToText(html) {
  let cheerio
  try { cheerio = require('cheerio') } catch { return String(html || '').replace(/<[^>]+>/g, '\n') }
  const $ = cheerio.load(String(html || ''))
  $('script,style,noscript,svg,iframe,head,template').remove()
  $('br').replaceWith('\n')
  $('p,div,li,h1,h2,h3,h4,h5,h6,tr,td,th,section,article,header,footer,nav,ul,ol,table,blockquote,label,option,figcaption')
    .each((_, el) => { $(el).append('\n') })
  return $('body').text()
}

// Which Python runs scripts/fbfetch.py. The path set in Config wins, then the
// RADAR_PYTHON env var, then a venv inside this project. The old hard-coded
// path to a different project is kept last so an existing setup keeps working.
function findPython() {
  const cands = [
    (config().python || {}).bin,
    process.env.RADAR_PYTHON,
    path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(ROOT, '.venv', 'bin', 'python'),
    path.join(ROOT, '..', 'OpenMontage', '.venv', 'Scripts', 'python.exe'),
    path.join(ROOT, '..', 'OpenMontage', '.venv', 'bin', 'python'),
  ]
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c } catch {} }
  return process.platform === 'win32' ? 'python' : 'python3'
}

function chromeEnv() {
  const out = {}
  try {
    const c = config().chrome || {}
    if (c.userDataDir) out.RADAR_CHROME_PROFILE = c.userDataDir
    if (c.profileDirectory) out.RADAR_CHROME_PROFILE_DIR = c.profileDirectory
    if (c.bin) out.CHROME_BIN = c.bin
  } catch {}
  return out
}

// Chrome allows one process per profile folder. While a capture or a signed-in
// window holds it, a second Chrome on the same folder fails and the page comes
// back empty — so check before starting either one.
function profileBusy() {
  const dir = (config().chrome || {}).userDataDir
  if (!dir) return false
  for (const name of ['lockfile', 'SingletonLock']) {
    const p = path.join(dir, name)
    try {
      if (!fs.existsSync(p)) continue
      fs.closeSync(fs.openSync(p, 'r+'))     // Windows refuses while Chrome holds it
    } catch (e) {
      if (e && ['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) return true
    }
  }
  return false
}

// Runs scripts/fbfetch.py and returns its JSON. Always listens for a start-up
// error: an unhandled 'error' event on a child process takes the whole
// dashboard down with it.
function runFetcher(args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const py = findPython()
    const script = path.join(ROOT, 'scripts', 'fbfetch.py')
    if (!fs.existsSync(script)) return resolve({ ok: false, error: 'scripts/fbfetch.py is missing' })
    let child
    try { child = spawn(py, [script, ...args], { windowsHide: true, env: { ...process.env, ...chromeEnv() } }) }
    catch (e) { return resolve({ ok: false, error: `could not start Python (${py}): ${e.message}` }) }
    let out = '', err = '', done = false
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r) }
    const timer = setTimeout(() => { try { child.kill() } catch {} ; finish({ ok: false, error: 'timed out' }) }, timeout)
    child.on('error', (e) => finish({ ok: false, error: `Python did not start (${py}): ${e.message}. Set the Python path in Config.` }))
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('close', () => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || ''
      try { finish(JSON.parse(line)) }
      catch { finish({ ok: false, error: (err || out).trim().slice(-250) || 'the fetcher returned nothing' }) }
    })
  })
}

// Which renderer to use. Playwright drives a real browser and can wait for a
// page to finish, which --dump-dom cannot. It is preferred whenever it is
// installed; the original fetcher stays as the fallback.
let _pwAvailable = null
function playwrightAvailable() {
  if (_pwAvailable !== null) return _pwAvailable
  try {
    const r = require('node:child_process').spawnSync(findPython(), ['-c', 'import playwright'], { windowsHide: true, timeout: 20000 })
    _pwAvailable = r.status === 0
  } catch { _pwAvailable = false }
  return _pwAvailable
}
function resetEngineCache() { _pwAvailable = null }

function renderEngine() {
  const c = config().chrome || {}
  const choice = String(c.engine || 'auto').toLowerCase()
  if (choice === 'playwright') return 'playwright'
  if (choice === 'dump-dom' || choice === 'chrome') return 'dump-dom'
  return playwrightAvailable() ? 'playwright' : 'dump-dom'
}

function fetchRendered(url, wait = 15, withMedia = false, capture = null, posts = false) {
  return new Promise((resolve) => {
    const py = findPython()
    const engine = renderEngine()
    const scriptName = engine === 'playwright' ? 'pwfetch.py' : 'fbfetch.py'
    const script = path.join(ROOT, 'scripts', scriptName)
    if (!fs.existsSync(script)) return resolve({ text: '', error: scriptName + ' is missing' })
    const args = [script, '--url', url, '--wait', String(wait)]
    if (withMedia) args.push('--media')
    // Only the Playwright fetcher supports response capture (Google Ads data call).
    if (capture && engine === 'playwright') args.push('--capture', capture)
    // Only the Playwright fetcher can extract per-post permalinks + engagement.
    if (posts && engine === 'playwright') args.push('--posts')
    if (engine === 'playwright' && (config().chrome || {}).headless === false) args.push('--headful')
    let out = '', err = ''
    let child
    // Pass the authenticated Chrome profile (if configured) to the fetcher via env.
    let chromeEnv = {}
    try {
      const c = config().chrome || {}
      if (c.userDataDir) chromeEnv.RADAR_CHROME_PROFILE = c.userDataDir
      if (c.profileDirectory) chromeEnv.RADAR_CHROME_PROFILE_DIR = c.profileDirectory
      if (c.bin) chromeEnv.CHROME_BIN = c.bin
    } catch {}
    try { child = spawn(py, args, { windowsHide: true, env: { ...process.env, ...chromeEnv } }) }
    catch (e) { return resolve({ text: '', error: 'spawn: ' + e.message }) }
    const timer = setTimeout(() => { try { child.kill() } catch {} ; resolve({ text: '', error: 'render timeout' }) }, 150000)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); resolve({ text: '', error: 'python: ' + e.message }) })
    child.on('close', () => {
      clearTimeout(timer)
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || ''
      try {
        const j = JSON.parse(line)
        if (j && j.ok === false) return resolve({ text: '', error: String(j.error || 'render failed').slice(0, 200) })
        resolve({ text: normalizeText(j.text || ''), title: j.title || '', media: j.media || [], captured: j.captured || [], posts: Array.isArray(j.posts) ? j.posts : [], httpStatus: 200 })
      }
      catch { resolve({ text: '', error: (err || out).trim().slice(-200) || 'render produced no JSON' }) }
    })
  })
}

// Reliable Facebook post reader: runs scripts/fbmobile.py (mbasic.facebook.com)
// against the signed-in profile and returns { posts: [{url, text, posted_at,
// reactions, comments, shares, engagement}] }. Never throws — a failure just
// yields no posts, leaving the page-diff content untouched.
function fetchFbMobile(url, wait = 20) {
  return new Promise((resolve) => {
    const py = findPython()
    const script = path.join(ROOT, 'scripts', 'fbmobile.py')
    if (!fs.existsSync(script)) return resolve({ posts: [], error: 'scripts/fbmobile.py is missing' })
    const args = [script, '--url', url, '--wait', String(wait)]
    if ((config().chrome || {}).headless === false) args.push('--headful')
    let out = '', err = ''
    let child
    const cenv = {}
    try {
      const c = config().chrome || {}
      if (c.userDataDir) cenv.RADAR_CHROME_PROFILE = c.userDataDir
      if (c.profileDirectory) cenv.RADAR_CHROME_PROFILE_DIR = c.profileDirectory
      if (c.bin) cenv.CHROME_BIN = c.bin
    } catch {}
    try { child = spawn(py, args, { windowsHide: true, env: { ...process.env, ...cenv } }) }
    catch (e) { return resolve({ posts: [], error: 'spawn: ' + e.message }) }
    const timer = setTimeout(() => { try { child.kill() } catch {} ; resolve({ posts: [], error: 'fbmobile timeout' }) }, 150000)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); resolve({ posts: [], error: 'python: ' + e.message }) })
    child.on('close', () => {
      clearTimeout(timer)
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || ''
      try {
        const j = JSON.parse(line)
        if (j && j.ok === false) return resolve({ posts: [], error: String(j.error || 'fbmobile failed').slice(0, 200) })
        resolve({ posts: Array.isArray(j.posts) ? j.posts : [] })
      } catch { resolve({ posts: [], error: (err || out).trim().slice(-200) || 'fbmobile produced no JSON' }) }
    })
  })
}

async function fetchPlain(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' })
    const ct = res.headers.get('content-type') || ''
    const body = await res.text()
    const text = (ct.includes('html') || /<html/i.test(body.slice(0, 800))) ? htmlToText(body) : body
    return { text: normalizeText(text), httpStatus: res.status }
  } catch (e) { return { text: '', error: String(e.message || e).slice(0, 200) } }
}

// Reddit via the public JSON API (no login, far more reliable than the search HTML).
// Accepts our stored search/subreddit URLs and derives the .json endpoint.
async function fetchReddit(url) {
  try {
    const u = new URL(url)
    let api
    const q = u.searchParams.get('q')
    if (q) {
      const sort = u.searchParams.get('sort') || 'new'
      api = `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=${encodeURIComponent(sort)}&limit=30&raw_json=1`
    } else {
      api = url.replace(/\/?$/, '').replace(/\.json$/, '') + '.json?limit=30&raw_json=1'
    }
    const res = await fetch(api, { headers: { 'User-Agent': UA, Accept: 'application/json' }, redirect: 'follow' })
    if (!res.ok) return { text: '', error: `reddit http ${res.status}`, httpStatus: res.status }
    const j = await res.json()
    const kids = (j && j.data && Array.isArray(j.data.children)) ? j.data.children : []
    const lines = []
    for (const k of kids) {
      const d = (k && k.data) || {}
      const body = String(d.title || '') + (d.selftext ? '. ' + d.selftext : '')
      const meta = `r/${d.subreddit || '?'} · u/${d.author || '?'} · ${d.ups || 0} up · ${d.num_comments || 0} comments`
      const line = `${body.replace(/\s+/g, ' ').trim().slice(0, 500)} (${meta}) ${d.permalink ? 'https://www.reddit.com' + d.permalink : ''}`.trim()
      if (line.length > 10) lines.push(line)
    }
    return { text: normalizeText(lines.join('\n')), httpStatus: res.status, raw: { count: kids.length } }
  } catch (e) { return { text: '', error: 'reddit: ' + String(e.message || e).slice(0, 160) } }
}

// Open a visible Chrome on the persistent profile so the user can sign in once.
// fbfetch.py starts Chrome and exits, so this resolves in a second or two and
// reports what actually happened instead of assuming success.
async function launchLoginBrowser() {
  const c = config().chrome || {}
  if (!c.userDataDir) return { ok: false, error: 'Set the Chrome profile folder in Config first, then save.' }
  if (profileBusy()) {
    return { ok: false, busy: true, error: 'That Chrome profile is in use right now — a capture is running, or a login window is already open. Wait for the run to finish, or close the other Chrome window, then try again.' }
  }
  const args = ['--login', '--user-data-dir', c.userDataDir]
  if (c.profileDirectory) args.push('--profile-directory', c.profileDirectory)
  const r = await runFetcher(args, { timeout: 25000 })
  if (!r.ok) return { ok: false, error: r.error || 'Chrome did not open.' }
  return { ok: true, profile: c.userDataDir }
}

// Install Playwright with the configured Python. Only ever runs when asked
// for from the dashboard — nothing installs itself.
function installPlaywright({ onLine = null, timeout = 420000 } = {}) {
  return new Promise((resolve) => {
    const py = findPython()
    let child
    const args = ['-m', 'pip', 'install', '--disable-pip-version-check', 'playwright']
    try { child = spawn(py, args, { windowsHide: true }) }
    catch (e) { return resolve({ ok: false, error: `could not start Python (${py}): ${e.message}` }) }

    let out = '', done = false
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); resolve(r) }
    const t = setTimeout(() => { try { child.kill() } catch {} ; finish({ ok: false, error: 'the install took too long and was stopped', log: out.slice(-1500) }) }, timeout)
    child.on('error', (e) => finish({ ok: false, error: `Python did not start (${py}): ${e.message}. Set the Python path in Config.` }))
    const take = (d) => {
      const chunk = d.toString()
      out += chunk
      if (onLine) { try { onLine((chunk.trim().split(/\r?\n/).filter(Boolean).pop() || '').slice(0, 160)) } catch {} }
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('close', (code) => {
      resetEngineCache()
      const ok = code === 0 && playwrightAvailable()
      let error = null
      if (!ok) {
        const log = out.toLowerCase()
        error = code !== 0 ? `pip exited with code ${code}` : 'pip finished but Playwright still cannot be imported'
        if (/permission denied|access is denied|winerror 5/.test(log)) error += ' — try running Radar as administrator, or install with the --user flag'
        else if (/no module named pip/.test(log)) error += ' — that Python has no pip. Point Config at a full Python install.'
        else if (/could not find a version|no matching distribution|connection|proxy|timed out/.test(log)) error += ' — this PC could not reach the package index. Check the network or proxy.'
      }
      finish({ ok, code, python: py, log: out.slice(-2500), error })
    })
  })
}

// Wipe the signed-in Chrome profile so it can be set up again from scratch.
// Deleting the wrong folder here would be destructive, so the path has to look
// like a Chrome profile and must not be a drive root, a home folder, or the
// project itself.
function clearChromeProfile() {
  const dir = (config().chrome || {}).userDataDir
  if (!dir) return { ok: false, error: 'No Chrome profile folder is set in Config.' }
  let abs
  try { abs = path.resolve(String(dir)) } catch { return { ok: false, error: 'That profile path is not valid.' } }
  if (!fs.existsSync(abs)) return { ok: false, error: 'That folder does not exist: ' + abs }

  const parsed = path.parse(abs)
  const depth = abs.split(/[\\/]/).filter(Boolean).length
  if (abs === parsed.root || depth < 3) return { ok: false, error: 'Refusing to clear ' + abs + ' — it is too close to the drive root.' }
  if (path.resolve(ROOT) === abs) return { ok: false, error: 'Refusing to clear the project folder itself.' }
  for (const marker of ['package.json', 'src', 'node_modules']) {
    if (fs.existsSync(path.join(abs, marker))) return { ok: false, error: 'Refusing to clear ' + abs + ' — it looks like a code folder, not a Chrome profile.' }
  }

  let entries = []
  try { entries = fs.readdirSync(abs) } catch (e) { return { ok: false, error: 'Could not read that folder: ' + e.message } }
  const looksLikeProfile = entries.length === 0 ||
    entries.some((n) => ['Local State', 'Default', 'First Run', 'Last Version', 'lockfile'].includes(n))
  if (!looksLikeProfile) return { ok: false, error: 'Refusing to clear ' + abs + ' — it does not look like a Chrome profile folder.' }

  if (profileBusy()) return { ok: false, busy: true, error: 'Chrome still has that profile open. Close every Chrome window using it, wait for any run to finish, then try again.' }

  let removed = 0
  const failed = []
  for (const name of entries) {
    if (name === 'README.txt') continue                 // keep the note explaining the folder
    try { fs.rmSync(path.join(abs, name), { recursive: true, force: true }); removed++ }
    catch (e) { failed.push(name + ' (' + (e.code || e.message) + ')') }
  }
  if (failed.length) {
    return { ok: false, removed, error: 'Some files are still locked by Chrome: ' + failed.slice(0, 4).join(', ') + (failed.length > 4 ? ` and ${failed.length - 4} more` : '') + '. Close Chrome and try again.' }
  }
  return { ok: true, dir: abs, removed }
}

// Is Python there, is Chrome there, is the profile there and free?
async function checkTools() {
  const py = findPython()
  const c = config().chrome || {}
  const out = {
    python: { path: py, ok: false, version: null, error: null },
    chrome: { path: c.bin || null, ok: false, error: null },
    fetcher: { path: path.join(ROOT, 'scripts', 'fbfetch.py'), ok: false },
    profile: { dir: c.userDataDir || null, exists: false, busy: false },
  }
  out.fetcher.ok = fs.existsSync(out.fetcher.path)
  try { out.profile.exists = Boolean(c.userDataDir && fs.existsSync(c.userDataDir)) } catch {}
  out.profile.busy = profileBusy()

  const ver = await new Promise((resolve) => {
    let child
    try { child = spawn(py, ['-V'], { windowsHide: true }) }
    catch (e) { return resolve({ ok: false, error: e.message }) }
    let txt = '', done = false
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); resolve(r) }
    const t = setTimeout(() => { try { child.kill() } catch {} ; finish({ ok: false, error: 'no response' }) }, 10000)
    child.on('error', (e) => finish({ ok: false, error: e.message }))
    child.stdout.on('data', (d) => { txt += d.toString() })
    child.stderr.on('data', (d) => { txt += d.toString() })
    child.on('close', (code) => finish({ ok: code === 0 && /python/i.test(txt), version: txt.trim().slice(0, 60), error: code === 0 ? null : 'exit code ' + code }))
  })
  out.python.ok = Boolean(ver.ok)
  out.python.version = ver.version || null
  out.python.error = ver.ok ? null : (ver.error || 'not a working Python. Set the path in Config.')

  out.engine = { name: renderEngine(), playwrightInstalled: playwrightAvailable() }
  out.fetcher.playwright = fs.existsSync(path.join(ROOT, 'scripts', 'pwfetch.py'))
  if (out.python.ok && out.fetcher.ok) {
    const w = await runFetcher(['--which'], { timeout: 15000 })
    out.chrome.ok = Boolean(w && w.ok && w.chrome)
    out.chrome.path = (w && w.chrome) || out.chrome.path
    out.chrome.error = out.chrome.ok ? null : ((w && w.error) || 'Chrome not found. Set the Chrome path in Config.')
  } else {
    out.chrome.error = 'skipped — Python or the fetcher is not available'
  }
  return out
}

// 3. Prove the signed-in profile actually works. Each page is rendered through
// the same headless path a scan uses; the title is the clearest tell, since a
// logged-out page keeps the site's generic title.
// Cloudflare and friends show an interstitial before the real page. That is
// not a login problem and must not be reported as one.
const CHALLENGE_RE = /just a moment|checking your browser|verifying you are human|attention required|cf-browser-verification|enable javascript and cookies|please wait while we verify/i

// An unread badge in the title — "(2) Watch trending videos…" — is only ever
// rendered for a signed-in user, on every one of these sites.
const COUNT_TITLE_RE = /^\(\d+\)/

const AUTH_SITES = [
  { site: 'Facebook',  url: 'https://www.facebook.com/me',              wait: 22,
    signedIn:  /what.s on your mind|news feed|friend requests|create (a )?post|add to story|your profile|see all friends/i,
    loggedOut: /log in or sign up|log into facebook|create new account|forgotten password|forgot password/i },
  { site: 'Instagram', url: 'https://www.instagram.com/accounts/edit/', wait: 22,
    signedIn:  /edit profile|personal information|change password|profile photo|account privacy/i,
    loggedOut: /phone number, username|log ?in .{0,3} instagram|forgot password|sign up.{0,20}see photos/i },
  { site: 'LinkedIn',  url: 'https://www.linkedin.com/feed/',           wait: 22,
    signedIn:  /start a post|my network|messaging|feed \| linkedin|post impressions/i,
    loggedOut: /linkedin login|join linkedin|sign in \| linkedin|new to linkedin|agree & join/i },
  { site: 'X',         url: 'https://x.com/home',                       wait: 22,
    signedIn:  /home \/ x|what is happening|post a reply|for you.{0,60}following/i,
    loggedOut: /log in to x|sign up for x|it.s what.s happening|create your account/i },
  { site: 'TikTok',    url: 'https://www.tiktok.com/foryou',            wait: 26,
    signedIn:  /log ?out|upload video|your account|inbox|following.{0,40}friends|switch account/i,
    loggedOut: /log in to follow|sign up for tiktok|phone \/ email \/ username|use phone or email/i },
  { site: 'YouTube',   url: 'https://www.youtube.com/account',          wait: 24,
    signedIn:  /account settings|your channel|manage your google account|view advanced settings|channel status and features/i,
    loggedOut: /sign in .{0,12}google accounts|to continue to youtube|use your google account|forgot email|create account/i },
  { site: 'Quora',     url: 'https://www.quora.com/',                   wait: 30,
    signedIn:  /add question|your content|answer requests|notifications|post to/i,
    loggedOut: /a place to share knowledge and better understand|continue with google|sign up with email|by continuing you indicate/i },
]

async function testAuthCapture({ onProgress = null } = {}) {
  const c = config().chrome || {}
  if (!c.userDataDir) return { ok: false, error: 'Set the Chrome profile folder in Config first.' }
  if (profileBusy()) return { ok: false, busy: true, error: 'That Chrome profile is in use right now. Wait for the run to finish, or close the login window.' }
  const rows = []
  const tick = (done, current) => { if (onProgress) { try { onProgress({ done, total: AUTH_SITES.length, current }) } catch {} } }
  for (let i = 0; i < AUTH_SITES.length; i++) {
    const s = AUTH_SITES[i]
    tick(i, s.site)
    const r = await fetchRendered(s.url, s.wait)
    if (r.error) { rows.push({ site: s.site, ok: false, signedIn: null, title: null, note: r.error }); continue }
    if (String(r.text || '').trim().length < 40) {
      rows.push({ site: s.site, ok: false, signedIn: null, verdict: 'blocked', title: r.title || null, note: 'Chrome rendered nothing — this site blocked the headless browser' })
      continue
    }
    // A signed-in verdict needs positive proof, not merely the absence of a
    // login prompt. Without that, any odd page reads as "signed in".
    const title = String(r.title || '').trim()
    const hay = `${title}\n${String(r.text || '').slice(0, 4000)}`
    const positive = s.signedIn.test(hay)
    const negative = s.loggedOut.test(hay)
    const counted = COUNT_TITLE_RE.test(title)          // unread badge = signed in

    let verdict
    if (CHALLENGE_RE.test(hay)) verdict = 'challenge'
    else if (counted && !negative) verdict = 'signed-in'
    else if (positive && !negative) verdict = 'signed-in'
    else if (negative) verdict = 'login'
    else verdict = 'unclear'

    rows.push({
      site: s.site, ok: true, signedIn: verdict === 'signed-in', verdict,
      title: title.slice(0, 120),
      note: verdict === 'signed-in' ? (counted ? 'signed in — unread count in the page title' : 'signed in')
        : verdict === 'login' ? 'login wall — sign in again through the login browser'
        : verdict === 'challenge' ? 'a bot check (Cloudflare) blocked the page before it loaded'
        : 'the page loaded but showed no sign of being signed in',
    })
  }
  tick(AUTH_SITES.length, null)
  return { ok: true, rows }
}

async function fetchSource(src) {
  if (src.kind === 'reddit') {
    const j = await fetchReddit(src.url)
    if (j.text) return j                       // JSON API worked (preferred)
    return fetchRendered(src.url, 12)           // blocked? fall back to headless render
  }
  if (src.kind === 'google_ads') {
    // Google Ads Transparency shows ads as images and loads them over the
    // network, so reading the page text returns nothing. Capture the data call
    // (SearchService) instead and parse the ads out of it.
    return fetchRendered(src.url, 26, false, 'SearchService')
  }
  if (src.render) {
    // JS-heavy social pages need longer to render before we read the text.
    const wait = src.kind === 'meta_adlib' ? 18
      : ['quora', 'x', 'instagram', 'tiktok', 'threads', 'linkedin', 'facebook'].includes(src.kind) ? 22 : 12
    // Facebook: get the page text for the diff AND the app-feed posts. Combined
    // in snapshot with the mobile-HTML capture for maximum permalink coverage.
    return fetchRendered(src.url, wait, src.kind === 'meta_adlib', null, src.kind === 'facebook')
  }
  // Plain fetch first. If a bot wall (e.g. Akamai/Cloudflare) returns almost
  // nothing, retry through headless Chrome, which passes most challenges.
  const p = await fetchPlain(src.url)
  if ((p.text || '').length >= 300) return p
  const r = await fetchRendered(src.url, 12)
  return ((r.text || '').length > (p.text || '').length) ? r : p
}

// Social pages that come back as a login/consent wall or an almost-empty shell
// must be recorded as a failed read, not a healthy "quiet" capture — otherwise
// the report shows "no activity" when Radar simply could not see the feed.
const SOCIAL_WALL_KINDS = new Set(['facebook', 'instagram', 'linkedin', 'x', 'tiktok', 'threads', 'pinterest', 'youtube', 'quora'])
const LOGIN_WALL_RE = /(log ?in to|sign in to|create (a )?new account|you must log in|log in to continue|sign in to continue|join linkedin|see more on facebook|content isn.?t available|page isn.?t available|this content isn.?t available|enable javascript|before you continue|you.?re not signed in)/i

// Store individual social posts (exact permalink + engagement) captured from a
// rendered page. Upsert by (competitor, url); refresh engagement on re-sight so
// "best traction" reflects the latest counts. Returns how many were new.
async function saveSocialPosts(src, posts) {
  if (!Array.isArray(posts) || !posts.length) return 0
  let created = 0
  for (const p of posts) {
    const url = String((p && p.url) || '').trim()
    if (!url) continue
    try {
      const r = await q(
        `INSERT INTO radar_social_posts
           (source_id, competitor, platform, url, text, posted_at, reactions, comments, shares, engagement)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (competitor, url) DO UPDATE
           SET text = COALESCE(NULLIF(excluded.text,''), radar_social_posts.text),
               posted_at = COALESCE(radar_social_posts.posted_at, excluded.posted_at),
               reactions = GREATEST(COALESCE(excluded.reactions,0), COALESCE(radar_social_posts.reactions,0)),
               comments  = GREATEST(COALESCE(excluded.comments,0),  COALESCE(radar_social_posts.comments,0)),
               shares    = GREATEST(COALESCE(excluded.shares,0),    COALESCE(radar_social_posts.shares,0)),
               engagement = GREATEST(COALESCE(excluded.engagement,0), COALESCE(radar_social_posts.engagement,0)),
               last_seen = now()
         RETURNING (xmax = 0) AS inserted`,
        [src.id, src.competitor, src.kind, url.slice(0, 1000), String(p.text || '').slice(0, 1400),
         p.posted_at || null, p.reactions ?? null, p.comments ?? null, p.shares ?? null, p.engagement ?? null])
      if (r.rows[0] && r.rows[0].inserted) created++
    } catch { /* table may not exist until schema is applied — ignore */ }
  }
  return created
}

// Fetch + store a snapshot; return { ok, changed, text, media, error }.
async function snapshot(src) {
  const f = await fetchSource(src)
  const text = f.text || ''
  let status = f.error ? 'error' : 'ok'
  let error = f.error || null
  if (status === 'ok' && SOCIAL_WALL_KINDS.has(src.kind)) {
    const t = text.trim()
    if (t.length < 220 || LOGIN_WALL_RE.test(t.slice(0, 1500))) {
      status = 'error'
      error = 'login wall or blocked — sign in the capture browser, or connect the real profile handle'
    }
  }
  // An empty capture is a failed load, never a real "everything was removed".
  if (status === 'ok' && text.trim().length === 0) {
    status = 'error'
    error = 'the page rendered empty — it was blocked or failed to load'
  }
  const hash = crypto.createHash('sha256').update(text).digest('hex')
  const prev = await q(`SELECT id, text, content_hash FROM radar_snapshots WHERE source_id=$1 AND status='ok' ORDER BY captured_at DESC LIMIT 1`, [src.id])
  const prevRow = prev.rows[0] || null
  await q(`INSERT INTO radar_snapshots (source_id, status, http_status, text, content_hash, error) VALUES ($1,$2,$3,$4,$5,$6)`,
    [src.id, status, f.httpStatus || null, text.slice(0, 400000), hash, error])
  // Save individual posts with their exact permalink. For Facebook we combine
  // TWO captures for maximum coverage: the mobile-HTML reader (mbasic, clean
  // permalinks) and the app-feed extraction (f.posts). Deduped by URL, so every
  // post either capture sees gets its exact link.
  let newPosts = 0
  if (src.kind === 'facebook') {
    const byUrl = new Map()
    for (const p of (Array.isArray(f.posts) ? f.posts : [])) { if (p && p.url) byUrl.set(p.url, p) }
    if (renderEngine() === 'playwright') {
      try {
        const fm = await fetchFbMobile(src.url)
        for (const p of (fm.posts || [])) {
          if (!p || !p.url) continue
          const ex = byUrl.get(p.url)
          // Prefer whichever capture has the longer text / engagement counts.
          if (!ex || String(p.text || '').length > String(ex.text || '').length) byUrl.set(p.url, { ...ex, ...p })
        }
      } catch { /* ignore capture errors — page-diff content is unaffected */ }
    }
    const merged = [...byUrl.values()]
    if (merged.length) newPosts = await saveSocialPosts(src, merged)
  } else if (Array.isArray(f.posts) && f.posts.length) {
    newPosts = await saveSocialPosts(src, f.posts)
  }
  return { ok: status === 'ok', changed: Boolean(prevRow && prevRow.content_hash !== hash), text, prevText: prevRow ? prevRow.text : '', media: f.media || [], posts: f.posts || [], newPosts, error }
}

function scoreAndRecord({ sourceId, competitor, product, kind, added, removed, beforeText, afterText }) {
  const { score, severity, flags, kind: k } = scoreChange(added, removed)
  return q(`INSERT INTO radar_changes (source_id, competitor, product, kind, severity, score, summary, before_text, after_text, diff)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [sourceId, competitor, product, kind || k, severity, score,
     `${added.length} added / ${removed.length} removed (${competitor || ''})`.trim(),
     String(beforeText || '').slice(0, 4000), String(afterText || '').slice(0, 4000),
     JSON.stringify({ added: added.slice(0, 60), removed: removed.slice(0, 60), flags })])
}

module.exports = {
  UA, normalizeText, diffLines, scoreChange, isNoiseDiff, htmlToText, cleanMojibake,
  fetchSource, fetchRendered, fetchFbMobile, fetchPlain, fetchReddit, launchLoginBrowser, snapshot, scoreAndRecord, saveSocialPosts,
  findPython, profileBusy, checkTools, testAuthCapture, clearChromeProfile,
  renderEngine, playwrightAvailable, resetEngineCache, installPlaywright,
}
