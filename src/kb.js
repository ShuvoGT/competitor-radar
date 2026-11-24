'use strict'

// Knowledge base — a git checkout of the company KB (default: ibos-kb).
//
// The KB is cloned into data/kb and refreshed before the Claude CLI is asked
// anything, so competitor suggestions and change analysis are grounded in our
// own positioning, products and known competitor list instead of the model's
// general knowledge.
//
// It is read-only: Radar never pushes. A private repo needs either a token in
// Config, or git credentials already set up on this machine.

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { ROOT, config } = require('./db')

const STATE_PATH = path.join(ROOT, 'data', 'kb-state.json')
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.yml', '.yaml', '.csv', '.tsv'])
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github', 'images', 'img', 'assets', '.obsidian'])
const DEFAULT_REPO = 'https://gitlab.ibos.io/ibos-kb/ibos-kb'
const MAX_FILE_BYTES = 200_000
const MAX_FILES = 400

// Which host this is, so the token is sent the way that host expects.
// GitLab wants oauth2:<token>, GitHub wants x-access-token:<token>.
// 'auto' works it out from the URL, so switching hosts later is just a URL
// change plus the matching token.
function detectProvider(repo) {
  let host = ''
  try { host = new URL(repo).hostname.toLowerCase() } catch { return 'generic' }
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github'
  if (host === 'gitlab.com' || host.includes('gitlab')) return 'gitlab'
  return 'generic'
}

function settings() {
  const k = (config().kb || {})
  const repoUrl = String(k.repo || DEFAULT_REPO).trim().replace(/\.git$/, '')
  const chosen = String(k.provider || 'auto').toLowerCase()
  return {
    enabled: k.enabled !== false,
    repo: repoUrl,
    provider: ['github', 'gitlab', 'generic'].includes(chosen) ? chosen : detectProvider(repoUrl),
    providerSetting: chosen,
    branch: String(k.branch || '').trim() || null,     // null = the repo default
    dir: k.dir ? String(k.dir) : path.join(ROOT, 'data', 'kb'),
    token: k.token || (k.tokenEnv ? process.env[k.tokenEnv] : '') || process.env.IBOS_KB_TOKEN || '',
    maxChars: Number(k.maxChars) > 0 ? Number(k.maxChars) : 12000,
    refreshHours: Number(k.refreshHours) >= 0 ? Number(k.refreshHours) : 6,
  }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) } catch { return {} }
}
function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
    fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n', 'utf8')
  } catch {}
}

// A token turns the https URL into an authenticated one. It is never written to
// disk by us and never logged — git stores nothing because we clone with it in
// the URL and then rewrite the remote back to the clean form.
function authUrl(repo, token, provider = 'generic') {
  if (!token) return repo + '.git'
  try {
    const u = new URL(repo)
    if (provider === 'gitlab') u.username = 'oauth2'
    else if (provider === 'github') u.username = 'x-access-token'
    else u.username = 'git'
    u.password = token
    return u.toString() + '.git'
  } catch { return repo + '.git' }
}

function hideToken(text, token) {
  if (!token) return text
  return String(text || '').split(token).join('***')
}

// git, with an error listener so a missing git can never crash the dashboard.
function git(args, { cwd = null, timeout = 120000, token = '' } = {}) {
  return new Promise((resolve) => {
    let child
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
    try { child = spawn('git', args, { cwd: cwd || undefined, windowsHide: true, env }) }
    catch (e) { return resolve({ ok: false, error: 'git could not start: ' + e.message }) }
    let out = '', err = '', done = false
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); resolve(r) }
    const t = setTimeout(() => { try { child.kill() } catch {} ; finish({ ok: false, error: 'git timed out' }) }, timeout)
    child.on('error', (e) => finish({ ok: false, error: 'git is not installed or not on PATH: ' + e.message }))
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('close', (code) => finish({
      ok: code === 0,
      out: hideToken(out, token).trim(),
      error: code === 0 ? null : (hideToken(err, token).trim().slice(-400) || 'git exit code ' + code),
    }))
  })
}

// Clone on first use, fast-forward pull afterwards.
async function sync({ force = false } = {}) {
  const s = settings()
  if (!s.enabled) return { ok: false, error: 'the knowledge base is turned off in Config' }
  if (!s.repo) return { ok: false, error: 'no knowledge base repository set' }

  const state = readState()
  const ageMs = state.lastSync ? Date.now() - new Date(state.lastSync).getTime() : Infinity
  const fresh = !force && s.refreshHours > 0 && ageMs < s.refreshHours * 3600000
  const present = fs.existsSync(path.join(s.dir, '.git'))
  if (present && fresh) return { ok: true, skipped: 'synced ' + Math.round(ageMs / 60000) + ' minutes ago', ...status() }

  let r
  if (!present) {
    fs.mkdirSync(path.dirname(s.dir), { recursive: true })
    try { if (fs.existsSync(s.dir)) fs.rmSync(s.dir, { recursive: true, force: true }) } catch {}
    const args = ['clone', '--depth', '1', '--single-branch']
    if (s.branch) args.push('--branch', s.branch)
    args.push(authUrl(s.repo, s.token, s.provider), s.dir)
    r = await git(args, { token: s.token, timeout: 240000 })
    // Put the clean URL back so the token is not left in .git/config.
    if (r.ok) await git(['remote', 'set-url', 'origin', s.repo + '.git'], { cwd: s.dir, token: s.token })
  } else {
    // Pull with the token supplied only for this call.
    await git(['remote', 'set-url', 'origin', authUrl(s.repo, s.token, s.provider)], { cwd: s.dir, token: s.token })
    r = await git(['pull', '--ff-only', '--depth', '1'], { cwd: s.dir, token: s.token, timeout: 180000 })
    await git(['remote', 'set-url', 'origin', s.repo + '.git'], { cwd: s.dir, token: s.token })
  }

  if (!r.ok) {
    const e = String(r.error || '')
    let hint = ''
    if (/could not resolve host|couldn.t connect|connection refused|timed out|unable to access/i.test(e)) {
      hint = ' — the server could not be reached from this PC. If it is an internal host, this machine has to be on the company network or VPN.'
    } else if (/certificate|ssl/i.test(e)) {
      hint = ' — the server certificate was rejected. An internal server may use a private certificate authority this PC does not trust.'
    } else if (/authentication|could not read|403|401|denied|not found|does not exist/i.test(e)) {
      hint = s.provider === 'gitlab'
        ? ' — check the token. GitLab needs a personal, project or group access token with the read_repository scope, and that account must be a member of the project.'
        : ' — the repository is private or the name is wrong. Add a token in Config with read access to this repository.'
    }
    const st = { ...readState(), lastError: (r.error || 'sync failed') + hint, lastAttempt: new Date().toISOString() }
    writeState(st)
    return { ok: false, error: st.lastError }
  }

  const head = await git(['log', '-1', '--format=%h %ad %s', '--date=short'], { cwd: s.dir })
  writeState({ lastSync: new Date().toISOString(), lastAttempt: new Date().toISOString(), lastError: null, head: head.out || null })
  return { ok: true, ...status() }
}

function walk(dir, base = dir, out = []) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return out
    if (e.name.startsWith('.') && e.name !== '.') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue
      walk(p, base, out)
    } else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
      let size = 0
      try { size = fs.statSync(p).size } catch {}
      if (size > MAX_FILE_BYTES) continue
      out.push({ rel: path.relative(base, p).split(path.sep).join('/'), abs: p, size })
    }
  }
  return out
}

function listFiles() {
  const s = settings()
  if (!fs.existsSync(s.dir)) return []
  return walk(s.dir).sort((a, b) => a.rel.localeCompare(b.rel))
}

function status() {
  const s = settings()
  const st = readState()
  const present = fs.existsSync(path.join(s.dir, '.git'))
  const files = present ? listFiles() : []
  return {
    enabled: s.enabled,
    repo: s.repo,
    provider: s.provider,
    providerSetting: s.providerSetting,
    branch: s.branch,
    dir: s.dir,
    hasToken: Boolean(s.token),
    present,
    files: files.length,
    bytes: files.reduce((a, f) => a + f.size, 0),
    lastSync: st.lastSync || null,
    lastAttempt: st.lastAttempt || null,
    lastError: st.lastError || null,
    head: st.head || null,
    sample: files.slice(0, 40).map((f) => f.rel),
  }
}

function words(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)
}

// Pick the KB files that matter for these topics and return them as prompt
// context. Filename matches count for more than body matches, and a file the
// repo clearly means as an overview (readme/index/overview) is always kept.
function context({ topics = [], maxChars = null } = {}) {
  const s = settings()
  const limit = maxChars || s.maxChars
  const files = listFiles()
  if (!files.length) return { ok: false, text: '', files: [], error: 'the knowledge base has not been synced yet' }

  const terms = [...new Set(topics.flatMap((t) => words(t)))]
  const scored = files.map((f) => {
    let body = ''
    try { body = fs.readFileSync(f.abs, 'utf8') } catch {}
    const relLow = f.rel.toLowerCase()
    let score = 0
    if (/readme|index|overview|company|brand|positioning|product/.test(relLow)) score += 6
    if (/competitor|competition|market|rival/.test(relLow)) score += 8
    for (const t of terms) {
      if (relLow.includes(t)) score += 5
      const hits = body.toLowerCase().split(t).length - 1
      if (hits) score += Math.min(6, hits)
    }
    return { ...f, body, score }
  }).sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))

  const picked = []
  let used = 0
  for (const f of scored) {
    if (used >= limit) break
    if (f.score <= 0 && picked.length >= 3) continue
    const room = limit - used
    const slice = f.body.length > room ? f.body.slice(0, room) + '\n…(truncated)' : f.body
    picked.push({ rel: f.rel, chars: slice.length, score: f.score })
    used += slice.length
    f.slice = slice
  }

  const parts = scored.filter((f) => f.slice).map((f) => `----- FILE: ${f.rel} -----\n${f.slice}`)
  const index = files.map((f) => f.rel).join('\n')
  const text = `KNOWLEDGE BASE (${s.repo})
Every file in the knowledge base:
${index}

Full contents of the most relevant files:

${parts.join('\n\n')}`
  return { ok: true, text, files: picked, total: files.length }
}

// Sync (respecting the refresh window) and return context in one call.
async function contextFor(topics, opts = {}) {
  const s = settings()
  if (!s.enabled) return { ok: false, text: '', files: [], error: 'knowledge base off' }
  await sync({ force: false })
  return context({ topics, ...opts })
}

// The knowledge base's competitor files, read in FULL (not truncated), so the
// complete competitor list for a product reaches the model and the verification.
// Product-specific and curated competitive-set/landscape files come first; the
// large exploration dumps come last so they never crowd out the concise lists.
function competitorDocs({ product = null, maxChars = 40000 } = {}) {
  const files = listFiles()
  if (!files.length) return { ok: false, text: '', files: [], error: 'the knowledge base has not been synced yet' }
  const prodTerms = words(product)
  const isComp = (rel) => /competitive-landscape|competitive-set|competitor|vendor-landscape|competition/i.test(rel)
  const isCurated = (rel) => /competitive-landscape|competitive-set/.test(rel)
  const isDump = (rel) => /vendor-landscape|exploration/.test(rel)
  // When a product is given, keep only its own files plus the cross-product
  // curated shortlist, so the prompt stays small and on-topic.
  const scored = files.filter((f) => {
    if (!isComp(f.rel)) return false
    if (!prodTerms.length) return true
    const rel = f.rel.toLowerCase()
    return prodTerms.some((t) => rel.includes(t)) || /competitive-set/.test(rel)
  }).map((f) => {
    const rel = f.rel.toLowerCase()
    let pref = 0
    if (isCurated(rel)) pref += 100                                        // concise curated lists first
    if (prodTerms.length && prodTerms.some((t) => rel.includes(t))) pref += 50  // this product
    if (isDump(rel)) pref -= 60                                            // big market dumps last
    return { ...f, pref }
  }).sort((a, b) => b.pref - a.pref || a.size - b.size || a.rel.localeCompare(b.rel))
  if (!scored.length) return { ok: false, text: '', files: [], error: 'no competitor files found in the knowledge base' }

  const s = settings()
  const parts = []
  const out = []
  let used = 0
  for (const f of scored) {
    if (used >= maxChars) break
    let body = ''
    try { body = fs.readFileSync(f.abs, 'utf8') } catch { continue }
    const room = maxChars - used
    const slice = body.length > room ? body.slice(0, room) + '\n…(truncated)' : body
    parts.push(`----- FILE: ${f.rel} -----\n${slice}`)
    out.push({ rel: f.rel, chars: slice.length })
    used += slice.length
  }
  const text = `KNOWLEDGE BASE — competitor evidence (${s.repo})\n\n${parts.join('\n\n')}`
  return { ok: Boolean(parts.length), text, files: out }
}

// Sync (respecting the refresh window) and return competitor docs in one call.
async function competitorDocsFor({ product = null, brand = null, maxChars = 40000 } = {}) {
  const s = settings()
  if (!s.enabled) return { ok: false, text: '', files: [], error: 'knowledge base off' }
  await sync({ force: false })
  return competitorDocs({ product, maxChars })
}

module.exports = { settings, sync, status, listFiles, context, contextFor, competitorDocs, competitorDocsFor }
