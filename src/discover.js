'use strict'

// Verified source discovery for one competitor.
//
// The old flow built URLs from whatever handles you typed and inserted them
// unchecked, so a wrong slug became a source that silently captured nothing.
// This does it the other way round:
//
//   1. The Claude CLI proposes the real profile URLs, grounded in our KB.
//   2. Radar fetches every candidate and checks it is really that company.
//   3. You see the verdict per source and choose what to connect.
//
// The model proposes, Radar verifies. A guess that does not resolve never
// reaches the database.

const { q } = require('./db')
const { runClaude, extractJsonArray } = require('./analyze')
const { fetchPlain, fetchRendered } = require('./collect')
const { cleanDomain, cleanHandle, updateSource, addSource, ADLIB, GADS, REDDIT, QUORA, XSRCH, GREVIEW } = require('./sources')
const kb = require('./kb')

// Kinds the model is asked to find. Search URLs are built by us, not guessed.
const PROFILE_KINDS = ['website', 'pricing', 'blog', 'facebook', 'instagram', 'linkedin', 'x', 'youtube', 'tiktok', 'threads', 'pinterest']

const LOGIN_RE = /(log ?in to|sign in to|create new account|phone number, username|you must log in|page isn.t available|content isn.t available|sorry, this page)/i
const MISSING_RE = /(page not found|404|isn.t available|doesn.t exist|no longer available|account.*not found|this page isn.t available)/i

// Distinctive words from a company name. Legal suffixes and generic software
// words are dropped, so "Divine IT Limited" matches on "divine".
const STOPWORDS = new Set(['ltd', 'limited', 'inc', 'llc', 'plc', 'company', 'co', 'corp', 'corporation',
  'software', 'solutions', 'solution', 'systems', 'system', 'technologies', 'technology', 'tech',
  'digital', 'group', 'holdings', 'bd', 'bangladesh', 'the', 'and'])

function nameTokens(name) {
  return String(name || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
}

function normUrl(u) {
  const s = String(u || '').trim()
  if (!s || /^(null|none|n\/a|unknown)$/i.test(s)) return null
  if (!/^https?:\/\//i.test(s)) return 'https://' + s.replace(/^\/+/, '')
  return s
}

// Does this page actually belong to the competitor?
function matches(text, title, url, tokens, domain) {
  const hay = `${title || ''} ${String(text || '').slice(0, 4000)}`.toLowerCase()
  const inUrl = String(url || '').toLowerCase()
  if (domain && inUrl.includes(domain.toLowerCase())) return true
  for (const t of tokens) {
    if (hay.includes(t)) return true
    if (inUrl.includes(t)) return true
  }
  return false
}

// Fetch a candidate and decide what it is. Social pages that need a signed-in
// browser fall back to the rendered path, which uses the Chrome profile.
async function probe(url, kind, tokens, domain) {
  const needsBrowser = ['facebook', 'instagram', 'linkedin', 'x', 'tiktok', 'threads', 'pinterest'].includes(kind)
  let r = needsBrowser ? null : await fetchPlain(url)
  const thin = !r || r.error || String(r.text || '').length < 250

  if (thin) {
    const rendered = await fetchRendered(url, needsBrowser ? 16 : 10)
    if (!rendered.error && String(rendered.text || '').length > String((r && r.text) || '').length) r = rendered
    else if (!r || (!String(r.text || '').trim() && rendered.error)) {
      // Keep the real reason the browser failed rather than the plain-fetch one.
      r = { text: (r && r.text) || '', title: (r && r.title) || '', httpStatus: r && r.httpStatus, error: rendered.error || (r && r.error) || 'could not be fetched' }
    }
  }
  if (!r) r = { text: '', error: 'could not be fetched' }

  const text = String(r.text || '')
  const title = r.title || ''
  const http = r.httpStatus || null

  if (r.error && !text) {
    const dead = /enotfound|getaddrinfo|dns|certificate|refused/i.test(String(r.error))
    return { status: dead ? 'dead' : 'unreachable', httpStatus: http, title, note: String(r.error).slice(0, 140) }
  }
  if (http && http >= 400) return { status: 'dead', httpStatus: http, title, note: 'HTTP ' + http }
  if (MISSING_RE.test(`${title} ${text.slice(0, 600)}`)) {
    return { status: 'dead', httpStatus: http, title, note: 'the page says it does not exist' }
  }
  if (!text.trim()) return { status: 'unverified', httpStatus: http, title, note: 'the page returned no readable text' }

  const hit = matches(text, title, url, tokens, domain)
  if (LOGIN_RE.test(`${title} ${text.slice(0, 800)}`) && !hit) {
    return { status: 'login', httpStatus: http, title, note: 'a login wall hid the page, so it could not be confirmed' }
  }
  if (!hit) return { status: 'unverified', httpStatus: http, title, note: 'the page loaded but does not mention this company' }
  return { status: 'verified', httpStatus: http, title, note: title ? 'page title: ' + title.slice(0, 90) : 'the company name appears on the page' }
}

// Ask the Claude CLI for the real profile URLs.
async function proposeUrls({ competitor, product, domain, region, handles }) {
  const ctx = await kb.contextFor([competitor, product, 'competitor'].filter(Boolean), { maxChars: 8000 })
  const given = Object.entries(handles || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ')

  const prompt = `You are finding the official online presence of one company so a monitoring tool can watch it.

COMPANY: ${competitor}
${product ? `CATEGORY WE COMPETE IN: ${product}` : ''}
${domain ? `KNOWN WEBSITE: ${domain}` : ''}
${region ? `MARKET: ${region}` : ''}
${given ? `HANDLES THE USER ALREADY SUPPLIED (verify these, do not ignore them): ${given}` : ''}
${ctx.ok ? `\nOUR KNOWLEDGE BASE — if it already records this company's website or handles, prefer those.\n\n${ctx.text}\n` : ''}

If you have web search or fetch tools, use them to confirm each URL before answering.

Return STRICT JSON only — an array, no prose, no code fences. One object per page you are confident exists:
[{"kind":"website","url":"https://example.com/","confidence":"high|medium|low","basis":"how you know"}]

Allowed kind values: ${PROFILE_KINDS.join(', ')}.
Rules:
- Give the full URL, not a slug.
- "website" is the homepage, "pricing" the pricing page, "blog" the blog or news index. Only include pricing or blog if that path really exists.
- Social entries must be the company's own official page, never a personal profile, a fan page, or a search result page.
- Omit a kind entirely rather than guess. A missing entry is much better than a wrong one.
- Never invent a URL to fill the list.`

  const res = await runClaude(prompt, { timeoutMs: 240000 })
  if (!res.ok) return { ok: false, error: res.error || 'the Claude CLI failed', kb: ctx.ok }
  const arr = extractJsonArray(res.text)
  if (!arr) return { ok: false, error: 'the model did not return JSON', raw: String(res.text || '').slice(0, 300), kb: ctx.ok }
  const rows = arr
    .filter((x) => x && PROFILE_KINDS.includes(String(x.kind || '').toLowerCase()) && normUrl(x.url))
    .map((x) => ({
      kind: String(x.kind).toLowerCase(),
      url: normUrl(x.url),
      confidence: ['high', 'medium', 'low'].includes(x.confidence) ? x.confidence : 'medium',
      basis: x.basis ? String(x.basis).slice(0, 160) : '',
      found: 'ai',
    }))
  return { ok: true, rows, kb: ctx.ok, kbFiles: (ctx.files || []).map((f) => f.rel) }
}

// Build the candidate list: what the user typed, what the model proposed, and
// the search URLs Radar constructs itself.
function candidates({ competitor, domain, handles, proposed }) {
  const out = []
  const seen = new Set()
  const push = (kind, url, found, extra = {}) => {
    const u = normUrl(url)
    if (!u) return
    const key = kind + '|' + u.toLowerCase().replace(/\/+$/, '')
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind, url: u, found, ...extra })
  }

  // 1. Anything typed in the form wins a place in the list.
  const h = handles || {}
  const dom = cleanDomain(domain)
  if (dom) push('website', `https://${dom}/`, 'you')
  const tpl = {
    facebook: (v) => `https://www.facebook.com/${v}`,
    instagram: (v) => `https://www.instagram.com/${v}/`,
    linkedin: (v) => `https://www.linkedin.com/company/${v}`,
    youtube: (v) => `https://www.youtube.com/@${v.replace(/^@/, '')}`,
    tiktok: (v) => `https://www.tiktok.com/@${v.replace(/^@/, '')}`,
    threads: (v) => `https://www.threads.net/@${v.replace(/^@/, '')}`,
    pinterest: (v) => `https://www.pinterest.com/${v}/`,
  }
  for (const [kind, build] of Object.entries(tpl)) {
    const slug = cleanHandle(h[kind])
    if (slug) push(kind, build(slug), 'you')
  }

  // 2. What the model proposed.
  for (const p of proposed || []) push(p.kind, p.url, 'ai', { confidence: p.confidence, basis: p.basis })

  return out
}

// Search URLs are queries, not profiles — there is nothing to verify.
function searchSources({ competitor, domain }) {
  const rows = [
    { kind: 'meta_adlib', url: ADLIB(competitor) },
    { kind: 'reddit', url: REDDIT(competitor) },
    { kind: 'quora', url: QUORA(competitor) },
    { kind: 'x', url: XSRCH(competitor) },
    { kind: 'review', url: GREVIEW(competitor) },
  ]
  if (domain) rows.push({ kind: 'google_ads', url: GADS(domain) })
  return rows.map((r) => ({ ...r, found: 'radar', status: 'search', note: 'a search Radar builds, nothing to verify' }))
}

// Page kinds derived from the website domain. Each is probed in order and the
// first candidate that really resolves as this company is connected. This turns
// "just a homepage" into pricing / blog / newsletter / product / landing
// coverage without ever guessing a wrong URL into the database.
const DERIVED_KINDS = [
  ['pricing', ['/pricing', '/pricing-plans', '/plans', '/price']],
  ['blog', ['/blog', '/news', '/blog/']],
  ['newsletter', ['/newsletter', '/newsletters', '/subscribe', '/mailing-list']],
  ['product', ['/products', '/product', '/solutions', '/features']],
  ['landing', ['/platform', '/use-cases', '/landing', '/overview']],
]

async function addDerivedSources({ competitor, product = null, domain = null } = {}) {
  const dom = cleanDomain(domain)
  if (!dom) return { ok: false, added: 0, addedKinds: [] }
  const cur = (await q(`SELECT kind, url FROM radar_sources WHERE competitor = $1`, [competitor])).rows || []
  const have = new Set(cur.map((s) => s.kind))
  const used = new Set(cur.map((s) => String(s.url).replace(/\/+$/, '').toLowerCase()))
  const tokens = nameTokens(competitor)
  const addedKinds = []
  let added = 0
  for (const [kind, paths] of DERIVED_KINDS) {
    if (have.has(kind)) continue
    for (const path of paths) {
      const u = `https://${dom}${path}`
      const key = u.replace(/\/+$/, '').toLowerCase()
      if (used.has(key)) break                       // already watched under another kind
      const v = await probe(u, kind, tokens, dom)
      if (v.status === 'verified') {
        const a = await addSource({ competitor, product, kind, url: u })
        if (a && a.ok) { added++; addedKinds.push(kind); used.add(key) }
        break
      }
    }
  }
  return { ok: true, added, addedKinds }
}

// Full run: propose, then verify every candidate, then add the search URLs.
async function discoverSources({ competitor, product = null, domain = null, handles = {}, region = '', onProgress = null } = {}) {
  if (!String(competitor || '').trim()) return { ok: false, error: 'competitor name required' }
  const name = String(competitor).trim()
  const tokens = nameTokens(name)
  const tick = (phase, done, total, current) => {
    if (onProgress) { try { onProgress({ phase, done, total, current }) } catch {} }
  }

  tick('Asking the Claude CLI for the official pages', null, null, name)
  const proposal = await proposeUrls({ competitor: name, product, domain, region, handles })

  const list = candidates({ competitor: name, domain, handles, proposed: proposal.ok ? proposal.rows : [] })
  const dom = cleanDomain(domain) || cleanDomain((list.find((x) => x.kind === 'website') || {}).url)

  const checked = []
  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    tick('Checking each page', i, list.length, `${c.kind} — ${c.url}`)
    const v = await probe(c.url, c.kind, tokens, dom)
    checked.push({ ...c, ...v })
  }
  tick('Checking each page', list.length, list.length, null)

  const searches = searchSources({ competitor: name, domain: dom })
  const rows = [...checked, ...searches]
  const counts = rows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a }, {})

  return {
    ok: true,
    competitor: name,
    product: product || null,
    domain: dom || null,
    rows,
    counts,
    kb: { used: Boolean(proposal.kb), files: proposal.kbFiles || [] },
    aiError: proposal.ok ? null : (proposal.error || null),
  }
}

// A query URL has nothing to verify — it returns results whether or not the
// company exists.
function isSearchUrl(kind, url) {
  if (['meta_adlib', 'google_ads', 'review'].includes(kind)) return true
  return /[?&]q=|\/search/i.test(String(url || ''))
}

// Re-check every source already connected to a competitor, then propose fixes
// for the broken ones and additions for the kinds that are missing.
async function verifyCompetitor({ competitor, product = null, onProgress = null } = {}) {
  const name = String(competitor || '').trim()
  if (!name) return { ok: false, error: 'competitor name required' }
  const tokens = nameTokens(name)
  const tick = (phase, done, total, current) => {
    if (onProgress) { try { onProgress({ phase, done, total, current }) } catch {} }
  }

  const listed = (await q(`SELECT id, kind, url FROM radar_sources WHERE competitor = $1 ORDER BY kind, url`, [name])).rows || []
  const site = listed.find((x) => x.kind === 'website')
  const dom = site ? cleanDomain(site.url) : null

  // 1. Check what is already connected.
  const existing = []
  for (let i = 0; i < listed.length; i++) {
    const srcRow = listed[i]
    tick('Checking connected sources', i, listed.length, `${srcRow.kind} — ${srcRow.url}`)
    if (isSearchUrl(srcRow.kind, srcRow.url)) {
      existing.push({ ...srcRow, status: 'search', note: 'a search URL, nothing to verify' })
      continue
    }
    const v = await probe(srcRow.url, srcRow.kind, tokens, dom)
    existing.push({ ...srcRow, ...v })
  }
  const broken = existing.filter((x) => x.status === 'dead' || x.status === 'unreachable')
  const connectedKinds = new Set(listed.map((x) => x.kind))
  const missingKinds = PROFILE_KINDS.filter((k) => !connectedKinds.has(k))

  // 2. Only bother the model if something is broken or missing.
  let proposal = { ok: true, rows: [] }
  if (broken.length || missingKinds.length) {
    tick('Asking the Claude CLI for the correct pages', null, null, name)
    proposal = await proposeUrls({ competitor: name, product, domain: dom, region: '', handles: {} })
  }

  // 3. Verify what it proposed, but only for kinds we actually need.
  const need = new Set([...broken.map((x) => x.kind), ...missingKinds])
  const wanted = (proposal.rows || []).filter((p) => need.has(p.kind))
  const candidatesChecked = []
  for (let i = 0; i < wanted.length; i++) {
    const c = wanted[i]
    tick('Checking the proposed pages', i, wanted.length, `${c.kind} — ${c.url}`)
    if (existing.some((e) => String(e.url).replace(/\/+$/, '') === String(c.url).replace(/\/+$/, ''))) continue
    const v = await probe(c.url, c.kind, tokens, dom)
    candidatesChecked.push({ ...c, ...v })
  }
  tick('Done', 1, 1, null)

  // 4. Pair each broken source with a verified replacement where one exists.
  const usedAsFix = new Set()
  const fixes = broken.map((b) => {
    const rep = candidatesChecked.find((c) => c.kind === b.kind && c.status === 'verified' && !usedAsFix.has(c.url))
    if (rep) usedAsFix.add(rep.url)
    return { id: b.id, kind: b.kind, url: b.url, note: b.note, status: b.status, replacement: rep ? rep.url : null, replacementNote: rep ? rep.note : null }
  })
  const additions = candidatesChecked.filter((c) => !usedAsFix.has(c.url) && c.status === 'verified')

  return {
    ok: true,
    competitor: name,
    product: product || null,
    domain: dom,
    existing,
    fixes,
    additions,
    counts: existing.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a }, {}),
    kb: { used: Boolean(proposal.kb), files: proposal.kbFiles || [] },
    aiError: proposal.ok ? null : (proposal.error || null),
  }
}

// Verify ONE connected source on its own — the per-source alternative to
// verifyCompetitor. Checks whether the link is reachable; if it is dead or
// unreachable it asks the model for the correct URL of that kind, verifies the
// candidate, and (when apply is set) repairs the source in place. A reachable
// link — including one behind a login wall — is left untouched.
async function verifySource({ id, apply = true } = {}) {
  const sid = Number(id)
  if (!sid) return { ok: false, error: 'source id required' }
  const row = (await q(`SELECT id, competitor, product, kind, url FROM radar_sources WHERE id = $1`, [sid])).rows[0]
  if (!row) return { ok: false, error: 'source not found' }
  const name = String(row.competitor || '').trim()
  const tokens = nameTokens(name)
  const site = (await q(`SELECT url FROM radar_sources WHERE competitor = $1 AND kind = 'website' LIMIT 1`, [name])).rows[0]
  const domain = site ? cleanDomain(site.url) : (row.kind === 'website' ? cleanDomain(row.url) : null)

  // A search URL always resolves — there is nothing to verify or fix.
  if (isSearchUrl(row.kind, row.url)) {
    return { ok: true, id: row.id, competitor: name, kind: row.kind, url: row.url, status: 'search', reachable: true, note: 'a search URL, nothing to verify' }
  }

  const v = await probe(row.url, row.kind, tokens, domain)
  const broken = v.status === 'dead' || v.status === 'unreachable'
  if (!broken) {
    // Reachable (verified, login wall, or loaded-but-unconfirmed) — keep it.
    return { ok: true, id: row.id, competitor: name, kind: row.kind, url: row.url, status: v.status, reachable: true, httpStatus: v.httpStatus || null, note: v.note }
  }

  // Not reachable — find, and optionally apply, a correct URL for this kind.
  const proposal = await proposeUrls({ competitor: name, product: row.product, domain, region: '', handles: {} })
  const sameUrl = (a, b) => String(a).replace(/\/+$/, '') === String(b).replace(/\/+$/, '')
  let replacement = null, replacementNote = null
  for (const c of (proposal.rows || []).filter((p) => p.kind === row.kind)) {
    if (sameUrl(c.url, row.url)) continue
    const rv = await probe(c.url, c.kind, tokens, domain)
    if (rv.status === 'verified') { replacement = c.url; replacementNote = rv.note; break }
  }

  let applied = false
  if (replacement && apply) {
    const u = await updateSource({ id: row.id, url: replacement })
    applied = Boolean(u && u.ok)
  }

  return {
    ok: true,
    id: row.id,
    competitor: name,
    kind: row.kind,
    url: applied ? replacement : row.url,
    oldUrl: applied ? row.url : null,
    status: applied ? 'fixed' : v.status,
    reachable: false,
    httpStatus: v.httpStatus || null,
    note: v.note,
    replacement,
    replacementNote,
    applied,
    aiError: proposal.ok ? null : (proposal.error || null),
  }
}

// Verify a competitor's connected sources and repair them in place: broken
// links whose correct URL was found are updated, and missing kinds that verify
// as real are added. Used when connecting a competitor from an AI suggestion,
// so its whole source set is checked and fixed in one pass, not left as guesses.
async function verifyAndFix({ competitor, product = null, onProgress = null } = {}) {
  const r = await verifyCompetitor({ competitor, product, onProgress })
  if (!r.ok) return r
  let updated = 0, added = 0
  for (const f of (r.fixes || [])) {
    if (!f.replacement) continue
    const u = await updateSource({ id: f.id, url: f.replacement })
    if (u && u.ok) updated++
  }
  for (const a of (r.additions || [])) {
    const ad = await addSource({ competitor: r.competitor, product: r.product, kind: a.kind, url: a.url })
    if (ad && ad.ok) added++
  }

  // Once a website is known (seeded or just discovered), fill in the sources
  // that are derived from its domain: the Google Ads search (always valid) and
  // pricing/blog when those pages actually resolve. This is what makes a
  // suggestion with no domain end up with more than the handful of search URLs.
  const cur = (await q(`SELECT kind, url FROM radar_sources WHERE competitor = $1`, [r.competitor])).rows || []
  const have = new Set(cur.map((s) => s.kind))
  const site = cur.find((s) => s.kind === 'website')
  const dom = site ? cleanDomain(site.url) : null
  if (dom) {
    if (!have.has('google_ads')) {
      const g = await addSource({ competitor: r.competitor, product: r.product, kind: 'google_ads', url: GADS(dom) })
      if (g && g.ok) added++
    }
    const derived = await addDerivedSources({ competitor: r.competitor, product: r.product, domain: dom })
    added += derived.added || 0
  }

  const unresolved = (r.fixes || []).filter((f) => !f.replacement).map((f) => ({ kind: f.kind, url: f.url, note: f.note }))
  return { ...r, applied: { updated, added, unresolved: unresolved.length }, unresolvedList: unresolved }
}

module.exports = { discoverSources, verifyCompetitor, verifyAndFix, verifySource, proposeUrls, probe, nameTokens, searchSources, isSearchUrl, addDerivedSources, PROFILE_KINDS }
