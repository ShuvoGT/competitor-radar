'use strict'

// New-page detection for competitor websites.
//
// The page-diff engine only tells us "an existing watched page changed". This
// module discovers the full list of pages a competitor's site publishes (from
// its sitemap, with a homepage-link fallback) and remembers them, so that when a
// BRAND-NEW page appears we can report it with a short summary and its link.
//
// First scan for a competitor = baseline: every current page is recorded but
// NOT flagged as new (so we never flood the first report). After that, only
// pages that were not in the baseline are reported as newly created.

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

async function withTimeout(url, headers, ms = 12000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    return await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers }, redirect: 'follow', signal: ac.signal })
  } finally { clearTimeout(t) }
}
async function fetchText(url) {
  try {
    const r = await withTimeout(url, { Accept: 'text/html,application/xml,text/xml,*/*' })
    if (!r.ok) return null
    return await r.text()
  } catch { return null }
}

function locsIn(xml) {
  return [...String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim())
}

// Every page URL the site advertises, from its sitemap(s). Robots.txt is checked
// for Sitemap: lines, then the usual sitemap paths. A sitemap index is followed
// one level down. Everything is capped so a huge site can never stall the scan.
async function discoverUrls(origin) {
  const sitemaps = new Set()
  const robots = await fetchText(origin + '/robots.txt')
  if (robots) for (const m of robots.matchAll(/sitemap:\s*(\S+)/gi)) sitemaps.add(m[1].trim())
  for (const p of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap/sitemap.xml']) sitemaps.add(origin + p)

  const out = new Set()
  for (const sm of [...sitemaps].slice(0, 8)) {
    if (out.size > 5000) break
    const xml = await fetchText(sm)
    if (!xml || !/<(urlset|sitemapindex)[\s>]/i.test(xml.slice(0, 500))) continue
    if (/<sitemapindex[\s>]/i.test(xml)) {
      for (const sub of locsIn(xml).slice(0, 25)) {
        if (out.size > 5000) break
        const sx = await fetchText(sub)
        if (!sx) continue
        for (const l of locsIn(sx)) { if (l.startsWith('http')) out.add(l); if (out.size > 5000) break }
      }
    } else {
      for (const l of locsIn(xml)) { if (l.startsWith('http')) out.add(l); if (out.size > 5000) break }
    }
  }

  // Fallback: no usable sitemap — take internal links off the homepage.
  if (!out.size) {
    const html = await fetchText(origin + '/')
    if (html) {
      for (const m of html.matchAll(/<a[^>]+href=["']([^"'#?]+)["']/gi)) {
        let href = m[1].trim()
        try { href = new URL(href, origin).href } catch { continue }
        if (href.startsWith(origin) && !/\.(png|jpe?g|gif|webp|svg|css|js|pdf|zip|mp4|woff2?)($|\?)/i.test(href)) out.add(href.split('#')[0])
        if (out.size > 400) break
      }
    }
  }
  return [...out]
}

// Title + short summary for a newly discovered page.
async function fetchPageMeta(url) {
  const html = await fetchText(url)
  if (!html) return { title: '', summary: '' }
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''
  let summary = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || ''
  if (!summary) {
    const body = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    const p = (body.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || ''
    summary = p
  }
  return { title: stripTags(title).slice(0, 200), summary: stripTags(summary).slice(0, 400) }
}

// Discover pages for one website source; record new ones. Returns how many
// brand-new pages were found (0 on the baseline run).
async function collectPages(src) {
  const origin = originOf(src.url)
  if (!origin) return { ok: false, new: 0, baseline: false }
  const urls = await discoverUrls(origin)
  if (!urls.length) return { ok: false, new: 0, baseline: false }

  const existing = (await q(`SELECT count(*)::int AS n FROM radar_pages WHERE competitor = $1`, [src.competitor])).rows[0]
  const firstRun = !existing || existing.n === 0

  let created = 0
  for (const u of urls.slice(0, 5000)) {
    const ins = await q(
      `INSERT INTO radar_pages (source_id, competitor, url, baseline)
       VALUES ($1,$2,$3,$4) ON CONFLICT (competitor, url) DO NOTHING
       RETURNING id`, [src.id, src.competitor, u.slice(0, 1000), firstRun])
    if (!ins.rows[0]) continue                 // already known
    if (firstRun) continue                     // baseline — recorded, not "new"
    // A genuinely new page: fetch its title + summary for the report.
    created++
    if (created <= 30) {
      try {
        const meta = await fetchPageMeta(u)
        await q(`UPDATE radar_pages SET title = $2, summary = $3 WHERE competitor = $1 AND url = $4`,
          [src.competitor, meta.title || null, meta.summary || null, u.slice(0, 1000)])
      } catch { /* leave title/summary null */ }
    }
  }
  return { ok: true, new: created, baseline: firstRun, seen: urls.length }
}

// New pages created within N days (never baseline pages), for the report.
function listNewPages({ days = 2 } = {}) {
  return q(
    `SELECT competitor, url, title, summary, first_seen
     FROM radar_pages
     WHERE baseline = false AND first_seen > now() - ($1::int * interval '1 day')
     ORDER BY first_seen DESC LIMIT 40`, [days])
}

module.exports = { collectPages, listNewPages, discoverUrls, fetchPageMeta, originOf }
