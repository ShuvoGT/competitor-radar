'use strict'

// Brand monitoring — watch for mentions of our brand across social/review
// sources, extract snippets, score sentiment and alert on negative ones.

const { config, q } = require('./db')
const { fetchSource } = require('./collect')

const POS = ['love', 'great', 'excellent', 'best', 'amazing', 'helpful', 'recommend', 'awesome', 'perfect', 'good', 'happy', 'fantastic', 'useful', 'top', 'reliable', 'সেরা', 'ভালো', 'দুর্দান্ত', 'ধন্যবাদ']
const NEG = ['bad', 'worst', 'terrible', 'bug', 'bugs', 'slow', 'expensive', 'scam', 'poor', 'broken', 'hate', 'refund', 'complaint', 'disappointed', 'crash', 'issue', 'problem', 'খারাপ', 'সমস্যা', 'বাজে', 'ঠকা', 'অভিযোগ']
const CUSTOMER = ['review', 'feedback', 'complaint', 'support', 'refund', 'bug', 'issue', 'problem', 'rating', 'অভিযোগ', 'রিভিউ', 'ফিডব্যাক']

function scoreSentiment(text) {
  const t = String(text || '').toLowerCase()
  let pos = 0, neg = 0
  for (const w of POS) if (t.includes(w)) pos++
  for (const w of NEG) if (t.includes(w)) neg++
  const score = pos - neg
  const sentiment = score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral'
  return { sentiment, score, isCustomer: CUSTOMER.some((w) => t.includes(w)) }
}

// Extract sentences/snippets around a keyword.
function extractMentions(text, keyword) {
  const out = []
  const lines = String(text || '').split(/\n+/)
  const kw = keyword.toLowerCase()
  for (const line of lines) {
    const l = line.trim()
    if (l.length < 20 || l.length > 600) continue
    if (l.toLowerCase().includes(kw)) out.push(l)
  }
  return out.slice(0, 20)
}

function addKeyword({ keyword, product = null }) {
  if (!keyword) return { ok: false, error: 'keyword required' }
  return q(`INSERT INTO radar_brand_keywords (keyword, product) VALUES ($1,$2)
            ON CONFLICT (keyword) DO UPDATE SET product=excluded.product, active=true RETURNING id`, [keyword, product])
}
function listKeywords() { return q(`SELECT * FROM radar_brand_keywords WHERE active ORDER BY keyword`) }
function removeKeyword(id) { return q(`DELETE FROM radar_brand_keywords WHERE id=$1`, [id]) }

async function scanBrand({ notify = null, sources = null } = {}) {
  const kws = (await listKeywords()).rows || []
  if (!kws.length) return { ok: true, mentions: 0, note: 'no brand keywords' }
  const srcs = sources || (await q(`SELECT * FROM radar_sources WHERE active AND competitor = 'BRAND'`)).rows || []
  let found = 0, notified = 0
  const cfg = config().brand || {}

  for (const src of srcs) {
    const f = await fetchSource(src)
    if (!f.text) continue
    for (const kw of kws) {
      const snippets = extractMentions(f.text, kw.keyword)
      for (const s of snippets) {
        const { sentiment, score, isCustomer } = scoreSentiment(s)
        const r = await q(`
          INSERT INTO radar_mentions (source_id, platform, keyword, url, text, sentiment, sentiment_score, is_customer)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (url, keyword) DO NOTHING
          RETURNING id`,
          [src.id, src.kind, kw.keyword, src.url, s.slice(0, 1500), sentiment, score, isCustomer])
        if (r.rows && r.rows.length) {
          found++
          const shouldAlert = (sentiment === 'negative' && cfg.notifyNegative !== false) ||
                              (sentiment === 'positive' && cfg.notifyPositive === true)
          if (shouldAlert && notify) {
            const res = await notify(`[Brand Alert] ${sentiment.toUpperCase()} mention — ${kw.keyword}`,
              `Source: ${src.kind} — ${src.url}\nSentiment: ${sentiment}\n\n"${s.slice(0, 400)}"`)
            const ok = Object.values(res || {}).some((v) => v && v.ok)
            if (ok) { await q(`UPDATE radar_mentions SET notified=true WHERE id=$1`, [r.rows[0].id]); notified++ }
          }
        }
      }
    }
  }
  return { ok: true, mentions: found, notified }
}

function listMentions({ sentiment = null, keyword = null, days = 30, limit = 200 } = {}) {
  return q(`SELECT * FROM radar_mentions
            WHERE ($1::text IS NULL OR sentiment = $1)
              AND ($2::text IS NULL OR keyword = $2)
              AND found_at > now() - ($3::int * interval '1 day')
            ORDER BY found_at DESC LIMIT $4`, [sentiment, keyword, days, limit])
}

function mentionStats({ days = 30 } = {}) {
  return q(`SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE sentiment='positive')::int AS positive,
      count(*) FILTER (WHERE sentiment='negative')::int AS negative,
      count(*) FILTER (WHERE sentiment='neutral')::int AS neutral,
      count(*) FILTER (WHERE is_customer)::int AS customer
    FROM radar_mentions WHERE found_at > now() - ($1::int * interval '1 day')`, [days])
}

module.exports = { scoreSentiment, extractMentions, addKeyword, listKeywords, removeKeyword, scanBrand, listMentions, mentionStats }
