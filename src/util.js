'use strict'

const { spawnSync } = require('node:child_process')

const whichCache = {}
function which(cmd) {
  if (cmd in whichCache) return whichCache[cmd]
  const isWin = process.platform === 'win32'
  const r = isWin
    ? spawnSync('where.exe', [cmd], { encoding: 'utf8' })
    : spawnSync('/bin/zsh', ['-lc', 'command -v ' + cmd + ' || which ' + cmd + ' || true'], { encoding: 'utf8' })
  const lines = (r.stdout || '').trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const out = isWin ? (lines.find((s) => /\.(cmd|bat|exe)$/i.test(s)) || lines[0] || '') : (lines[0] || '')
  whichCache[cmd] = out || null
  return whichCache[cmd]
}

module.exports = { which }
