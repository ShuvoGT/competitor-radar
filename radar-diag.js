'use strict'

// Read-only diagnostic for the "I updated the source link but it still uses the
// old link" problem. It changes NOTHING — it only prints what is in the database
// so we can see why the old link's data is still in the report.
//
// Run from the project folder:
//   node radar-diag.js            (all competitors)
//   node radar-diag.js Troyee     (just one competitor)

const { q, close } = require('./src/db')

async function main() {
  const only = process.argv[2] || null
  if (only) console.log('Filtering to competitor: ' + only)

  // 1. Sources. More than one row for the same competitor + kind is the bug:
  //    the scanner processes every active row, so an old link left behind here
  //    keeps being scraped even after you "update" the other one.
  const src = (await q(
    `SELECT id, competitor, kind, url, active, created_at
     FROM radar_sources
     WHERE ($1::text IS NULL OR competitor = $1)
     ORDER BY competitor, kind, id`, [only])).rows || []

  const byCK = new Map()
  for (const s of src) {
    const k = (s.competitor || '?') + '  |  ' + s.kind
    if (!byCK.has(k)) byCK.set(k, [])
    byCK.get(k).push(s)
  }

  console.log('\n===== SOURCES  (look for "DUPLICATE" — that is the old link still present) =====')
  let dupes = 0
  for (const [k, rows] of byCK) {
    const dup = rows.length > 1
    if (dup) dupes++
    console.log('\n' + k + (dup ? '   <<<<< DUPLICATE x' + rows.length : ''))
    for (const r of rows) {
      console.log('   #' + r.id + (r.active ? '  [active]  ' : '  [OFF]   ') +
        'added ' + String(r.created_at).slice(0, 10) + '  ' + r.url)
    }
  }
  console.log('\nDuplicate competitor+kind groups: ' + dupes)

  // 2. Ads are stored per competitor+platform, NOT per link. Ads scraped from the
  //    old link stay here after you change the URL, and keep appearing in the
  //    report until they are cleared or naturally marked stopped.
  console.log('\n===== ADS per competitor + platform  (old ads linger here) =====')
  const ads = (await q(
    `SELECT competitor, platform, count(*)::int AS total,
            count(*) FILTER (WHERE active)::int AS active,
            min(first_seen) AS oldest, max(last_seen) AS newest
     FROM radar_ads
     WHERE ($1::text IS NULL OR competitor = $1)
     GROUP BY 1,2 ORDER BY 1,2`, [only])).rows || []
  if (!ads.length) console.log('   (no ads)')
  for (const a of ads) {
    console.log('   ' + a.competitor + ' / ' + a.platform + ' : ' + a.total +
      ' ads (' + a.active + ' active)  oldest ' + String(a.oldest).slice(0, 10) +
      '  newest ' + String(a.newest).slice(0, 10))
  }

  // 3. Which source (id + url) was actually scanned most recently. If an old
  //    duplicate id/url shows up here, the scanner is still reading the old link.
  console.log('\n===== LAST 15 SNAPSHOTS  (which link was actually scanned) =====')
  const snaps = (await q(
    `SELECT sn.source_id, s.competitor, s.kind, s.url, sn.captured_at, sn.status
     FROM radar_snapshots sn JOIN radar_sources s ON s.id = sn.source_id
     WHERE ($1::text IS NULL OR s.competitor = $1)
     ORDER BY sn.captured_at DESC LIMIT 15`, [only])).rows || []
  if (!snaps.length) console.log('   (no snapshots)')
  for (const s of snaps) {
    console.log('   ' + String(s.captured_at).slice(0, 19) + '  #' + s.source_id +
      '  ' + s.competitor + '/' + s.kind + '  ' + s.status + '  ' + s.url)
  }

  console.log('\nDone. This script wrote nothing — paste the output back.')
  await close()
}

main().catch((e) => { console.error(e); process.exit(1) })
