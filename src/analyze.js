'use strict'

// AI analysis via the Claude CLI (uses the existing Claude Code login — no API key).
// Classifies each change and writes a Bangla summary + recommended response.

const { spawn } = require('node:child_process')
const { which } = require('./util')
const { q, config } = require('./db')
const kb = require('./kb')

function parseStreamJson(out) {
  let text = '', result = ''
  for (const line of String(out || '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s[0] !== '{') continue
    try {
      const j = JSON.parse(s)
      if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
        for (const c of j.message.content) if (c && c.type === 'text' && c.text) text += c.text
      } else if (j.type === 'result' && typeof j.result === 'string') result = j.result
    } catch {}
  }
  return (text || result || '').trim()
}

function runClaude(prompt, { timeoutMs = 300000, cwd = null } = {}) {
  return new Promise((resolve) => {
    const bin = which('claude')
    if (!bin) return resolve({ ok: false, error: 'claude CLI not found on PATH' })
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
    const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose']
    let child
    try { child = spawn(bin, args, { shell: needsShell, windowsHide: true, cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }) }
    catch (e) { return resolve({ ok: false, error: 'spawn: ' + e.message }) }
    let out = '', err = '', done = false
    const timer = setTimeout(() => { if (done) return; done = true; try { child.kill() } catch {} ; resolve({ ok: false, error: 'claude timeout' }) }, timeoutMs)
    try {
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n')
      child.stdin.end()
    } catch {}
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ ok: false, error: e.message }) })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const text = parseStreamJson(out) || out.trim()
      resolve({ ok: Boolean(text) || code === 0, text, code, stderr: err.slice(-300) })
    })
  })
}

function extractJsonArray(text) {
  const s = String(text || '')
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  const arr = s.match(/\[[\s\S]*\]/)
  for (const c of [fence && fence[1], arr && arr[0], s].filter(Boolean)) {
    try { const j = JSON.parse(c); if (Array.isArray(j)) return j; if (j && Array.isArray(j.analyses)) return j.analyses } catch {}
  }
  return null
}

function buildPrompt(items, kbText = '') {
  const payload = items.map((x) => ({
    id: x.id, competitor: x.competitor, product: x.product, kind: x.kind,
    severity_guess: x.severity, score_guess: x.score, summary: x.summary,
    before: String(x.before_text || '').slice(0, 600),
    after: String(x.after_text || '').slice(0, 600),
    added: ((x.diff && x.diff.added) || []).slice(0, 6),
    removed: ((x.diff && x.diff.removed) || []).slice(0, 6),
  }))
  const kbBlock = kbText
    ? `\nOUR KNOWLEDGE BASE — use it to judge how much each change threatens us and to make the recommended response fit our actual products and positioning. Do not treat it as evidence about the competitor.\n\n${kbText}\n`
    : ''
  return `You are a competitive-intelligence analyst for AKIJ iBOS marketing. Analyse each competitor change and classify it. Use ONLY the evidence given; if it cannot be confirmed, set "basis" to "inference".
${kbBlock}

Return STRICT JSON - an array with one object per change, no prose, no code fences:
{
  "id": <change id>,
  "campaign_objective": "Awareness|Lead Generation|Conversion|Retargeting",
  "audience": "short segment",
  "pain_point": "the problem they highlight",
  "value_proposition": "the outcome they promise",
  "content_angle": "Pain Point|Feature|Comparison|Social Proof|Offer|Humour",
  "cta": "Book Demo|Try Free|Contact Sales|Download|Learn More|none",
  "creative_format": "Static|Carousel|Video|Explainer|Testimonial|Product Demo|Page change",
  "funnel_stage": "Awareness|Consideration|Decision",
  "brand_tone": "Corporate|Emotional|Urgent|Educational|Promotional",
  "threat_level": "critical|high|medium|low",
  "priority_score": <0-100 integer>,
  "summary": "one plain sentence, in Bangla (বাংলা)",
  "recommended_response": "one or two concrete sentences for our brand, in Bangla (বাংলা)",
  "basis": "confirmed|inference",
  "confidence": "high|medium|low"
}

Scoring guide: relevance 30, new offer/pricing 25, positioning 20, multi-channel 15, creative novelty 10.

CHANGES:
${JSON.stringify(payload, null, 1)}`
}

async function analyzeChanges({ days = 14, limit = 8, force = false } = {}) {
  const r = await q(`
    SELECT * FROM radar_changes
    WHERE (${force ? 'true' : 'analysis IS NULL'})
      AND detected_at > now() - ($1::int * interval '1 day')
    ORDER BY score DESC, detected_at DESC LIMIT $2`, [days, limit])
  const items = r.rows || []
  if (!items.length) return { ok: true, analyzed: 0, total: 0 }
  const brand = (config().brand || {})
  const topics = [brand.name, ...(brand.products || []), ...new Set(items.map((i) => i.competitor).filter(Boolean))]
  const ctx = await kb.contextFor(topics, { maxChars: 6000 })
  const res = await runClaude(buildPrompt(items, ctx.ok ? ctx.text : ''))
  if (!res.ok) return res
  const arr = extractJsonArray(res.text)
  if (!arr) return { ok: false, error: 'model did not return JSON', raw: String(res.text || '').slice(0, 300) }
  let n = 0
  for (const a of arr) {
    if (!a || a.id == null) continue
    const sev = ['critical', 'high', 'medium', 'low'].includes(a.threat_level) ? a.threat_level : null
    const score = Number.isFinite(Number(a.priority_score)) ? Math.max(0, Math.min(100, Math.round(Number(a.priority_score)))) : null
    const u = await q(`UPDATE radar_changes
                       SET analysis=$2::jsonb, recommended=$3, summary=coalesce($4,summary),
                           severity=coalesce($5,severity), score=coalesce($6,score)
                       WHERE id=$1`,
      [a.id, JSON.stringify(a), a.recommended_response || null, a.summary || null, sev, score])
    if (u.ok) n++
  }
  return { ok: true, analyzed: n, total: items.length }
}

// Suggest real competitors for a product category via the Claude CLI.
// Returns { ok, rows:[{ name, domain, facebook, linkedin, youtube, note }] }.
async function suggestCompetitors({ product = null, brand = null, existing = [], region = '' } = {}) {
  // Suggestions are grounded strictly in our own knowledge base. Only companies
  // the KB names as competitors are returned; nothing is added from general model
  // knowledge. The KB competitor files are read in FULL, so the complete list for
  // a product reaches both the model and the verification below. If the KB cannot
  // be read, nothing is suggested.
  let ctx = await kb.competitorDocsFor({ product, brand, maxChars: 32000 })
  if (!ctx.ok) ctx = await kb.contextFor([product, brand, region, 'competitor', 'positioning'].filter(Boolean), { maxChars: 24000 })
  if (!ctx.ok) {
    return {
      ok: true,
      rows: [],
      kb: { used: false, files: [], error: ctx.error || 'knowledge base unavailable' },
      note: 'No competitors suggested: the knowledge base could not be read, and suggestions are limited to competitors it names.',
    }
  }

  const prompt = `You are a B2B competitive-intelligence analyst for ${brand || 'our brand'}.

OUR KNOWLEDGE BASE — this is the ONLY source of truth for who we compete with. Read every file below, including the tables and the prose.

${ctx.text}

TASK
List EVERY company that OUR KNOWLEDGE BASE above names as a competitor of ${brand ? `"${brand}"` : 'our brand'}${product ? ` for the "${product}" product or category` : ''}${region ? ` (focus region: ${region})` : ''}. Include names that appear inside tables, bullet lists and sentences. Do not stop at the first few; return the full set the knowledge base names.
${existing.length ? `Exclude these already-tracked ones: ${existing.join(', ')}.` : ''}

HARD RULES
- Return ONLY companies the knowledge base itself names. Do not add any company from your own general knowledge, however well known or relevant it seems.
- If the knowledge base names no competitor for this, return an empty array [].
- Write each company name exactly as the knowledge base writes it. Do not invent domains or handles; where the KB gives none, use null.
- Rank by how directly the knowledge base frames each as a threat: same buyer, same market, overlapping modules, comparable price band.

Return STRICT JSON only - an array, no prose, no code fences:
[{"name":"Company","domain":"example.com or null","facebook":"pageslug or null","linkedin":"companyslug or null","youtube":"handle or null","note":"one short line on why they compete, from the KB","overlap":"what they overlap with us on","source":"kb"}]`
  const res = await runClaude(prompt, { timeoutMs: 240000 })
  if (!res.ok) return { ok: false, error: res.error === 'claude timeout' ? 'the Claude CLI took too long — try again, or narrow the product' : (res.error || 'claude failed') }
  const arr = extractJsonArray(res.text)
  if (!arr) return { ok: false, error: 'model did not return JSON', raw: String(res.text || '').slice(0, 300) }
  const rows = arr.filter((x) => x && x.name).map((x) => ({
    overlap: x.overlap ? String(x.overlap).trim() : '',
    source: 'kb',
    name: String(x.name).trim(),
    domain: x.domain && x.domain !== 'null' ? String(x.domain).trim() : null,
    facebook: x.facebook && x.facebook !== 'null' ? String(x.facebook).trim() : null,
    linkedin: x.linkedin && x.linkedin !== 'null' ? String(x.linkedin).trim() : null,
    youtube: x.youtube && x.youtube !== 'null' ? String(x.youtube).trim() : null,
    note: x.note ? String(x.note).trim() : '',
  }))
  // Hard guarantee: keep only companies whose name actually appears in the KB
  // competitor text. Corporate suffixes (Ltd, Limited, PLC, ...) are ignored on
  // both sides so "Best Business Bond" still matches "Best Business Bond Ltd.".
  const SUFFIX = /\b(ltd|limited|plc|inc|llc|corp|corporation|co|company|pvt|private)\b/g
  const norm = (s) => String(s || '').toLowerCase()
    .replace(/[^a-z0-9ঀ-৿]+/g, ' ')
    .replace(SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const kbHay = ' ' + norm(ctx.text) + ' '
  const inKb = (name) => { const n = norm(name); return n.length >= 2 && kbHay.includes(' ' + n + ' ') }
  const dropped = rows.filter((r) => !inKb(r.name)).map((r) => r.name)
  const kbRows = rows.filter((r) => inKb(r.name))
  return {
    ok: true,
    rows: kbRows,
    kb: { used: true, files: (ctx.files || []).map((f) => f.rel), error: null, dropped },
    note: kbRows.length ? null : 'The knowledge base named no competitors for this product.',
  }
}

module.exports = { runClaude, extractJsonArray, buildPrompt, analyzeChanges, suggestCompetitors }
