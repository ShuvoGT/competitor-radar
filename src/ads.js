'use strict'

// Ad Intelligence — Meta Ad Library + Google Ads Transparency.
// Parses ads, stores every ad (with link + creative), tracks new / stopped.

const fs = require('node:fs')
const path = require('node:path')
const { ROOT, q } = require('./db')
const { fetchSource, cleanMojibake } = require('./collect')

const BN_DIGITS = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' }
function bnToNum(s) {
  const d = String(s || '').replace(/[০-৯]/g, (c) => BN_DIGITS[c] || c).replace(/[^\d]/g, '')
  return d ? Number(d) : null
}

// Meta Ad Library rendered text -> individual ads.
function parseMetaAds(rawText) {
  const t = String(rawText || '')
  const re = /Library ID:\s*(\d+)/g
  const marks = []
  let m
  while ((m = re.exec(t))) marks.push({ id: m[1], at: m.index })
  const ads = []
  for (let i = 0; i < marks.length; i++) {
    const at = marks[i].at
    const seg = t.slice(i === 0 ? Math.max(0, at - 1500) : marks[i - 1].at, at + 80)
    const sp = seg.lastIndexOf('Sponsored')
    let copy = sp >= 0 ? seg.slice(sp + 'Sponsored'.length, at) : ''
    copy = cleanMojibake(copy
      .replace(/\b\d+\s+ads? use this creative and text\b/gi, ' ')
      .replace(/\bThis ad (?:has|is not)[^.]*\.?/gi, ' ')
      .replace(/\b(Open Drop-down|See ad details|See summary details|See details|EU transparency|See Details)\b/gi, ' ')
      .replace(/\b\d+:\d+\s*\/\s*\d+:\d+\b/g, ' '))
    if (copy.length > 800) copy = copy.slice(0, 800)
    const dm = seg.match(/Started running on\s*([0-9]{1,2}\s+[A-Za-z]{3,9}\s+[0-9]{4})/)
    const active = /Active/.test(seg) && !/not active for some audiences/i.test(seg)
    const cta = (copy.match(/\b(Learn More|Shop Now|Sign Up|Book Now|Get Offer|Contact Us|Download|Subscribe|Apply Now|Get Quote|Send Message|Watch More|See Menu|Order Now)\b/i) || [])[1] || null
    // Best-effort extraction from the visible ad text (never invented).
    const offer = (copy.match(/\b(\d{1,3}\s?%\s?(?:off|discount)|free trial|free for \d+ (?:days?|months?)|\d+\s?(?:days?|months?) free|save\s?[৳$]?\s?\d[\d,]*|[৳$]\s?\d[\d,]{1,8}|buy\s?one\s?get\s?one|bogo|limited time offer)\b/i) || [])[0] || null
    const lm = copy.match(/\b((?:[a-z0-9-]+\.)+(?:com|io|co|net|org|app|xyz|ai|info|biz|shop|store|bd))(\/[^\s)]*)?/i)
    const landingUrl = lm && !/facebook\.|fbcdn|instagram\.|fb\.me/i.test(lm[0]) ? lm[0] : null
    ads.push({
      libraryId: marks[i].id, startedRunning: dm ? dm[1] : null, active,
      copy, cta, offer, landingUrl,
      format: /\d+:\d+\s*\/\s*\d+:\d+/.test(seg) ? 'video' : 'image',
    })
  }
  return ads
}

// Google Ads Transparency loads its ads over the network as a data call, not as
// page text. We capture that call's body and pull the creative IDs (CR…) and
// advertiser IDs (AR…) out of it — enough to count ads, track new and stopped,
// and link each one back to the Transparency Center.
function parseGoogleCreatives(captured, competitor) {
  const blob = (Array.isArray(captured) ? captured : [captured]).filter(Boolean).join('\n')
  const creatives = [...new Set((blob.match(/\bCR\d{6,}\b/g) || []))]
  const advertisers = [...new Set((blob.match(/\bAR\d{6,}\b/g) || []))]
  const advId = advertisers.length === 1 ? advertisers[0] : null
  const link = (cr) => advId
    ? `https://adstransparency.google.com/advertiser/${advId}/creative/${cr}?region=anywhere`
    : `https://adstransparency.google.com/?region=anywhere&query=${encodeURIComponent(competitor || '')}`
  return creatives.map((cr) => ({
    libraryId: cr, active: true, copy: '', cta: null, offer: null,
    landingUrl: null, format: null, startedRunning: null, creativeLink: link(cr),
  }))
}

// Google Ads Transparency renders a summary (advertiser, ad count, formats).
function parseGoogleAds(text) {
  const t = String(text || '')
  const cm = t.match(/~?\s*([\d০-৯,]{1,9})\s*(বিজ্ঞাপন|ads?)/i)
  const adCount = cm ? bnToNum(cm[1]) : null
  const advertisers = [...new Set((t.match(/([A-Z][A-Za-z0-9 .,&'()-]{2,60}?)\s*(যাচাই করা হয়েছে|Verified)/g) || [])
    .map((s) => s.replace(/\s*(যাচাই করা হয়েছে|Verified).*/, '').trim()).filter((s) => s.length > 2))]
  const formats = []
  if (/videocam|\bvideo\b/i.test(t)) formats.push('video')
  if (/\bimage\b/i.test(t)) formats.push('image')
  return { adCount, advertisers, formats }
}

async function downloadCreatives(sourceId, media, max = 6) {
  const dir = path.join(ROOT, 'data', 'creatives')
  fs.mkdirSync(dir, { recursive: true })
  const out = []
  for (const m of (media || [])) {
    if (out.length >= max || !m || !m.url) continue
    try {
      const res = await fetch(m.url)
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 3000) continue
      const ext = m.kind === 'video' ? '.mp4' : '.jpg'
      const p = path.join(dir, `s${sourceId}-${out.length}${ext}`)
      fs.writeFileSync(p, buf)
      out.push({ path: p, kind: m.kind, url: m.url })
    } catch {}
  }
  return out
}

// Collect ads for one ad source; returns { platform, ads, newAds, stopped, creatives }.
async function collectAds(src) {
  const platform = src.kind === 'google_ads' ? 'google' : 'meta'
  const f = await fetchSource(src)
  const creatives = platform === 'meta' ? await downloadCreatives(src.id, f.media, 6) : []
  let ads = []
  let summary = null
  if (platform === 'meta') {
    ads = parseMetaAds(f.text || '')
  } else {
    ads = parseGoogleCreatives(f.captured, src.competitor)
    summary = parseGoogleAds(f.text || '')
  }

  const before = await q(`SELECT ad_key FROM radar_ads WHERE platform=$1 AND competitor=$2 AND active`, [platform, src.competitor])
  const beforeKeys = new Set((before.rows || []).map((r) => r.ad_key))
  // The very first scan of an advertiser is a BASELINE: every ad already
  // running is recorded but NOT reported as "new". Only ads that appear after
  // that are genuinely new.
  const anyBefore = await q(`SELECT count(*)::int AS n FROM radar_ads WHERE platform=$1 AND competitor=$2`, [platform, src.competitor])
  const firstRun = !(anyBefore.rows[0] && anyBefore.rows[0].n)
  const seen = new Set()
  let created = 0, updated = 0

  for (const a of ads) {
    seen.add(a.libraryId)
    const cr = creatives[created % Math.max(1, creatives.length)] || null
    const r = await q(`
      INSERT INTO radar_ads (platform, competitor, product, ad_key, copy, cta, offer, landing_url, format, started_running, active, baseline, creative_url, creative_path, raw)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
      ON CONFLICT (platform, ad_key) DO UPDATE SET
        copy=excluded.copy, cta=excluded.cta, format=excluded.format, active=excluded.active,
        offer=coalesce(excluded.offer, radar_ads.offer), landing_url=coalesce(excluded.landing_url, radar_ads.landing_url),
        last_seen=now(), creative_url=coalesce(excluded.creative_url, radar_ads.creative_url),
        creative_path=coalesce(excluded.creative_path, radar_ads.creative_path)
      RETURNING (xmax = 0) AS inserted`,
      [platform, src.competitor, src.product, a.libraryId, a.copy, a.cta, a.offer || null, a.landingUrl || null, a.format,
       a.startedRunning ? new Date(a.startedRunning) : null, a.active, firstRun,
       null, cr ? cr.path : null, JSON.stringify(a)])
    if (r.rows[0] && r.rows[0].inserted) created++
    else updated++
  }
  // mark ads that disappeared as stopped
  const stopped = [...beforeKeys].filter((k) => !seen.has(k))
  if (stopped.length) {
    await q(`UPDATE radar_ads SET active=false, last_seen=now() WHERE platform=$1 AND ad_key = ANY($2::text[])`, [platform, stopped])
  }
  return { platform, ads: ads.length, summary, newAds: firstRun ? 0 : created, baseline: firstRun, updated, stopped: stopped.length, creatives: creatives.length, error: f.error || null }
}

// Delete one ad by id, or every ad matching a competitor/platform filter.
// Used by the dashboard's Ads tab so stale ads can be cleared by hand.
function deleteAd(id) {
  const n = Number(id)
  if (!n) return Promise.resolve({ ok: false, error: 'ad id required' })
  return q(`DELETE FROM radar_ads WHERE id = $1`, [n])
}
function deleteAds({ competitor = null, platform = null } = {}) {
  return q(`DELETE FROM radar_ads
            WHERE ($1::text IS NULL OR competitor = $1)
              AND ($2::text IS NULL OR platform = $2)`, [competitor, platform])
}

function listAds({ competitor = null, platform = null, days = 30, limit = 200 } = {}) {
  return q(`SELECT * FROM radar_ads
            WHERE ($1::text IS NULL OR competitor = $1)
              AND ($2::text IS NULL OR platform = $2)
              AND last_seen > now() - ($3::int * interval '1 day')
            ORDER BY first_seen DESC LIMIT $4`, [competitor, platform, days, limit])
}

function adStats({ days = 30 } = {}) {
  return q(`SELECT platform, competitor, count(*)::int AS ads,
                   count(*) FILTER (WHERE active)::int AS active,
                   count(*) FILTER (WHERE first_seen > now() - ($1::int * interval '1 day'))::int AS new_ads
            FROM radar_ads GROUP BY 1,2 ORDER BY new_ads DESC, ads DESC`, [days])
}

module.exports = { parseMetaAds, parseGoogleAds, parseGoogleCreatives, collectAds, listAds, adStats, deleteAd, deleteAds, downloadCreatives, bnToNum }
