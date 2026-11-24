'use strict'

// Source registry + default source map.
// Social: Facebook, LinkedIn, X, Reddit, Quora. Plus website/pricing/blog,
// YouTube, Meta Ad Library, Google Ads Transparency and review sites.

const { q } = require('./db')

const SOCIAL_KINDS = ['facebook', 'instagram', 'linkedin', 'x', 'tiktok', 'threads', 'pinterest', 'reddit', 'quora', 'youtube', 'review', 'meta_adlib', 'google_ads']

// Ad-library source kinds. Their ads are stored per competitor+platform, not per
// source row, so changing the link needs to clear the old link's ads separately.
const AD_KINDS = new Set(['meta_adlib', 'google_ads'])
const platformOf = (kind) => (kind === 'google_ads' ? 'google' : 'meta')

function needsRender(kind) {
  // Social + ad pages need a real browser. Website / pricing / blog / newsletter
  // are added here too: modern sites render these with JavaScript, so a plain
  // fetch only sees an empty shell and no change or new post is ever detected.
  return ['facebook', 'instagram', 'linkedin', 'x', 'youtube', 'tiktok', 'threads', 'pinterest', 'meta_adlib', 'google_ads', 'quora', 'reddit', 'website', 'pricing', 'blog', 'newsletter', 'landing', 'product'].includes(kind)
}

async function addSource({ competitor = null, product = null, kind, url, render = null }) {
  if (!kind || !url) return { ok: false, error: 'kind and url required' }
  const r = needsRender(kind)
  const ins = await q(`INSERT INTO radar_sources (competitor, product, kind, url, render)
            VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (url) DO UPDATE SET competitor=excluded.competitor, product=excluded.product, kind=excluded.kind, render=excluded.render, active=true
            RETURNING id`,
    [competitor, product, kind, url, render == null ? r : render])
  // A competitor keeps exactly one source per kind. If re-adding a competitor
  // with a corrected link left an OLD row of the same competitor+kind behind,
  // drop it (its snapshots and changes cascade) so the old link is not scanned
  // any more. Brand monitoring watches many URLs per kind, so it is left alone.
  const newId = ins && ins.rows && ins.rows[0] && ins.rows[0].id
  if (newId && competitor && String(competitor).toUpperCase() !== 'BRAND') {
    await q(`DELETE FROM radar_sources WHERE competitor = $1 AND kind = $2 AND id <> $3`,
      [competitor, kind, newId])
  }
  return ins
}

function listSources({ competitor = null } = {}) {
  return q(`SELECT s.*,
              (SELECT count(*)::int FROM radar_snapshots sn WHERE sn.source_id = s.id) AS snapshots,
              (SELECT count(*)::int FROM radar_changes c WHERE c.source_id = s.id) AS changes,
              ls.status AS last_status, ls.captured_at AS last_at, ls.error AS last_error,
              ls.http_status AS last_http, ls.len AS last_len,
              (SELECT count(*)::int FROM radar_ads a WHERE a.competitor = s.competitor
                 AND a.platform = CASE WHEN s.kind = 'google_ads' THEN 'google' ELSE 'meta' END) AS ad_count
            FROM radar_sources s
            LEFT JOIN LATERAL (
              SELECT status, captured_at, error, http_status, length(coalesce(text,'')) AS len
              FROM radar_snapshots sn WHERE sn.source_id = s.id
              ORDER BY captured_at DESC LIMIT 1
            ) ls ON true
            WHERE ($1::text IS NULL OR s.competitor = $1)
            ORDER BY s.competitor, s.kind`, [competitor])
}

function removeSource(id) { return q(`DELETE FROM radar_sources WHERE id = $1`, [id]) }

// Change a source's URL so the NEXT scan really uses the new link. Editing the
// URL alone was not enough: the source kept its old snapshot (so a website/social
// scan diffed the new page against the old link's last capture), and any leftover
// duplicate row for the same competitor+kind — e.g. an auto-seeded link that was
// re-added — stayed active and kept being scraped. This makes an edit switch
// processing fully to the new link.
async function updateSource({ id, url }) {
  if (!id || !url) return { ok: false, error: 'id and url required' }
  const sid = Number(id)
  const next = String(url).trim()
  if (!sid || !next) return { ok: false, error: 'id and url required' }

  const cur = (await q(`SELECT id, competitor, kind, url FROM radar_sources WHERE id = $1`, [sid])).rows[0]
  if (!cur) return { ok: false, error: 'source not found' }
  if (next === cur.url) return { ok: true, rows: [{ id: sid }], unchanged: true }

  // The new URL may already exist on another row (the old link that was
  // re-seeded). radar_sources.url is UNIQUE, so that row would block the update
  // AND keep being scanned — remove it first; its snapshots and changes cascade.
  await q(`DELETE FROM radar_sources WHERE url = $1 AND id <> $2`, [next, sid])

  const u = await q(`UPDATE radar_sources SET url = $2, active = true WHERE id = $1 RETURNING id`, [sid, next])

  // A competitor has exactly one source per kind (brand monitoring is different —
  // it watches many URLs per kind, so it is left alone). Drop any other row of the
  // same competitor+kind so the scanner can never process the previous link again.
  if (cur.competitor && String(cur.competitor).toUpperCase() !== 'BRAND') {
    await q(`DELETE FROM radar_sources WHERE competitor = $1 AND kind = $2 AND id <> $3`,
      [cur.competitor, cur.kind, sid])
  }

  // Reset this source's snapshot baseline so the next scan reads the NEW link
  // fresh, instead of diffing the new page against the old link's last capture.
  await q(`DELETE FROM radar_snapshots WHERE source_id = $1`, [sid])

  // Drop this source's previously detected changes so the report can't keep
  // showing pre-edit changes that belong to the old link.
  await q(`DELETE FROM radar_changes WHERE source_id = $1`, [sid])

  // Ads are stored per competitor+platform, NOT per link, so the old link's ads
  // survive a URL change and keep appearing in the report. For an ad-library
  // source, clear this competitor's ads on that platform so the next scan
  // rebuilds them from the NEW link only.
  if (AD_KINDS.has(cur.kind) && cur.competitor) {
    await q(`DELETE FROM radar_ads WHERE competitor = $1 AND platform = $2`,
      [cur.competitor, platformOf(cur.kind)])
  }

  // Content collected for the OLD link is stored against this source id:
  // published blog/newsletter posts, discovered website pages and captured
  // social posts. Re-adding a source deletes the row and cascades these away,
  // but an in-place URL edit does not — so the report kept showing the old
  // link's posts/pages and the next scan treated them as the new link's
  // baseline. Clear them here so the edit fully switches to the new URL.
  for (const table of ['radar_articles', 'radar_pages', 'radar_social_posts']) {
    try { await q(`DELETE FROM ${table} WHERE source_id = $1`, [sid]) } catch { /* not created yet — skip */ }
  }

  return u
}

const ADLIB = (n) => `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&q=${encodeURIComponent(n)}&search_type=keyword_unordered`
const GADS = (d) => `https://adstransparency.google.com/?region=anywhere&domain=${d}`
const GADSQ = (n) => `https://adstransparency.google.com/?region=anywhere&query=${encodeURIComponent(n)}`
const REDDIT = (n) => `https://www.reddit.com/search/?q=${encodeURIComponent(n)}&sort=new`
const QUORA = (n) => `https://www.quora.com/search?q=${encodeURIComponent(n)}`
const XSRCH = (n) => `https://x.com/search?q=${encodeURIComponent(n)}&f=live`
const YTSRCH = (n) => `https://www.youtube.com/results?search_query=${encodeURIComponent(n)}`
const GREVIEW = (t) => `https://www.google.com/search?q=${encodeURIComponent(t + ' review')}`
// Name-based social searches, used when no profile handle is known so every
// popular platform is still watched (many are login-walled, which is expected).
const FBSRCH = (n) => `https://www.facebook.com/search/top?q=${encodeURIComponent(n)}`
const IGSRCH = (n) => `https://www.google.com/search?q=${encodeURIComponent('site:instagram.com ' + n)}`
const LISRCH = (n) => `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(n)}`
const TKSRCH = (n) => `https://www.tiktok.com/search?q=${encodeURIComponent(n)}`
const THSRCH = (n) => `https://www.threads.net/search?q=${encodeURIComponent(n)}`
const PINSRCH = (n) => `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(n)}`

// Accept a full URL or a bare domain; return the bare host (no protocol/path).
function cleanDomain(d) {
  const s = String(d || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[\/?#].*$/, '').trim()
  return s || null
}
// Accept a full profile URL, @handle or bare slug; return the slug.
function cleanHandle(h) {
  const s = String(h || '').trim().replace(/[\/?#\s]+$/, '')
  if (!s) return null
  const m = s.match(/[^\/@]+$/)
  return m ? m[0] : null
}

// Plan (but do not insert) every source kind for one competitor -> [{ kind, url }].
function planCompetitorSources({ competitor, domain = null, handles = {} }) {
  const h = handles || {}
  const dom = cleanDomain(domain)
  const fb = cleanHandle(h.facebook)
  const ig = cleanHandle(h.instagram)
  const li = cleanHandle(h.linkedin)
  const yt = cleanHandle(h.youtube)
  const tk = cleanHandle(h.tiktok)
  const th = cleanHandle(h.threads)
  const pin = cleanHandle(h.pinterest)
  const rows = []
  // Website, pricing and blog need a domain; everything else can be watched from
  // the competitor's name alone, so a name-only competitor still gets a full set.
  if (dom) rows.push(['website', `https://${dom}/`], ['pricing', `https://${dom}/pricing`], ['blog', `https://${dom}/blog`])
  // Google Ads Transparency only LISTS ads for a domain search — a name query
  // just opens the search box and returns nothing. So add a Google Ads source
  // only when the domain is known; a name-only competitor gets no google_ads.
  if (dom) rows.push(['google_ads', GADS(dom)])
  // meta ads, reddit, quora, x, youtube and Google reviews are always watched via
  // a search URL, even with no handle. A known youtube handle upgrades to the channel.
  rows.push(['meta_adlib', ADLIB(competitor)], ['reddit', REDDIT(competitor)], ['quora', QUORA(competitor)], ['x', XSRCH(competitor)], ['youtube', yt ? `https://www.youtube.com/@${yt}` : YTSRCH(competitor)], ['review', GREVIEW(competitor)])
  // A known handle gives the real profile; otherwise a name search keeps the
  // platform on the radar, so a name-only competitor still gets a full set.
  rows.push(['facebook', fb ? `https://www.facebook.com/${fb}` : FBSRCH(competitor)])
  rows.push(['instagram', ig ? `https://www.instagram.com/${ig}/` : IGSRCH(competitor)])
  rows.push(['linkedin', li ? `https://www.linkedin.com/company/${li}` : LISRCH(competitor)])
  rows.push(['tiktok', tk ? `https://www.tiktok.com/@${tk.replace(/^@/, '')}` : TKSRCH(competitor)])
  rows.push(['threads', th ? `https://www.threads.net/@${th.replace(/^@/, '')}` : THSRCH(competitor)])
  rows.push(['pinterest', pin ? `https://www.pinterest.com/${pin}/` : PINSRCH(competitor)])
  return rows.map(([kind, url]) => ({ kind, url }))
}

// Plan brand-monitoring sources for a brand + its products.
function planBrandSources({ brand, products = [] }) {
  const terms = [brand, ...(products || [])].filter(Boolean)
  const rows = []
  for (const t of terms) rows.push(['reddit', REDDIT(t)], ['quora', QUORA(t)], ['x', XSRCH(t)], ['review', GREVIEW(t)])
  return rows.map(([kind, url]) => ({ kind, url }))
}

// Seed every source kind for one competitor.
async function seedCompetitorSources({ competitor, product = null, domain = null, handles = {} }) {
  if (!competitor) return { ok: false, error: 'competitor required' }
  const plan = planCompetitorSources({ competitor, domain, handles })
  let n = 0
  for (const { kind, url } of plan) { const r = await addSource({ competitor, product, kind, url }); if (r.ok) n++ }
  return { ok: true, added: n, planned: plan.length }
}

// Remove a competitor completely: its sources (snapshots and detected changes
// cascade with them), its recorded changes and its collected ads. Creative
// files already downloaded to data/creatives are left on disk.
async function removeCompetitor({ competitor, purgeAds = true } = {}) {
  const name = String(competitor || '').trim()
  if (!name) return { ok: false, error: 'competitor name required' }
  if (name.toUpperCase() === 'BRAND') return { ok: false, error: 'BRAND is your own brand monitoring, not a competitor' }

  const changes = await q(`DELETE FROM radar_changes WHERE competitor = $1`, [name])
  const srcs = await q(`DELETE FROM radar_sources WHERE competitor = $1`, [name])
  let ads = 0
  if (purgeAds) {
    const a = await q(`DELETE FROM radar_ads WHERE competitor = $1`, [name])
    ads = a.rowCount || 0
  }
  return { ok: true, competitor: name, sources: srcs.rowCount || 0, changes: changes.rowCount || 0, ads }
}

// Sources that watch OUR brand mentions (brand monitoring).
async function seedBrandSources({ brand, products = [] }) {
  const plan = planBrandSources({ brand, products })
  let n = 0
  for (const { kind, url } of plan) { const r = await addSource({ competitor: 'BRAND', kind, url }); if (r.ok) n++ }
  return { ok: true, added: n, planned: plan.length }
}

module.exports = {
  SOCIAL_KINDS, needsRender, addSource, listSources, removeSource, updateSource,
  seedCompetitorSources, seedBrandSources, planCompetitorSources, planBrandSources, removeCompetitor,
  cleanDomain, cleanHandle, ADLIB, GADS, GADSQ, REDDIT, QUORA, XSRCH, YTSRCH, GREVIEW,
  FBSRCH, IGSRCH, LISRCH, TKSRCH, THSRCH, PINSRCH,
}
