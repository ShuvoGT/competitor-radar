'use strict'

// Read-only. Focused view of the AD sources (Meta Ad Library / Google Ads
// Transparency) and the ads stored for a competitor — this is the data the
// snapshot diagnostic can't show, because ad sources are collected differently.
//
//   node radar-ads.js MediaSoft
//   node radar-ads.js            (all competitors)

const { q, close } = require('./src/db')

async function main() {
  const only = process.argv[2] || null
  if (only) console.log('Competitor: ' + only)

  console.log('\n===== AD SOURCES (meta_adlib / google_ads) — the link you edit =====')
  const src = (await q(
    `SELECT id, competitor, kind, url, active, created_at
     FROM radar_sources
     WHERE kind IN ('meta_adlib','google_ads')
       AND ($1::text IS NULL OR competitor = $1)
     ORDER BY competitor, kind, id`, [only])).rows || []
  if (!src.length) console.log('  (none)')
  // Flag more than one row for the same competitor+kind — a leftover old link.
  const seen = {}
  for (const s of src) {
    const key = s.competitor + '|' + s.kind
    seen[key] = (seen[key] || 0) + 1
  }
  for (const s of src) {
    const dup = seen[s.competitor + '|' + s.kind] > 1 ? '  <<<<< DUPLICATE' : ''
    console.log('  #' + s.id + (s.active ? '  [active] ' : '  [OFF]   ') +
      s.competitor + '/' + s.kind + '  added ' + String(s.created_at).slice(0, 10) +
      '  ' + s.url + dup)
  }

  console.log('\n===== STORED ADS per competitor/platform =====')
  const ag = (await q(
    `SELECT competitor, platform, count(*)::int AS total,
            count(*) FILTER (WHERE active)::int AS active,
            min(first_seen) AS oldest, max(last_seen) AS newest
     FROM radar_ads
     WHERE ($1::text IS NULL OR competitor = $1)
     GROUP BY 1,2 ORDER BY 1,2`, [only])).rows || []
  if (!ag.length) console.log('  (no ads stored)')
  for (const a of ag) {
    console.log('  ' + a.competitor + '/' + a.platform + ' : ' + a.total +
      ' ads (' + a.active + ' active)  oldest ' + String(a.oldest).slice(0, 10) +
      '  newest ' + String(a.newest).slice(0, 10))
  }

  console.log('\n===== NEWEST 12 ADS (are these from the new link or the old one?) =====')
  const ads = (await q(
    `SELECT id, competitor, platform, ad_key, active, first_seen, last_seen,
            left(coalesce(copy,''), 70) AS copy
     FROM radar_ads
     WHERE ($1::text IS NULL OR competitor = $1)
     ORDER BY last_seen DESC LIMIT 12`, [only])).rows || []
  if (!ads.length) console.log('  (none)')
  for (const a of ads) {
    console.log('  #' + a.id + '  ' + a.platform + '  key=' + a.ad_key +
      (a.active ? '  active ' : '  stopped') +
      '  seen ' + String(a.first_seen).slice(0, 10) + '..' + String(a.last_seen).slice(0, 10) +
      '  ' + String(a.copy || '').replace(/\s+/g, ' ').trim())
  }

  console.log('\nDone. Read-only — nothing was changed.')
  await close()
}

main().catch((e) => { console.error(e); process.exit(1) })
