'use strict'

// PostgreSQL access + schema bootstrap.

const fs = require('node:fs')
const path = require('node:path')
const { Pool } = require('pg')

const ROOT = path.join(__dirname, '..')
let cfgCache = null

const CONFIG_PATH = path.join(ROOT, 'data', 'config.json')

function config() {
  if (cfgCache) return cfgCache
  cfgCache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  return cfgCache
}

// Drop the cached config so the next config() re-reads from disk.
function reloadConfig() {
  cfgCache = null
  return config()
}

// Persist config to disk (pretty JSON) and refresh the cache.
function saveConfig(next) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
  cfgCache = next
  return cfgCache
}

let pool = null
function connect() {
  if (pool) return pool
  const c = config().db
  pool = new Pool({
    host: c.host, port: Number(c.port) || 5432, database: c.database,
    user: c.user, password: c.password,
    ssl: c.ssl ? { rejectUnauthorized: false } : false,
    max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000,
  })
  pool.on('error', (e) => console.error('[db] pool error:', e.message))
  return pool
}

async function q(text, params) {
  const r = await connect().query(text, params)
  return { ok: true, rows: r.rows, rowCount: r.rowCount }
}

// Run DDL under an advisory lock so concurrent instances can't deadlock.
async function runDdl(sql) {
  const client = await connect().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(918273645)')
    await client.query(sql)
    await client.query('COMMIT')
    return { ok: true }
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    return { ok: false, error: String(e.message || e) }
  } finally {
    try { client.release() } catch {}
  }
}

async function ensureSchema() {
  const ddl = fs.readFileSync(path.join(ROOT, 'config', 'schema.sql'), 'utf8')
  return runDdl(ddl)
}

async function close() { if (pool) { try { await pool.end() } catch {} ; pool = null } }

module.exports = { ROOT, CONFIG_PATH, config, reloadConfig, saveConfig, q, runDdl, ensureSchema, close, connect }
