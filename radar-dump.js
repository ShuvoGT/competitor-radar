'use strict'

// Writes a full, read-only snapshot of the database to  radar-dump.txt  in this
// folder. Changes nothing. Run it, then I read the file directly.
//
//   node radar-dump.js

const fs = require('node:fs')
const path = require('node:path')
const { q, close } = require('./src/db')

const OUT = path.join(__dirname, 'radar-dump.txt')
const lines = []
const w = (s) => lines.push(s == null ? '' : String(s))

async function main() {
  w('RADAR DUMP  ' + new Date().toISOString())

  // 1. Every source row.
  const src = (await q(
    `SELECT id, competitor, kind, url, active, render, created_at
     FROM radar_sources ORDER BY competitor, kind, id`)).rows || []
  w('\n===== ALL SOURCES (' + src.length + ') =====')
  const ck = {}
  for (const s of src) { const k = (s.competitor || '?') + '|' + s.kind; ck[k] = (ck[k] || 0) + 1 }
  for (const s of src) {
    const dup = ck[(s.competitor || '?') + '|' + s.kind] > 1 ? '  <<DUP>>' : ''
    w('  #' + s.id + (s.active ? ' [on] ' : ' [OFF]') + ' ' + (s.competitor || '?') + '/' + s.kind +
      '  added ' + String(s.created_at).slice(0, 10) + '  ' + s.url + dup)
  }
  const dupGroups = Object.entries(ck).filter(([, n]) => n > 1)
  w('\nDuplicate competitor+kind groups: ' + dupGroups.length +
    (dupGroups.length ? '  -> ' + dupGroups.map(([k, n]) => k + ' x' + n).join(', ') : ''))

  // 2. Ads.
  const ads = (await q(
    `SELECT competitor, platform, count(*)::int AS total,
            count(*) FILTER (WHERE active)::int AS active,
            min(first_seen) AS oldest, max(last_seen) AS newest
     FROM radar_ads GROUP BY 1,2 ORDER BY 1,2`)).rows || []
  w('\n===== ADS per competitor/platform (' + ads.length + ' groups) =====')
  for (const a of ads) {
    w('  ' + a.competitor + '/' + a.platform + ' : ' + a.total + ' ads (' + a.active +
      ' active)  oldest ' + String(a.oldest).slice(0, 10) + '  newest ' + String(a.newest).slice(0, 10))
  }

  // 3. Recent changes, with the CURRENT url of their source (this is what the
  //    report links to). If a change points at an old/dup source, we see it.
  const ch = (await q(
    `SELECT c.id, c.competitor, c.kind, c.source_id, c.score, c.severity,
            left(coalesce(c.summary,''),50) AS summary, c.detected_at,
            s.url AS src_url, s.active AS src_active
     FROM radar_changes c LEFT JOIN radar_sources s ON s.id = c.source_id
     ORDER BY c.detected_at DESC LIMIT 25`)).rows || []
  w('\n===== LAST 25 CHANGES (detected_at + which source/url) =====')
  for (const c of ch) {
    w('  ' + String(c.detected_at).slice(0, 16) + '  #' + c.id + '  ' + (c.competitor || '?') +
      '/' + c.kind + '  src#' + (c.source_id == null ? '-' : c.source_id) +
      (c.src_active === false ? '[OFF]' : '') + '  score ' + (c.score == null ? '-' : c.score) +
      '  "' + String(c.summary || '').replace(/\s+/g, ' ').trim() + '"  ' + (c.src_url || '(no source url)'))
  }

  // 4. Latest snapshots.
  const sn = (await q(
    `SELECT sn.source_id, s.competitor, s.kind, s.url, sn.captured_at, sn.status
     FROM radar_snapshots sn JOIN radar_sources s ON s.id = sn.source_id
     ORDER BY sn.captured_at DESC LIMIT 20`)).rows || []
  w('\n===== LAST 20 SNAPSHOTS =====')
  for (const s of sn) {
    w('  ' + String(s.captured_at).slice(0, 16) + '  src#' + s.source_id + '  ' + s.competitor +
      '/' + s.kind + '  ' + s.status + '  ' + s.url)
  }

  // 5. Latest report rows (what actually got built/sent).
  const rep = (await q(
    `SELECT id, kind, period_start, period_end, sent, created_at
     FROM radar_reports ORDER BY created_at DESC LIMIT 5`)).rows || []
  w('\n===== LAST 5 REPORTS =====')
  for (const r of rep) {
    w('  #' + r.id + '  ' + r.kind + '  ' + String(r.period_start).slice(0, 10) + '..' +
      String(r.period_end).slice(0, 10) + '  sent=' + r.sent + '  built ' + String(r.created_at).slice(0, 16))
  }

  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
  console.log('Wrote ' + OUT + ' (' + lines.length + ' lines). Nothing else was changed.')
  await close()
}

main().catch((e) => { console.error(e); process.exit(1) })
