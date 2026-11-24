#!/usr/bin/env node
'use strict'

// Competitor Radar CLI.
//   node cli.js schema | seed | scan | ads | brand | analyze | report | sources | mentions | stats | run

const { config, q, ensureSchema, close } = require('./src/db')
const { seedCompetitorSources, seedBrandSources, listSources, addSource, removeSource } = require('./src/sources')
const { scanSources, brandScan, analyze, report, runDaily } = require('./src/scheduler')
const { listAds, adStats } = require('./src/ads')
const { listMentions, mentionStats, addKeyword, listKeywords } = require('./src/brand')
const { listReports } = require('./src/report')
const { status } = require('./src/notify')

function args() {
  const a = process.argv.slice(2)
  const cmd = a[0]
  const opt = {}
  for (let i = 1; i < a.length; i++) {
    if (a[i].startsWith('--')) { const k = a[i].slice(2); opt[k] = (a[i + 1] && !a[i + 1].startsWith('--')) ? a[++i] : true }
  }
  return { cmd, opt }
}

const MAP = {
  Managerium: { domain: 'akijibos.com', handles: { facebook: 'akijibos', linkedin: 'akij-ibos' } },
  PeopleDesk: { domain: 'peopledesk.io', handles: { facebook: 'peopledesk', linkedin: 'peopledesk' } },
  PrimeVAT: { domain: 'akijibos.com', handles: {} },
  Travilo: { domain: 'travilo.com', handles: { facebook: 'travilo' } },
  TrackForce: { domain: 'trackforce.io', handles: { facebook: 'trackforce', linkedin: 'trackforce' } },
  'Turbo Guard': { domain: 'turbo-guard.com', handles: {} },
}

async function main() {
  const { cmd, opt } = args()
  const s = await ensureSchema()
  if (!s.ok) { console.error('schema:', s.error); process.exit(1) }

  switch (cmd) {
    case 'schema':
      console.log('schema ready')
      break

    case 'seed': {
      const cfg = config()
      const comps = {
        TrackForce: ['Hubstaff', 'ActivTrak', 'Teramind', 'Insightful', 'DeskTime', 'Time Doctor'],
        Managerium: ['Odoo', 'ERPNext', 'SAP Business One', 'Microsoft Dynamics 365'],
        PeopleDesk: ['BambooHR', 'Zoho People', 'Keka', 'greytHR'],
        PrimeVAT: ['Tally', 'QuickBooks', 'Xero', 'Zoho Books'],
        Travilo: ['Booking.com', 'Agoda', 'Expedia'],
        'Turbo Guard': ['Wordfence', 'Sucuri', 'MalCare', 'Patchstack'],
      }
      const DOMAIN = {
        Hubstaff: 'hubstaff.com', ActivTrak: 'activtrak.com', Teramind: 'teramind.co', Insightful: 'insightful.io',
        DeskTime: 'desktime.com', 'Time Doctor': 'timedoctor.com', Odoo: 'odoo.com', ERPNext: 'erpnext.com',
        'SAP Business One': 'sap.com', 'Microsoft Dynamics 365': 'microsoft.com', BambooHR: 'bamboohr.com',
        'Zoho People': 'zoho.com', Keka: 'keka.com', greytHR: 'greythr.com', Tally: 'tallysolutions.com',
        QuickBooks: 'quickbooks.intuit.com', Xero: 'xero.com', 'Zoho Books': 'zoho.com',
        'Booking.com': 'booking.com', Agoda: 'agoda.com', Expedia: 'expedia.com',
        Wordfence: 'wordfence.com', Sucuri: 'sucuri.net', MalCare: 'malcare.com', Patchstack: 'patchstack.com',
      }
      const HANDLE = {
        Hubstaff: 'hubstaff', ActivTrak: 'activtrak', Teramind: 'teramind', Insightful: 'insightful',
        DeskTime: 'desktime', 'Time Doctor': 'timedoctor', Odoo: 'odoo', ERPNext: 'erpnext',
        BambooHR: 'bamboohr', 'Zoho People': 'zoho', Keka: 'keka', greytHR: 'greythr',
        'Booking.com': 'booking', Agoda: 'agoda', Expedia: 'expedia', Wordfence: 'wordfence',
        Sucuri: 'sucuri', MalCare: 'malcare', Patchstack: 'patchstack',
      }
      let n = 0
      for (const [product, names] of Object.entries(comps)) {
        for (const name of names) {
          const r = await seedCompetitorSources({ competitor: name, product, domain: DOMAIN[name] || null, handles: { facebook: HANDLE[name], linkedin: HANDLE[name], youtube: HANDLE[name] } })
          n += r.added || 0
        }
      }
      await seedBrandSources({ brand: cfg.brand.name, products: cfg.brand.products })
      for (const k of (cfg.brand.keywords || [])) await addKeyword({ keyword: k })
      console.log('seeded sources:', n)
      break
    }

    case 'sources': {
      const r = await listSources({ competitor: opt.competitor || null })
      for (const x of r.rows) console.log(`${x.competitor || '—'} · ${x.kind} · ${x.url} (${x.snapshots} snaps, ${x.changes} changes)`)
      console.log('total:', r.rows.length)
      break
    }

    case 'scan': {
      const r = await scanSources({ competitor: opt.competitor || null })
      console.log(JSON.stringify({
        sources: r.sources, changed: r.changed, errors: r.errors,
        newAds: r.newAds, newArticles: r.newArticles, newPosts: r.newPosts, newPages: r.newPages,
      }, null, 1))
      break
    }

    case 'ads': {
      const st = await adStats({ days: Number(opt.days) || 30 })
      for (const a of st.rows) console.log(`${a.platform} · ${a.competitor} · ${a.active}/${a.ads} active · ${a.new_ads} new`)
      const ads = await listAds({ competitor: opt.competitor || null, platform: opt.platform || null, days: Number(opt.days) || 30, limit: Number(opt.limit) || 30 })
      console.log('\nrecent ads:')
      for (const a of ads.rows) console.log(`  [${a.platform}] ${a.competitor} · ${a.active ? 'active' : 'stopped'} · ${String(a.copy || '').slice(0, 90)}`)
      break
    }

    case 'brand': {
      if (opt.add) { await addKeyword({ keyword: opt.add }); console.log('keyword added:', opt.add); break }
      const k = await listKeywords()
      console.log('keywords:', k.rows.map((x) => x.keyword).join(', '))
      const r = await brandScan()
      console.log('brand scan:', JSON.stringify(r))
      break
    }

    case 'mentions': {
      const st = await mentionStats({ days: Number(opt.days) || 30 })
      console.log('stats:', JSON.stringify(st.rows[0]))
      const m = await listMentions({ sentiment: opt.sentiment || null, days: Number(opt.days) || 30, limit: Number(opt.limit) || 30 })
      for (const x of m.rows) console.log(`  [${x.sentiment}] ${x.keyword} (${x.platform}) — ${String(x.text || '').slice(0, 110)}`)
      break
    }

    case 'analyze': {
      const r = await analyze({ days: Number(opt.days) || 14, limit: Number(opt.limit) || 8, force: Boolean(opt.force) })
      console.log(JSON.stringify(r))
      break
    }

    case 'report': {
      const r = await report({ days: Number(opt.days) || 1 })
      console.log('report:', JSON.stringify({ ok: r.ok, kpis: r.kpis, channels: Object.keys(r.channels || {}) }))
      const l = await listReports({ limit: 5 })
      for (const x of l.rows) console.log(`  #${x.id} ${x.kind} ${x.period_start}→${x.period_end} sent=${x.sent}`)
      break
    }

    case 'run': {
      const r = await runDaily({ days: Number(opt.days) || 1 })
      console.log('daily run:', JSON.stringify(r, null, 1))
      break
    }

    case 'stats': {
      const c = await q(`SELECT
        (SELECT count(*)::int FROM radar_sources WHERE active) sources,
        (SELECT count(*)::int FROM radar_sources WHERE active AND competitor <> 'BRAND') competitor_sources,
        (SELECT count(*)::int FROM radar_ads) ads,
        (SELECT count(*)::int FROM radar_ads WHERE active) active_ads,
        (SELECT count(*)::int FROM radar_changes WHERE detected_at > now() - interval '1 day') changes_1d,
        (SELECT count(*)::int FROM radar_mentions) mentions,
        (SELECT count(*)::int FROM radar_mentions WHERE sentiment='negative') negative_mentions`)
      console.log(JSON.stringify(c.rows[0], null, 1))
      console.log('notify:', JSON.stringify(status()))
      break
    }

    case 'login': {
      const { launchLoginBrowser } = require('./src/collect')
      const r = launchLoginBrowser()
      if (r.ok) console.log('login browser opened on profile:', r.profile, '\nSign in to Facebook, Instagram, LinkedIn, X, TikTok and Quora, then close the window.')
      else console.log('login failed:', r.error)
      break
    }

    default:
      console.log('commands: schema | seed | scan | ads | brand | mentions | analyze | report | sources | stats | login | run')
  }
  await close()
}

main().catch(async (e) => { console.error('FATAL', e && e.stack || e); try { await close() } catch {} ; process.exit(1) })
