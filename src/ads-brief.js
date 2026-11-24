'use strict'

// Ad-inspired creative briefs.
//
// For each of OUR products, find the best-performing competitor ads and have
// Claude write an ORIGINAL, on-brand brief for our product: captions, ad copy +
// headlines, and visual direction. TEXT ONLY — nothing is generated or posted.
//
// "Best performing" can only be inferred (Ad Library exposes no impressions/
// spend). We rank by the standard proxy: still active + how long the ad has been
// running, plus a real creative, real copy, an offer and video format.
//
// Config: config().adsBrief { days, top, timeoutMs } (all optional).
// See MARKETING-OS-PIPELINE.md → "Ad-inspired briefs".

const { config, q } = require('./db')
const analyze = require('./analyze')
const kb = require('./kb')
const { reportProducts, competitorsForProduct, productLabel } = require('./report')

function cfg() {
  try { return config().adsBrief || {} } catch { return {} }
}

// In-memory progress of the current/last brief run, for the dashboard's live
// "Content Ideas" page. Reset at the start of each run.
let runState = { running: false, startedAt: null, finishedAt: null, total: 0, done: 0, current: null, error: null, products: [] }
function getRunStatus() { return runState }

// Rank one product's competitor ads. Score = still-active (dominant) + days
// running (longevity) + has a fetchable creative + has copy + has an offer +
// video. Falls back to first_seen when a real start date was never captured.
async function rankAdsForProduct({ product, days = 120, top = 5 } = {}) {
  let competitors = []
  try { competitors = await competitorsForProduct(product) } catch {}
  if (!competitors.length) return []
  const dayWindow = Number(days) ? Number(days) : null
  try {
    const r = await q(`
      SELECT id, platform, competitor, format, active, started_running, first_seen, last_seen,
             copy, headline, cta, offer, landing_url, creative_path, creative_url, ad_key,
             GREATEST(0, (CURRENT_DATE - COALESCE(started_running, first_seen::date))) AS days_running,
             ( (active)::int * 1000
             + LEAST(GREATEST(0, (CURRENT_DATE - COALESCE(started_running, first_seen::date))), 365)
             + (CASE WHEN creative_path IS NOT NULL OR creative_url IS NOT NULL THEN 50 ELSE 0 END)
             + (CASE WHEN copy IS NOT NULL AND btrim(copy) <> '' THEN 20 ELSE 0 END)
             + (CASE WHEN offer IS NOT NULL THEN 10 ELSE 0 END)
             + (CASE WHEN format = 'video' THEN 5 ELSE 0 END) ) AS score
      FROM radar_ads
      WHERE competitor = ANY($1::text[])
        AND ($2::int IS NULL OR last_seen > now() - ($2::int * interval '1 day'))
      ORDER BY score DESC, first_seen DESC
      LIMIT $3`, [competitors, dayWindow, Number(top) || 5])
    return r.rows || []
  } catch { return [] }
}

function adsText(ads) {
  return ads.map((a, i) => {
    const bits = [`#${i + 1} ${a.competitor} — ${a.platform}${a.format ? ' ' + a.format : ''}`]
    bits.push(`   running: ${a.days_running} day(s)${a.active ? ' · still ACTIVE' : ' · stopped'}`)
    if (a.offer) bits.push(`   offer: ${a.offer}`)
    if (a.cta) bits.push(`   cta: ${a.cta}`)
    if (a.headline) bits.push(`   headline: ${a.headline}`)
    if (a.copy) bits.push(`   copy: ${String(a.copy).replace(/\s+/g, ' ').slice(0, 400)}`)
    if (a.creative_path || a.creative_url) bits.push(`   creative: ${a.creative_path || a.creative_url}`)
    if (a.landing_url) bits.push(`   landing: ${a.landing_url}`)
    return bits.join('\n')
  }).join('\n\n')
}

// Deterministic fallback when the LLM is unavailable/disabled: a structured
// brief built ONLY from the ad data — it never invents product claims.
function templateAdBrief({ product, ads, error }) {
  const lines = []
  lines.push(`## What's working (from competitor ad data)${error ? ` — AI brief unavailable: ${error}` : ''}`)
  for (const a of ads) {
    const bits = [`${a.competitor} (${a.platform}${a.format ? ' ' + a.format : ''}, ${a.days_running}d${a.active ? ', active' : ''})`]
    if (a.offer) bits.push(`offer "${a.offer}"`)
    if (a.cta) bits.push(`CTA "${a.cta}"`)
    const hook = a.headline || String(a.copy || '').split(/\n/).map((s) => s.trim()).find(Boolean) || ''
    if (hook) bits.push(`hook: "${String(hook).slice(0, 140)}"`)
    lines.push('- ' + bits.join(' · '))
  }
  lines.push('')
  lines.push(`## Captions for ${product}`)
  lines.push('(AI unavailable — write 3 on-brand captions from the angles above; do not copy the competitor wording.)')
  lines.push('')
  lines.push(`## Ad copy & headlines for ${product}`)
  lines.push('(AI unavailable — write primary text + headlines from the angles above.)')
  lines.push('')
  lines.push(`## Visual direction for ${product}`)
  const fmt = (ads.find((a) => a.format) || {}).format || 'image'
  lines.push(`- Format: mirror the longest-running format (${fmt}) unless our brand calls for otherwise`)
  lines.push('- What to show: an ORIGINAL concept for our product — never the competitor asset')
  lines.push('- Layout & key elements: real brand logo + colours, one clear message, readable in 2–3s')
  lines.push('- On-image text: short Bangla and/or English headline')
  lines.push('- CTA: ' + ((ads.find((a) => a.cta) || {}).cta || 'Learn More'))
  return lines.join('\n')
}

// Claude brief for one product, grounded in the KB. Returns { ok, text|error }.
async function buildBrief({ product, brand, ads }) {
  let kbText = ''
  try {
    const ctx = await kb.contextFor([brand, product].concat(ads.map((a) => a.competitor)).filter(Boolean), { maxChars: 5000 })
    if (ctx && ctx.ok) kbText = ctx.text
  } catch {}

  const prompt = `You are the creative director for AKIJ iBOS, working on the product "${product}"${brand && brand !== product ? ` (brand: ${brand})` : ''}.

Below are the BEST-PERFORMING competitor ads in this product's market, ranked by how long they have been running (the standard Ad Library performance proxy) and whether they are still active. Study them ONLY as inspiration for the strategic angle — you must NOT copy their wording, imagery, layout or claims.

${kbText ? `OUR KNOWLEDGE BASE (use to keep claims accurate to our real product):\n${kbText}\n\n` : ''}COMPETITOR ADS (inspiration only):
${adsText(ads)}

TASK — output plain text (light markdown is fine), in this EXACT structure and nothing else:

## What's working (short)
- One line per ad: its angle/hook, the offer, and why it has lasted. Use only what is given above.

## Captions for ${product}
1. ...
2. ...
3. ...
(3 ready-to-post options; on-brand; Bangla or Bangla+English; no hashtag spam; never copy the competitor's words.)

## Ad copy & headlines for ${product}
Primary text A: ...
Primary text B: ...
Headline 1: ...
Headline 2: ...

## Visual direction for ${product}
- Format: (single image / carousel / short video) and why
- What to show: (an ORIGINAL concept — never the competitor's asset)
- Layout & key elements:
- On-image text:
- CTA:

Ground every product claim in the knowledge base; invent nothing. Do not name the competitors in our captions/copy.`

  let res
  try { res = await analyze.runClaude(prompt, { timeoutMs: Number(cfg().timeoutMs) || 180000 }) } catch (e) { res = { ok: false, error: String(e && e.message || e) } }
  if (!res || !res.ok || !res.text) {
    const err = (res && res.error) || 'no output'
    // Fail-soft: still return a usable, data-only brief rather than nothing.
    return { ok: true, text: templateAdBrief({ product, ads, error: err }), fallback: true, llmError: err }
  }
  return { ok: true, text: String(res.text).trim() }
}

async function saveBrief({ product, competitor, title, brief, ads }) {
  try {
    const r = await q(`INSERT INTO radar_ad_briefs (product, competitor, title, brief_md, ad_ids, ad_count)
                       VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id`,
      [product, competitor || null, title || null, brief, JSON.stringify((ads || []).map((a) => a.id)), (ads || []).length])
    return r.rows[0] && r.rows[0].id
  } catch { return null }
}

// Brief one product. `preview` builds the text but stores nothing.
async function generateForProduct({ product, days, top, store = true, preview = false, onProgress = null } = {}) {
  const label = productLabel(product)
  if (onProgress) onProgress('reading ads')
  const ads = await rankAdsForProduct({ product, days, top })
  if (!ads.length) return { ok: false, product: label, skipped: 'no competitor ads for this product' }

  let brand = ''
  try { brand = (config().brand || {}).name || '' } catch {}
  if (onProgress) onProgress('writing brief')
  const built = await buildBrief({ product: label, brand, ads })
  if (!built.ok) return { ok: false, product: label, error: built.error, ads: ads.length }

  let id = null
  if (store && !preview) {
    id = await saveBrief({ product: label, competitor: ads[0].competitor, title: `Ad-inspired brief — ${label}`, brief: built.text, ads })
  }
  return {
    ok: true, product: label, id, ads: ads.length,
    fallback: Boolean(built.fallback), llmError: built.llmError || null,
    top: ads.slice(0, 3).map((a) => `${a.competitor} (${a.days_running}d${a.active ? ', active' : ''})`),
    brief: built.text,
  }
}

// Every product (or a given list). Sequential; each brief is one Claude call.
// Updates runState so the dashboard can show live progress.
async function generateAdBriefs({ products = null, days, top, store = true, preview = false } = {}) {
  let list = products
  if (!list || !list.length) { try { list = await reportProducts() } catch { list = [] } }
  if (!list.length) {
    runState = { running: false, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), total: 0, done: 0, current: null, error: 'no products to brief', products: [] }
    return { ok: false, error: 'no products to brief', results: [] }
  }
  runState = {
    running: true, startedAt: new Date().toISOString(), finishedAt: null,
    total: list.length, done: 0, current: null, error: null,
    products: list.map((p) => ({ product: productLabel(p), status: 'queued', ads: 0, id: null, fallback: false, error: null })),
  }
  const results = []
  for (let i = 0; i < list.length; i++) {
    const p = list[i]
    const ps = runState.products[i]
    runState.current = ps.product
    try {
      const r = await generateForProduct({ product: p, days, top, store, preview, onProgress: (s) => { ps.status = s } })
      results.push(r)
      if (r.ok) { ps.status = 'done'; ps.ads = r.ads; ps.id = r.id; ps.fallback = Boolean(r.fallback) }
      else { ps.status = r.skipped ? 'skipped' : 'error'; ps.error = r.skipped || r.error }
    } catch (e) {
      ps.status = 'error'; ps.error = String(e && e.message || e)
      results.push({ ok: false, product: ps.product, error: ps.error })
    }
    runState.done = i + 1
  }
  runState.running = false
  runState.finishedAt = new Date().toISOString()
  runState.current = null
  return { ok: results.some((r) => r.ok), products: list.length, generated: results.filter((r) => r.ok).length, results }
}

async function listAdBriefs({ limit = 20, product = null } = {}) {
  try {
    const r = await q(`SELECT id, product, competitor, title, ad_count, created_at
                       FROM radar_ad_briefs
                       WHERE ($2::text IS NULL OR product = $2)
                       ORDER BY created_at DESC LIMIT $1`, [Number(limit) || 20, product])
    return { ok: true, rows: r.rows || [] }
  } catch (e) { return { ok: false, error: String(e && e.message || e), rows: [] } }
}

async function getAdBrief({ id } = {}) {
  try {
    const r = await q(`SELECT * FROM radar_ad_briefs WHERE id=$1`, [Number(id)])
    return r.rows[0] || null
  } catch { return null }
}

module.exports = {
  rankAdsForProduct, buildBrief, adsText, saveBrief,
  generateForProduct, generateAdBriefs, listAdBriefs, getAdBrief, getRunStatus,
}
