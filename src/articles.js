'use strict'

// Competitor blog / newsletter POST tracking.
//
// The page-diff engine only tells us "the blog page changed". This reads the
// actual list of published posts — from a site's WordPress REST API (preferred,
// exact dates) or its RSS / Atom feed (fallback) — so the report can show which
// posts a competitor published today and yesterday, with real titles and links.

const { q } = require('./db')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 CompetitorRadar/0.1'

function originOf(u) { try { return new URL(u).origin } catch { return null } }

function stripTags(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#8217;/g, '’').replace(/&#8211;/g, '–').replace(/&#038;|&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

// Fetch with a hard timeout so a slow or hanging site can never stall the scan.
async function withTimeout(url, headers, ms = 12000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    return await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers }, redirect: 'follow', signal: ac.signal })
  } finally { clearTimeout(t) }
}
async function fetchJson(url) {
  try {
    const r = await withTimeout(url, { Accept: 'application/json' })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}
async function fetchText(url) {
  try {
    const r = await withTimeout(url, { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' })
    if (!r.ok) return null
    return await r.text()
  } catch { return null }
}

// --- WordPress REST API ------------------------------------------------------
async function wpPosts(origin) {
  const j = await fetchJson(origin + '/wp-json/wp/v2/posts?per_page=20&orderby=date&_fields=id,date,link,title,excerpt')
  if (!Array.isArray(j) || !j.length) return null
  return j.map((p) => ({
    title: stripTags((p.title && p.title.rendered) || ''),
    url: String(p.link || '').trim(),
    published: p.date ? new Date(p.date) : null,
    summary: stripTags((p.excerpt && p.excerpt.rendered) || '').slice(0, 240),
  })).filter((x) => x.title && x.url)
}

// --- RSS 2.0 / Atom / RDF feed (fallback) -----------------------------------
function pick(block, tag) {
  const m = block.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i'))
  return m ? stripTags(m[1]) : ''
}
function parseFeed(xml) {
  const x = String(xml || '')
  const isAtom = /<feed[\s>]/i.test(x) && !/<rss[\s>]/i.test(x)
  const blocks = isAtom ? (x.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [])
    : (x.match(/<item[\s>][\s\S]*?<\/item>/gi) || [])
  const out = []
  for (const b of blocks) {
    const title = pick(b, 'title')
    let url = ''
    if (isAtom) {
      const m = b.match(/<link[^>]*rel=["']?alternate["']?[^>]*href=["']([^"']+)["']/i) || b.match(/<link[^>]*href=["']([^"']+)["']/i)
      url = m ? m[1] : ''
    } else {
      url = pick(b, 'link') || (b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] || ''
    }
    const pub = pick(b, 'pubDate') || pick(b, 'published') || pick(b, 'updated') || pick(b, 'dc:date') || pick(b, 'date')
    const d = pub ? new Date(pub) : null
    if (title && url) out.push({ title: title.slice(0, 400), url: String(url).trim(), published: (d && !isNaN(d)) ? d : null, summary: (pick(b, 'description') || pick(b, 'summary')).slice(0, 240) })
  }
  return out
}
function feedCandidates(url) {
  const o = originOf(url)
  const u = String(url || '').replace(/\/+$/, '')
  const c = [u + '/feed/', u + '/feed', u + '/rss', u + '/index.xml', u + '/atom.xml']
  if (o) c.push(o + '/feed/', o + '/feed', o + '/rss', o + '/rss.xml', o + '/index.xml', o + '/atom.xml', o + '/blog/feed/')
  return [...new Set(c)]
}
async function rssPosts(url) {
  for (const f of feedCandidates(url)) {
    const xml = await fetchText(f)
    if (!xml || !/<(rss|feed|rdf)[\s>]/i.test(xml.slice(0, 800))) continue
    const items = parseFeed(xml)
    if (items.length) return items
  }
  return null
}

// --- YouTube: exact video links from the channel feed ----------------------
async function fetchHtml(url) {
  try {
    const r = await withTimeout(url, { Accept: 'text/html,*/*' })
    if (!r.ok) return null
    return await r.text()
  } catch { return null }
}
async function youtubeVideos(url) {
  // A search URL has no channel to read.
  if (/\/results\?|search_query=/i.test(String(url))) return null
  let channelId = (String(url).match(/\/channel\/(UC[\w-]{20,})/) || [])[1]
  if (!channelId) {
    const html = await fetchHtml(url)          // channel / @handle page
    if (html) channelId = (html.match(/"channelId":"(UC[\w-]{20,})"/) || html.match(/\/channel\/(UC[\w-]{20,})/) || [])[1]
  }
  if (!channelId) return null
  const xml = await fetchText('https://www.youtube.com/feeds/videos.xml?channel_id=' + channelId)
  if (!xml) return null
  const items = parseFeed(xml)                 // Atom entries: title, exact watch link, published
  return items.length ? items : null
}

// Fetch a source's recent posts. YouTube → channel feed (exact video links);
// blog / newsletter → WordPress REST API, then RSS/Atom.
async function fetchArticles(src) {
  if (src.kind === 'youtube') {
    const items = await youtubeVideos(src.url)
    if (items && items.length) return { ok: true, via: 'youtube', items: items.slice(0, 25) }
    return { ok: false, via: null, items: [] }
  }
  const origin = originOf(src.url)
  let items = origin ? await wpPosts(origin) : null
  let via = 'wp-rest'
  if (!items || !items.length) { items = await rssPosts(src.url); via = 'rss' }
  if (!items || !items.length) return { ok: false, via: null, items: [] }
  return { ok: true, via, items: items.slice(0, 25) }
}

// Upsert posts; return how many were newly discovered.
async function saveArticles(src, items) {
  let created = 0
  for (const it of items) {
    if (!it.url || !it.title) continue
    const r = await q(
      `INSERT INTO radar_articles (source_id, competitor, kind, title, url, published, summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (competitor, url) DO UPDATE
         SET title = excluded.title,
             published = COALESCE(excluded.published, radar_articles.published)
       RETURNING (xmax = 0) AS inserted`,
      [src.id, src.competitor, src.kind, String(it.title).slice(0, 400), String(it.url).slice(0, 1000),
       it.published || null, (it.summary || '').slice(0, 500)])
    if (r.rows[0] && r.rows[0].inserted) created++
  }
  return created
}

// Called by the scan for each blog / newsletter source.
async function collectArticles(src) {
  const r = await fetchArticles(src)
  if (!r.ok) return { ok: false, via: null, total: 0, created: 0 }
  const created = await saveArticles(src, r.items)
  return { ok: true, via: r.via, total: r.items.length, created }
}

// Posts published within N days (by their real published date only, so a
// first-scan backfill of old posts never shows up as "published today").
function listRecentArticles({ days = 2 } = {}) {
  return q(
    `SELECT competitor, kind, title, url, published, summary
     FROM radar_articles
     WHERE published IS NOT NULL AND published > now() - ($1::int * interval '1 day')
     ORDER BY published DESC LIMIT 60`, [days])
}

module.exports = { fetchArticles, collectArticles, saveArticles, listRecentArticles, parseFeed, originOf }
