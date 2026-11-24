'use strict'

// One-time cleanup for the "report still shows old-link data" problem.
//
// The code fix makes FUTURE link edits switch cleanly to the new link. This
// script cleans up the data that OLD edits already left behind. It is a DRY RUN
// by default — it changes nothing until you pass an action flag.
//
//   node radar-cleanup.js                 show duplicates + ad totals (no changes)
//   node radar-cleanup.js --dedupe        remove leftover duplicate source rows
//   node radar-cleanup.js --reset-ads     clear ALL stored ads (next full run
//                                         rebuilds them from the current links)
//   node radar-cleanup.js --reset NAME    purge ONE competitor's ads + snapshots
//                                         + changes, so its next run is fresh
//
// You can combine, e.g.  node radar-cleanup.js --dedupe --reset-ads

const { q, close } = require('./src/db')

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const valAfter = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null }

async function showDuplicates() {
  const rows = (await q(
    `SELECT competitor, kind, count(*)::int AS n,
            array_agg(id ORDER BY id) AS ids,
            array_agg(url ORDER BY id) AS urls
     FROM radar_sources
     WHERE competitor IS NOT NULL AND upper(competitor) <> 'BRAND'
     GROUP BY competitor, kind
     HAVING count(*) > 1
     ORDER BY competitor, kind`)).rows || []
  console.log('\n===== DUPLICATE SOURCE ROWS (old link left beside the new one) =====')
  if (!rows.length) console.log('  none — no competitor has two rows of the same kind.')
  for (const r of rows) {
    console.log('  ' + r.competitor + '/' + r.kind + '  x' + r.n + '  ids=[' + r.ids.join(', ') + ']')
    r.urls.forEach((u, i) => console.log('      #' + r.ids[i] + '  ' + u))
  }
  return rows
}

async function showAds() {
  const rows = (await q(
    `SELECT competitor, platform, count(*)::int AS total,
            count(*) FILTER (WHERE active)::int AS active,
            min(first_seen) AS oldest
     FROM radar_ads GROUP BY 1,2 ORDER BY 1,2`)).rows || []
  console.log('\n===== STORED ADS (old ones linger until cleared) =====')
  if (!rows.length) console.log('  none')
  for (const r of rows) {
    console.log('  ' + r.competitor + '/' + r.platform + ' : ' + r.total +
      ' ads (' + r.active + ' active)  oldest ' + String(r.oldest).slice(0, 10))
  }
}

async function dedupe() {
  const groups = await showDuplicates()
  if (!groups.length) { console.log('\n[--dedupe] nothing to collapse.'); return }
  let removed = 0
  for (const g of groups) {
    const keep = Math.max(...g.ids)          // keep the newest row
    const drop = g.ids.filter((id) => id !== keep)
    if (!drop.length) continue
    const r = await q(`DELETE FROM radar_sources WHERE id = ANY($1::bigint[])`, [drop])
    removed += r.rowCount || 0
    console.log('  ' + g.competitor + '/' + g.kind + ': kept #' + keep + ', removed ' + drop.map((x) => '#' + x).join(', '))
  }
  console.log('\n[--dedupe] removed ' + removed + ' duplicate source row(s). Their snapshots and changes cascaded away.')
}

async function resetAds() {
  const before = (await q(`SELECT count(*)::int AS n FROM radar_ads`)).rows[0].n
  await q(`DELETE FROM radar_ads`)
  console.log('\n[--reset-ads] cleared ' + before + ' stored ad(s). The next FULL run rebuilds ads from the current links only.')
}

async function resetCompetitor(name) {
  const c = (await q(`DELETE FROM radar_changes WHERE competitor = $1`, [name])).rowCount || 0
  const a = (await q(`DELETE FROM radar_ads WHERE competitor = $1`, [name])).rowCount || 0
  // snapshots hang off the source rows; clear them for this competitor's sources.
  const s = (await q(
    `DELETE FROM radar_snapshots
     WHERE source_id IN (SELECT id FROM radar_sources WHERE competitor = $1)`, [name])).rowCount || 0
  console.log('\n[--reset ' + name + '] cleared ' + a + ' ad(s), ' + s + ' snapshot(s), ' + c + ' change(s). Sources kept. Next run rebuilds from the current links.')
}

async function main() {
  await showDuplicates()
  await showAds()

  const doDedupe = has('--dedupe')
  const doResetAds = has('--reset-ads')
  const resetName = valAfter('--reset')

  if (!doDedupe && !doResetAds && !resetName) {
    console.log('\nDRY RUN — nothing changed. Re-run with a flag to apply:')
    console.log('  --dedupe        remove the duplicate source rows above')
    console.log('  --reset-ads     clear all stored ads (rebuilt on the next full run)')
    console.log('  --reset NAME    purge one competitor (ads + snapshots + changes)')
    await close()
    return
  }

  if (doDedupe) await dedupe()
  if (resetName) await resetCompetitor(resetName)
  if (doResetAds) await resetAds()

  console.log('\nAfter this: run a FULL report (Run full report and send now) so Radar rebuilds from the current links.')
  await close()
}

main().catch((e) => { console.error(e); process.exit(1) })
