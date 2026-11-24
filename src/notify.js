'use strict'

// Notifications: email (SMTP), Microsoft Teams (webhook), WhatsApp (Cloud API).

const { config } = require('./db')

async function postJson(url, body, headers = {}) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { ok: res.ok, status: res.status, text: (await res.text()).slice(0, 300) }
  } catch (e) { return { ok: false, error: String(e.message || e) } }
}

async function sendEmail({ subject = '', text = '', html = null, to = null } = {}) {
  const cfg = config().email || {}
  const pass = cfg.pass || (cfg.passEnv ? process.env[cfg.passEnv] : '')
  if (!cfg.enabled || !cfg.user || !pass) return { ok: false, error: 'email not configured' }
  let nodemailer
  try { nodemailer = require('nodemailer') } catch { return { ok: false, error: 'nodemailer not installed' } }
  const recipients = (to ? (Array.isArray(to) ? to : [to]) : (cfg.to || [])).filter(Boolean)
  if (!recipients.length) return { ok: false, error: 'no recipients' }
  const cc = (Array.isArray(cfg.cc) ? cfg.cc : (cfg.cc ? [cfg.cc] : [])).filter(Boolean)
  const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.from || cfg.user}>` : (cfg.from || cfg.user)
  try {
    const t = nodemailer.createTransport({ host: cfg.host, port: Number(cfg.port) || 587, secure: Boolean(cfg.secure), auth: { user: cfg.user, pass }, connectionTimeout: 20000, greetingTimeout: 15000 })
    const info = await t.sendMail({ from, to: recipients.join(', '), ...(cc.length ? { cc: cc.join(', ') } : {}), replyTo: cfg.replyTo || cfg.from || cfg.user, subject, text, ...(html ? { html } : {}) })
    return { ok: true, messageId: info.messageId, accepted: info.accepted }
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 300) } }
}

async function sendTeams(text) {
  const cfg = config().notify || {}
  if (!cfg.teamsWebhook) return { ok: false, error: 'teams webhook not configured' }
  return postJson(cfg.teamsWebhook, { text })
}

async function sendWhatsApp(text) {
  const cfg = config().notify || {}
  const w = cfg.whatsapp || {}
  if (!w.token || !w.phoneNumberId || !w.to) return { ok: false, error: 'whatsapp not configured' }
  return postJson(`https://graph.facebook.com/${cfg.apiVersion || 'v21.0'}/${w.phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', to: String(w.to), type: 'text', text: { body: String(text).slice(0, 4000) } },
    { Authorization: 'Bearer ' + w.token })
}

async function notify(subject, text, html = null) {
  const cfg = config().notify || {}
  const channels = cfg.channels || ['email']
  const out = {}
  const body = `${subject}\n\n${text}`
  if (channels.includes('email')) out.email = await sendEmail({ subject, text, html })
  if (channels.includes('teams')) out.teams = await sendTeams(body)
  if (channels.includes('whatsapp')) out.whatsapp = await sendWhatsApp(body)
  return out
}

function status() {
  const cfg = config()
  const e = cfg.email || {}
  const n = cfg.notify || {}
  const pass = e.pass || (e.passEnv ? process.env[e.passEnv] : '')
  return {
    email: Boolean(e.enabled && e.user && pass),
    teams: Boolean(n.teamsWebhook),
    whatsapp: Boolean(n.whatsapp && n.whatsapp.token && n.whatsapp.phoneNumberId && n.whatsapp.to),
    channels: n.channels || ['email'],
  }
}

module.exports = { sendEmail, sendTeams, sendWhatsApp, notify, status }
