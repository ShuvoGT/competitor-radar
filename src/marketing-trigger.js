'use strict'

// Marketing-OS trigger.
//
// After a per-product competitor report is emailed, this hands that product's
// single best Facebook post to the marketing-os (harness) app so it can generate
// an ORIGINAL, inspired-not-copied post for the matching brand page. It is called
// from src/report.js (sendProductReport / the skipEmpty branch), once per product
// — so four product emails fan out to four generation jobs.
//
// Everything here is fail-soft: any error is caught and returned as a value, and
// never affects the email or the report. The whole feature is off unless
// config.marketingOs.enabled is true and the product has a mapping.
//
// Config (data/config.json → "marketingOs"): see marketing-os.config.example.json.

const fs = require('node:fs')
const path = require('node:path')
const { config, q, ROOT } = require('./db')
const analyze = require('./analyze')
const kb = require('./kb')

const isVideoType = (t) => t === 'Video' || t === 'Reel'

// Where downloaded competitor creatives are cached for the marketing-os agent to
// read (both apps run on the same machine, so an absolute path is fine).
const REF_DIR = path.join(ROOT, 'work', 'marketing-refs')

const safe = (s) => String(s || 'x').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x'

function extFromUrl(u) {
  const m = String(u || '').match(/\.(mp4|webm|mov|m4v|jpg|jpeg|png|webp|gif)(?:[?#]|$)/i)
  return m ? '.' + m[1].toLowerCase() : ''
}

// Download a remote creative to REF_DIR and return the local path, or null. fbcdn
// URLs expire fast, so fetching once and handing over a stable local file is far
// more reliable than passing the URL to another process.
async function downloadTo(url, baseName, fallbackExt = '') {
  try {
    fs.mkdirSync(REF_DIR, { recursive: true })
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 30000)
    let r
    try { r = await fetch(url, { signal: ctrl.signal }) } finally { clearTimeout(t) }
    if (!r || !r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length) return null
    const file = path.join(REF_DIR, baseName + (extFromUrl(url) || fallbackExt || '.bin'))
    fs.writeFileSync(file, buf)
    return file
  } catch { return null }
}

// ---- config helpers ---------------------------------------------------------

function cfg() {
  try { return config().marketingOs || {} } catch { return {} }
}

// Resolve a product's mapping tolerant of case / trimming / label. `products` is
// keyed by the product name as it appears in radar_sources.product.
function mappingFor(product) {
  const map = cfg().products || {}
  if (!map || typeof map !== 'object') return null
  if (map[product]) return map[product]
  const want = String(product || '').trim().toLowerCase()
  for (const k of Object.keys(map)) {
    if (String(k).trim().toLowerCase() === want) return map[k]
  }
  return null
}

// ---- creative brief ---------------------------------------------------------

// A plain-text fallback brief built only from what the report already captured —
// used when the LLM brief is disabled or fails. Never invents facts.
function templateBrief({ product, brand, best, kind }) {
  const a = best.analysis || {}
  const lines = []
  lines.push(`Create ONE original ${kind} post for ${brand ? brand + ' — ' : ''}${product}.`)
  lines.push('')
  lines.push('What is working for the competitor (use as INSPIRATION for the angle only):')
  if (a.content_angle) lines.push(`- Angle: ${a.content_angle}`)
  if (a.campaign_objective) lines.push(`- Objective: ${a.campaign_objective}`)
  if (a.pain_point) lines.push(`- Pain point they hit: ${a.pain_point}`)
  if (a.value_proposition) lines.push(`- Promise they make: ${a.value_proposition}`)
  if (best.cta) lines.push(`- CTA: ${best.cta}`)
  if (best.engagement && best.engagement.text) lines.push(`- Traction: ${best.engagement.text}`)
  lines.push('')
  lines.push('Produce our OWN take on that angle for our product. Do NOT copy their')
  lines.push('wording, layout or imagery — borrow only the strategic angle/hook.')
  return lines.join('\n')
}

// Ask the Claude CLI to turn the best competitor post into a short creative brief
// for our product, grounded in our knowledge base. Returns { brief, caption }.
async function llmBrief({ product, brand, best, kind }) {
  const b = cfg().brief || {}
  if (b.enabled === false) return { brief: templateBrief({ product, brand, best, kind }), caption: '' }

  let kbText = ''
  try {
    const ctx = await kb.contextFor([brand, product, best.competitor].filter(Boolean), { maxChars: 5000 })
    if (ctx && ctx.ok) kbText = ctx.text
  } catch {}

  const a = best.analysis || {}
  const competitorPost = [
    `Competitor: ${best.competitor}`,
    best.link ? `Post link: ${best.link}` : (best.url ? `Source: ${best.url}` : ''),
    best.mediaType ? `Format: ${best.mediaType}` : '',
    best.engagement && best.engagement.text ? `Engagement: ${best.engagement.text}` : '',
    a.campaign_objective ? `Objective: ${a.campaign_objective}` : '',
    a.content_angle ? `Angle: ${a.content_angle}` : '',
    a.pain_point ? `Pain point: ${a.pain_point}` : '',
    a.value_proposition ? `Value proposition: ${a.value_proposition}` : '',
    best.cta ? `CTA: ${best.cta}` : '',
    '',
    'Post text:',
    ((best.lines || []).join('\n') || best.summary || '(no text captured)'),
  ].filter((x) => x !== '').join('\n')

  const prompt = `You are the creative director for AKIJ iBOS, working on the product "${product}"${brand && brand !== product ? ` (brand page: ${brand})` : ''}.

Below is a competitor's TOP-PERFORMING Facebook post this window. Use it ONLY as inspiration for the strategic angle/hook. You must NOT copy its wording, imagery, layout or claims — produce something original and on-brand for OUR product.

${kbText ? `OUR KNOWLEDGE BASE (use to keep the brief accurate to our real product and positioning; do not treat it as facts about the competitor):\n${kbText}\n\n` : ''}COMPETITOR POST (inspiration only):
${competitorPost}

TASK
Write a tight creative brief for ONE original ${kind} post for our product. Keep it practical for a designer/video agent to execute. Cover, in short lines:
- Hook / big idea (the angle we borrow, reworked for us)
- Key message (what WE say, tied to our real product)
- Visual direction (what the ${kind} should show — original, not the competitor's)
- Tone (match how our brand speaks; Bangla or Bangla+English as fits the audience)
- CTA

Then, on a FINAL separate line, output a ready-to-post caption prefixed exactly with "CAPTION:" (one to three short lines, on-brand, no hashtags spam).

Return plain text only — the brief, then the CAPTION: line. No preamble, no code fences.`

  let res
  try { res = await analyze.runClaude(prompt, { timeoutMs: Number(b.timeoutMs) || 120000 }) } catch (e) { res = { ok: false, error: String(e && e.message || e) } }
  if (!res || !res.ok || !res.text) return { brief: templateBrief({ product, brand, best, kind }), caption: '', llmError: (res && res.error) || 'no output' }

  // Split off the CAPTION: line.
  const text = String(res.text).trim()
  const m = text.match(/\n?\s*CAPTION:\s*([\s\S]+)$/i)
  const caption = m ? m[1].trim() : ''
  const brief = m ? text.slice(0, m.index).trim() : text
  return { brief, caption }
}

// ---- competitor creative (visual reference) ---------------------------------

// A recent AD creative from the same competitor/product. Unlike social posts, ads
// store a real downloadable creative (creative_path on disk, or creative_url).
// This is the reliable fallback when the social post has no fetchable media.
// Returns { kind, source:'ad', path|url, local } or null.
async function adCreativeFallback(best, product) {
  let rows = []
  try {
    const r = await q(
      `SELECT creative_url, creative_path, format FROM radar_ads
       WHERE competitor = $1 AND (creative_path IS NOT NULL OR creative_url IS NOT NULL)
         AND ($2::text IS NULL OR product = $2)
       ORDER BY active DESC, first_seen DESC LIMIT 6`,
      [best.competitor, product || null])
    rows = (r && r.rows) || []
  } catch { return null }
  // Prefer a creative already on disk.
  for (const row of rows) {
    if (row.creative_path && fs.existsSync(row.creative_path)) {
      return { kind: /video/i.test(row.format || '') ? 'video' : 'image', source: 'ad', path: row.creative_path, local: true }
    }
  }
  // Otherwise download the first with a URL.
  for (const row of rows) {
    if (row.creative_url) {
      const kind = /video/i.test(row.format || '') ? 'video' : 'image'
      const file = await downloadTo(row.creative_url, 'ad-' + safe(best.competitor) + '-' + Date.now().toString(36), kind === 'video' ? '.mp4' : '.jpg')
      if (file) return { kind, source: 'ad', path: file, local: true, remoteUrl: row.creative_url }
      return { kind, source: 'ad', url: row.creative_url, local: false }
    }
  }
  return null
}

// Best-effort competitor creative for the brief's visual reference:
//   1) render the post's own permalink and download its creative (collect.fetchRendered
//      handles Python/Chrome/Playwright + the signed-in profile), then
//   2) fall back to a recent AD creative for the same competitor/product.
// Returns { kind, source, path|url, local } or null.
async function fetchVisual(best, product) {
  if (cfg().fetchVisual === false) return null
  const link = best && best.link
  if (link && best.kind === 'facebook' && /facebook\.com/i.test(link)) {
    let collect = null
    try { collect = require('./collect') } catch {}
    if (collect) {
      try {
        const r = await collect.fetchRendered(link, 16, true)
        const media = (r && Array.isArray(r.media)) ? r.media : []
        if (media.length) {
          const wantVideo = isVideoType(best.mediaType)
          const pick = media.find((m) => m && m.kind === (wantVideo ? 'video' : 'image')) || media[0]
          if (pick && pick.url) {
            const file = await downloadTo(pick.url, 'post-' + safe(best.competitor) + '-' + Date.now().toString(36), wantVideo ? '.mp4' : '.jpg')
            if (file) return { kind: pick.kind, source: 'post', path: file, local: true, remoteUrl: pick.url }
            return { kind: pick.kind, source: 'post', url: pick.url, local: false }
          }
        }
      } catch {}
    }
  }
  // No fetchable post media — fall back to an ad creative (a real asset).
  return await adCreativeFallback(best, product)
}

// ---- final prompt assembly --------------------------------------------------

function buildGenerationPrompt({ product, brand, kind, brief, best, visual }) {
  const parts = []
  parts.push(brief.trim())
  parts.push('')
  parts.push('--- INSPIRATION REFERENCE (competitor post — for angle only, DO NOT copy) ---')
  parts.push(`This is a competitor's top Facebook post for ${product}. Study its angle and why it worked, then make ORIGINAL, on-brand ${kind} creative for us. Never reproduce its text, layout, logo or imagery.`)
  parts.push(`- Competitor: ${best.competitor}`)
  if (best.link) parts.push(`- Post: ${best.link}`)
  if (best.mediaType) parts.push(`- Their format: ${best.mediaType}`)
  if (best.engagement && best.engagement.text) parts.push(`- Their traction: ${best.engagement.text}`)
  if (visual && (visual.path || visual.url)) {
    const ref = visual.path || visual.url
    const what = visual.source === 'ad' ? `a recent ${best.competitor} AD creative` : 'their post creative'
    const how = visual.path ? `open this local file to study it` : `reference URL`
    parts.push(`- Reference (${what}, ${visual.kind}) — INSPIRATION ONLY, ${how}; study composition/energy, do NOT re-use the file, logo, text or layout: ${ref}`)
  }
  const refText = (best.lines || []).join(' ') || best.summary || ''
  if (refText) parts.push(`- Their copy (paraphrase the idea, never the words): ${String(refText).slice(0, 400)}`)
  parts.push('')
  parts.push(`Deliver ONE ${kind} for ${brand || product}. Use our REAL brand assets (logo/colours) and write an on-brand caption.`)
  return parts.join('\n')
}

// ---- HTTP call to marketing-os ---------------------------------------------

async function postGenerate(payload) {
  const c = cfg()
  const base = String(c.endpoint || 'http://127.0.0.1:8765').replace(/\/+$/, '')
  const timeoutMs = Number(c.timeoutMs) || 20000
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(base + '/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(c.token ? { 'x-radar-key': c.token } : {}) },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { ok: res.ok && !!(json && json.ok), status: res.status, body: json || text.slice(0, 300) }
  } catch (e) {
    return { ok: false, error: String(e && e.name === 'AbortError' ? 'marketing-os did not respond in time' : (e && e.message || e)) }
  } finally { clearTimeout(t) }
}

// ---- status polling ---------------------------------------------------------

// Ask marketing-os for one job's current state (GET /status?id=). Used by
// refreshOutcomes() to fold a job's later status/permalink back into our table.
async function getStatus(jobId) {
  const c = cfg()
  const base = String(c.endpoint || 'http://127.0.0.1:8765').replace(/\/+$/, '')
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), Number(c.timeoutMs) || 10000)
  try {
    const res = await fetch(base + '/status?id=' + encodeURIComponent(jobId), {
      headers: { ...(c.token ? { 'x-radar-key': c.token } : {}) },
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { ok: res.ok && !!(json && json.ok), status: res.status, body: json || text.slice(0, 300) }
  } catch (e) {
    return { ok: false, error: String(e && e.name === 'AbortError' ? 'marketing-os did not respond in time' : (e && e.message || e)) }
  } finally { clearTimeout(t) }
}

// Poll marketing-os for the outcome of jobs we've already fired and fold the
// latest status/permalink back into radar_generated_posts. Best-effort and
// fail-soft: on any error it returns a value and leaves rows untouched.
async function refreshOutcomes({ limit = 50 } = {}) {
  if (!cfg().enabled) return { ok: false, skipped: 'marketingOs.enabled is false' }
  let rows = []
  try {
    const r = await q(`SELECT id, job_id FROM radar_generated_posts
                       WHERE job_id IS NOT NULL
                         AND status IN ('triggered','generating','ready','posting')
                         AND created_at > now() - interval '7 days'
                       ORDER BY created_at DESC LIMIT $1`, [Number(limit) || 50])
    rows = r.rows || []
  } catch (e) { return { ok: false, error: String(e && e.message || e) } }
  let updated = 0
  for (const row of rows) {
    const res = await getStatus(row.job_id)
    if (!res.ok || !res.body || !res.body.status) continue
    await saveRow(row.id, {
      status: String(res.body.status),
      permalink: res.body.permalink || null,
      error: res.body.error || null,
    })
    updated++
  }
  return { ok: true, checked: rows.length, updated }
}

// ---- outcome persistence (radar_generated_posts) ----------------------------

// Open (or re-claim) the audit row for this report+product. Returns
// { id, claimed }. `claimed:false` means a job already fired for this
// (report id, product) and the caller must skip. Fail-soft: if persistence is
// unavailable, generation still proceeds (claimed:true, id:null).
async function openRow({ reportId, product, force }) {
  try {
    if (!reportId) {
      const r = await q(`INSERT INTO radar_generated_posts (report_id, product, status)
                         VALUES (NULL,$1,'triggered') RETURNING id`, [product])
      return { id: r.rows[0] && r.rows[0].id, claimed: true }
    }
    // ON CONFLICT targets the partial unique index on (report_id, product).
    // Without force we only take the row back when the previous attempt FAILED;
    // otherwise RETURNING is empty and we treat it as already-triggered.
    const reclaim = force ? 'true' : `radar_generated_posts.status = 'failed'`
    const r = await q(
      `INSERT INTO radar_generated_posts (report_id, product, status)
       VALUES ($1,$2,'triggered')
       ON CONFLICT (report_id, product) WHERE report_id IS NOT NULL
       DO UPDATE SET status='triggered', error=NULL, job_id=NULL, session_id=NULL,
                     permalink=NULL, response=NULL, updated_at=now()
         WHERE ${reclaim}
       RETURNING id`, [reportId, product])
    if (r.rows && r.rows.length) return { id: r.rows[0].id, claimed: true }
    return { id: null, claimed: false }
  } catch (e) {
    return { id: null, claimed: true, persistError: String(e && e.message || e) }
  }
}

const ROW_COLS = ['product', 'kind', 'page', 'competitor', 'best_post', 'status', 'job_id', 'session_id', 'permalink', 'visual', 'visual_source', 'error', 'response']

async function saveRow(id, patch) {
  if (!id) return
  const cols = [], vals = []
  let i = 1
  for (const [k, v] of Object.entries(patch || {})) {
    if (!ROW_COLS.includes(k)) continue
    cols.push(`${k} = $${i++}`)
    vals.push(k === 'response' && v != null && typeof v === 'object' ? JSON.stringify(v) : v)
  }
  if (!cols.length) return
  cols.push('updated_at = now()')
  vals.push(id)
  try { await q(`UPDATE radar_generated_posts SET ${cols.join(', ')} WHERE id = $${i}`, vals) } catch {}
}

// Last-resort caption when the brief produced none (brief disabled or the LLM
// failed). Deliberately generic: it makes no claims and borrows nothing from the
// competitor, so the publish gate never receives an empty description.
function fallbackCaption({ product, brand }) {
  return `${brand || product} — আরও জানতে আমাদের সঙ্গে থাকুন।`
}

// Recent generation rows, for the CLI / dashboard.
async function listGeneratedPosts({ limit = 30, product = null } = {}) {
  try {
    const r = await q(`SELECT * FROM radar_generated_posts
                       WHERE ($2::text IS NULL OR product = $2)
                       ORDER BY created_at DESC LIMIT $1`, [Number(limit) || 30, product])
    return { ok: true, rows: r.rows || [] }
  } catch (e) { return { ok: false, error: String(e && e.message || e), rows: [] } }
}

// A recent, non-failed job for this product — regardless of which report it came
// from. This is the rebuild/re-send guard: a rebuilt report gets a NEW report id,
// so the (report id, product) unique index alone would not stop a second job.
async function recentDuplicate(product, hours) {
  try {
    const r = await q(`SELECT id, report_id, status, job_id FROM radar_generated_posts
                       WHERE product = $1 AND status <> 'failed'
                         AND created_at > now() - (($2)::int * interval '1 hour')
                       ORDER BY created_at DESC LIMIT 1`, [product, Number(hours) || 20])
    return r.rows[0] || null
  } catch { return null }
}

// ---- entry point ------------------------------------------------------------

// Called once per product after its report email is sent. `data` is rep.data
// (the full report blob); `pickBestPost` is passed from report.js so the choice
// matches the email exactly. Returns a small result object (never throws).
//
// Options:
//   reportId  — the radar_reports row this trigger belongs to. With it, the
//               (report id, product) pair is claimed once, so a rebuilt/re-sent
//               report cannot fire a second job.
//   kind      — force 'static' | 'video' | 'meme' (default: the mapping, else auto).
//   force     — re-claim even if a job already fired for this report+product
//               (manual trigger; a 'failed' row is re-claimable regardless).
//   preview   — build the brief/visual/prompt and return them WITHOUT posting
//               and without writing a row (CLI --dry).
async function triggerForProduct({ product, data, pickBestPost, reportId = null, kind: kindOverride = null, force = false, preview = false } = {}) {
  const c = cfg()
  if (!c.enabled) return { ok: false, skipped: 'marketingOs.enabled is false' }
  if (!product) return { ok: false, skipped: 'no product' }

  const map = mappingFor(product)
  if (!map) return { ok: false, skipped: `no marketingOs.products mapping for "${product}"` }
  if (!map.accountId && !map.pageId && !map.pageName) {
    return { ok: false, skipped: `mapping for "${product}" has no accountId/pageId/pageName` }
  }

  // Best Facebook post (the pipeline is about the best FB post). Optionally fall
  // back to the best post on any platform if marketingOs.anyPlatform is true.
  let best = pickBestPost(data, { platform: 'facebook' })
  if (!best && c.anyPlatform) best = pickBestPost(data)
  if (!best) return { ok: false, skipped: 'no Facebook post in this report' }

  let brand = ''
  try { brand = (config().brand || {}).name || '' } catch {}
  // Label the run by the product's page. Use the mapping's pageName when given,
  // otherwise the product (its page is resolved from accountId/pageId in harness,
  // which also injects the real page name for generation).
  const brandLabel = map.pageName || product || brand

  // Route the studio: honour an explicit kind, else mirror the competitor post.
  let kind = String(kindOverride || map.kind || 'auto').toLowerCase()
  if (!['video', 'static', 'meme'].includes(kind)) {
    kind = isVideoType(best.mediaType) ? 'video' : 'static'
  }

  const bestPost = best.link || best.url || ''

  // Rebuild/re-send guard: a rebuilt report is a NEW report id, so the
  // (report id, product) index alone would not stop a second job. If this product
  // already has a live (non-failed) job inside the dedupe window, skip. Manual
  // runs (force) and dry previews bypass this.
  if (!preview && !force && reportId) {
    const dup = await recentDuplicate(product, c.dedupeHours)
    if (dup) return { ok: false, skipped: `already triggered for "${product}" recently (row ${dup.id}, status ${dup.status})`, product, kind, page: brandLabel, competitor: best.competitor, bestPost }
  }

  // Idempotency: claim (report id, product) BEFORE the expensive brief/visual
  // work, so a rebuilt or re-sent report is cheap and cannot fire a second job.
  // A previous failure may re-claim; manual runs force. Dry preview never claims.
  let slot = { id: null, claimed: true }
  if (!preview) {
    slot = await openRow({ reportId, product, force })
    if (!slot.claimed) {
      return { ok: false, skipped: `already triggered for report ${reportId} / "${product}"`, product, kind, page: brandLabel, competitor: best.competitor, bestPost }
    }
    if (slot.id) await saveRow(slot.id, { kind, competitor: best.competitor, best_post: bestPost, status: 'triggered' })
  }

  // Build the brief + fetch the visual reference (in parallel).
  const [briefOut, visual] = await Promise.all([
    llmBrief({ product, brand: brandLabel, best, kind }),
    fetchVisual(best, product),
  ])

  const prompt = buildGenerationPrompt({ product, brand: brandLabel, kind, brief: briefOut.brief, best, visual })
  const caption = briefOut.caption || fallbackCaption({ product, brand: brandLabel })
  const base = {
    product,
    kind,
    page: brandLabel,
    competitor: best.competitor,
    bestPost,
    visual: visual ? (visual.path || visual.url) : null,
    visualSource: visual ? visual.source : null,
    captionProvided: Boolean(briefOut.caption),
    captionFallback: !briefOut.caption,
    llmError: briefOut.llmError || null,
  }

  // Dry preview: do all the work, hand back the brief, never POST, never persist.
  if (preview) return { ok: true, preview: true, ...base, prompt, caption, brief: briefOut.brief }

  if (slot.id) {
    await saveRow(slot.id, {
      kind, page: brandLabel, competitor: best.competitor,
      best_post: bestPost, visual: base.visual, visual_source: base.visualSource,
      status: 'generating',
    })
  }

  const payload = {
    kind,
    prompt,
    skill: map.skill || '',
    caption,
    autoPublish: c.autoPublish === true,
    // Address the target page by whichever the mapping provides; the endpoint resolves it.
    ...(map.accountId ? { accountId: map.accountId } : {}),
    ...(map.pageId ? { pageId: String(map.pageId) } : {}),
    ...(map.pageName ? { pageName: String(map.pageName) } : {}),
    // Provenance (the endpoint may log/track this; ignored if unused).
    source: 'competitor-radar',
    product,
    competitor: best.competitor,
    inspirationUrl: bestPost,
  }

  const res = await postGenerate(payload)
  const jobId = res.ok && res.body && res.body.id ? res.body.id : null
  const sessionId = res.ok && res.body && res.body.sessionId ? res.body.sessionId : null

  if (slot.id) {
    await saveRow(slot.id, {
      status: res.ok ? 'generating' : 'failed',
      job_id: jobId,
      session_id: sessionId ? Number(sessionId) : null,
      error: res.ok ? null : (res.error || (res.body && res.body.error) || `HTTP ${res.status || '?'}`),
      response: res.body || null,
    })
  }

  return {
    ok: res.ok,
    ...base,
    jobId,
    sessionId,
    persisted: slot.id || null,
    persistError: slot.persistError || null,
    response: res.ok ? (res.body && res.body.id ? { id: res.body.id, sessionId: res.body.sessionId } : res.body) : res,
  }
}

module.exports = {
  triggerForProduct, refreshOutcomes, listGeneratedPosts, getStatus,
  mappingFor, buildGenerationPrompt, llmBrief, fetchVisual, fallbackCaption,
}