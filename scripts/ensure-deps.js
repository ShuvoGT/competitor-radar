'use strict'

// Runs before `npm start`. If any dependency is missing from node_modules it
// installs them once, so starting Competitor Radar is a single command on a
// fresh machine. When everything is present it exits immediately.

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const deps = Object.keys(require(path.join(ROOT, 'package.json')).dependencies || {})

const missing = deps.filter((name) => {
  try { require.resolve(name, { paths: [ROOT] }); return false } catch { return true }
})

if (!missing.length) process.exit(0)

console.log('[radar] installing ' + missing.join(', ') + ' — this happens once…')
const r = spawnSync('npm install --no-audit --no-fund', { cwd: ROOT, stdio: 'inherit', shell: true })

if (r.status !== 0) {
  console.error('\n[radar] npm install failed. Run it by hand in ' + ROOT + ' and start again.')
  process.exit(r.status || 1)
}
console.log('[radar] dependencies ready')
