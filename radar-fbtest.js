'use strict'

// Read-only test for the new Facebook per-post extraction (exact permalinks +
// reaction/comment/share counts). It renders each Facebook source through the
// SAME signed-in capture path a scan uses and prints exactly what the extractor
// pulled — so we can see whether the problem is login, the page markup, or just
// "the scan hasn't run yet". It writes NOTHING to the database.
//
// Run from the project folder (Radar can stay running):
//   node radar-fbtest.js            (every Facebook source)
//   node radar-fbtest.js Troyee     (just one competitor)

const { q, close } = require('./src/db')
const { fetchFbMobile, renderEngine, playwrightAvailable, saveSocialPosts } = require('./src/collect')

async function main() {
  const args = process.argv.slice(2)
  const save = args.includes('--save')
  const only = args.find((a) => !a.startsWith('--')) || null
  console.log('Engine: ' + renderEngine() + '   Playwright installed: ' + playwrightAvailable())
  if (renderEngine() !== 'playwright') {
    console.log('\n!! The post extractor only works with the Playwright engine (pwfetch.py).')
    console.log('   Install/enable it in Config, then re-run. Stopping here.')
    await close(); return
  }
  if (only) console.log('Filtering to competitor: ' + only)

  if (save) console.log('MODE: --save (captured posts will be written to radar_social_posts)')
  else console.log('MODE: read-only (add --save to write the captured posts to the database)')

  const rows = (await q(
    `SELECT id, competitor, kind, url FROM radar_sources
     WHERE active AND kind = 'facebook'
       AND ($1::text IS NULL OR competitor = $1)
     ORDER BY competitor, id`, [only])).rows || []

  if (!rows.length) { console.log('\nNo active Facebook sources found.'); await close(); return }

  for (const s of rows) {
    console.log('\n=======================================================')
    console.log('#' + s.id + '  ' + s.competitor + '   ' + s.url)
    let r
    try {
      // Reliable capture via the mobile-HTML reader (mbasic.facebook.com).
      r = await fetchFbMobile(s.url, 22)
    } catch (e) { console.log('  ERROR: ' + (e && e.message || e)); continue }

    if (r.error) { console.log('  capture note: ' + r.error) }
    const posts = Array.isArray(r.posts) ? r.posts : []
    const wall = !posts.length && /log ?in|not signed in|before you continue/i.test(String(r.error || ''))
    if (wall) console.log('  <<< LOOKS LIKE A LOGIN WALL — sign the capture browser into Facebook')
    console.log('  posts captured: ' + posts.length)
    posts.slice(0, 10).forEach((p, i) => {
      const eng = []
      if (p.reactions != null) eng.push(p.reactions + ' reactions')
      if (p.comments != null) eng.push(p.comments + ' comments')
      if (p.shares != null) eng.push(p.shares + ' shares')
      console.log('   ' + (i + 1) + '. ' + (p.url || '(no link)'))
      console.log('        when: ' + (p.posted_at || '(unparsed)') + '   ' + (eng.join(' · ') || 'no engagement counts'))
      console.log('        text: ' + String(p.text || '').slice(0, 120))
    })
    if (!posts.length && !wall) {
      console.log('  (rendered fine but no posts matched — the FB page markup may need a selector tweak; paste this output back)')
    }
    if (save && posts.length) {
      try {
        const n = await saveSocialPosts(s, posts)
        console.log('  SAVED: ' + n + ' new post(s) to radar_social_posts (' + posts.length + ' seen)')
      } catch (e) { console.log('  SAVE ERROR: ' + (e && e.message || e)) }
    }
  }

  // Show what is ALREADY stored, so we can tell whether the scheduled scan has
  // been saving Facebook posts (or whether the table is empty).
  console.log('\n===== radar_social_posts already in the database =====')
  try {
    const tot = (await q(`SELECT count(*)::int AS n FROM radar_social_posts WHERE platform='facebook'`)).rows[0]
    console.log('Total Facebook posts stored: ' + (tot ? tot.n : 0))
    const per = (await q(
      `SELECT competitor, count(*)::int AS n, max(first_seen) AS newest
       FROM radar_social_posts WHERE platform='facebook'
       GROUP BY competitor ORDER BY n DESC LIMIT 20`)).rows || []
    for (const r of per) console.log('   ' + r.competitor + ': ' + r.n + ' (newest seen ' + String(r.newest).slice(0, 16) + ')')
    const sample = (await q(
      `SELECT competitor, url, left(text, 70) AS t FROM radar_social_posts
       WHERE platform='facebook' ORDER BY first_seen DESC LIMIT 5`)).rows || []
    if (sample.length) {
      console.log('   sample stored posts:')
      for (const r of sample) console.log('     [' + r.competitor + '] ' + r.url + '  «' + (r.t || '') + '»')
    }
  } catch (e) { console.log('   could not read radar_social_posts: ' + (e && e.message || e)) }

  if (save) console.log('\nDone. Captured posts written. Now regenerate the report — Facebook posts will show their exact links.')
  else console.log('\nDone (read-only). Re-run with --save to write these posts so the report can link them.')
  await close()
}

main().catch((e) => { console.error(e); process.exit(1) })
