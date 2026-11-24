#!/usr/bin/env python3
"""fbmobile.py — read a Facebook Page's recent posts from the mobile HTML site
(mbasic.facebook.com), signed in through the SAME persistent Chrome profile the
rest of Radar uses.

Why this exists
---------------
The normal www.facebook.com app is a heavily obfuscated JS shell: reading a
per-post permalink out of it is unreliable. The mobile HTML site serves each
post as a plain block with its exact story permalink in an <a href>, so this is
the RELIABLE source of {text, permalink, time, reactions, comments} per post.

Usage
  fbmobile.py --url "https://www.facebook.com/PageName" [--max 25] [--wait 20]
      -> {"ok":true,"posts":[{"url":...,"text":...,"posted_at":...,
                              "reactions":N,"comments":N,"shares":N}]}
      -> {"ok":false,"error":"..."}   (exit 1)
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass


def fail(msg):
    print(json.dumps({'ok': False, 'error': str(msg)[:400]}))
    sys.exit(1)


_MONTHS = ('january february march april may june july august september october '
           'november december').split()


def parse_fb_time(txt, now=None):
    if not txt:
        return None
    now = now or datetime.now(timezone.utc)
    s = str(txt).strip().lower()
    try:
        m = re.match(r'^(\d+)\s*(m|min|mins|minute|minutes)\b', s)
        if m:
            return (now - timedelta(minutes=int(m.group(1)))).isoformat()
        m = re.match(r'^(\d+)\s*(h|hr|hrs|hour|hours)\b', s)
        if m:
            return (now - timedelta(hours=int(m.group(1)))).isoformat()
        if s.startswith('just now') or s in ('now', 'a few seconds ago'):
            return now.isoformat()
        if s.startswith('yesterday'):
            return (now - timedelta(days=1)).isoformat()
        m = re.match(r'^(\d+)\s*(d|day|days)\b', s)
        if m:
            return (now - timedelta(days=int(m.group(1)))).isoformat()
        m = re.match(r'^(\d+)\s*(w|week|weeks)\b', s)
        if m:
            return (now - timedelta(weeks=int(m.group(1)))).isoformat()
        mm = re.search(r'\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b', s)
        if mm:
            abbr = mm.group(1)
            month = None
            for i, name in enumerate(_MONTHS):
                if name.startswith(abbr):
                    month = i + 1
                    break
            if month:
                day_m = re.search(r'\b(\d{1,2})\b', s)
                year_m = re.search(r'\b(20\d{2})\b', s)
                hm = re.search(r'(\d{1,2}):(\d{2})\s*(am|pm)?', s)
                if day_m:
                    day = int(day_m.group(1))
                    year = int(year_m.group(1)) if year_m else now.year
                    hour, minute = 12, 0
                    if hm:
                        hour = int(hm.group(1)); minute = int(hm.group(2)); ap_ = hm.group(3)
                        if ap_ == 'pm' and hour < 12:
                            hour += 12
                        if ap_ == 'am' and hour == 12:
                            hour = 0
                    dt = datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
                    if not year_m and dt > now + timedelta(days=1):
                        dt = dt.replace(year=year - 1)
                    return dt.isoformat()
    except Exception:
        return None
    return None


def mobile_url(url):
    """Turn any facebook.com URL into its mbasic.facebook.com equivalent."""
    try:
        from urllib.parse import urlparse, urlunparse
        p = urlparse(url)
        host = 'mbasic.facebook.com'
        return urlunparse((p.scheme or 'https', host, p.path or '/', p.params, p.query, ''))
    except Exception:
        return url


# Runs in the page. mbasic serves each post as a plain block; we key off the
# story permalink anchor and read the post's text + counts from that block. Falls
# back to the app's role="article" blocks if mbasic redirected to www.
POST_JS = r"""
() => {
  const abs = (h) => { try { return new URL(h, 'https://www.facebook.com').href } catch { return null } };
  const numOf = (s) => {
    if (!s) return null;
    const m = String(s).replace(/,/g,'').match(/([\d.]+)\s*([KkMm])?/);
    if (!m) return null;
    let n = parseFloat(m[1]); if (isNaN(n)) return null;
    const u = (m[2]||'').toLowerCase(); if (u==='k') n*=1e3; else if (u==='m') n*=1e6;
    return Math.round(n);
  };
  // Only the path decides whether a link is a real post permalink. Facebook
  // serves www / web / m hosts interchangeably, and mbasic now redirects to www,
  // so this must work on the app markup too. The Reels/Photos tabs are excluded.
  const isPerma = (h) => {
    if (!h) return false;
    try {
      const u = new URL(h, 'https://www.facebook.com');
      if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return false;
      const p = u.pathname || '';
      if (/^\/reel\/?$/.test(p)) return false;
      if (/^\/(permalink\.php|story\.php)$/.test(p)) return true;
      if (/\/(posts|reel|videos|photos)\//.test(p)) return true;
      if (/\/photo\.php$/.test(p)) return true;
      if (/^\/photo\/?$/.test(p) && u.searchParams.get('fbid')) return true;
      return false;
    } catch { return false; }
  };
  const clean = (h) => {
    try {
      const u = new URL(h, 'https://www.facebook.com'); u.hostname = 'www.facebook.com'; u.hash = '';
      if (/\/(posts|reel|videos|photos)\//.test(u.pathname)) { u.search = ''; }
      else {
        const keep = new URLSearchParams();
        for (const k of ['story_fbid','id','fbid','v']) { const val = u.searchParams.get(k); if (val) keep.set(k, val); }
        u.search = keep.toString();
      }
      return u.href;
    } catch { return h; }
  };
  const findPerma = (el) => {
    for (let p = el, i = 0; p && i < 18; i++, p = p.parentElement) {
      const a = Array.from(p.querySelectorAll('a[href]')).find((x) => isPerma(x.getAttribute('href')));
      if (a) return a;
    }
    return null;
  };
  const timeOf = (root) => {
    for (const el of root.querySelectorAll('[aria-label]')) {
      const v = (el.getAttribute('aria-label') || '').trim();
      if (v && v.length < 60 && /\d|yesterday|just now/i.test(v) &&
          /\d{1,2}:\d{2}|yesterday|just now|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(v)) return v;
    }
    for (const el of root.querySelectorAll('a,span,abbr')) {
      const t = ((el.innerText || el.textContent) || '').trim();
      if (t && t.length < 40 && /\d|yesterday|min|hour|hr|just now|\bam\b|\bpm\b/i.test(t) &&
          !/like|comment|share|follow|reaction/i.test(t)) return t;
    }
    return '';
  };
  // Post bodies: the message container is the reliable marker on the current
  // layout; mbasic's plain blocks and role="article" are kept as fallbacks.
  const roots = Array.from(document.querySelectorAll('[data-ad-comet-preview="message"],[data-ad-preview="message"]'));
  roots.push(...Array.from(document.querySelectorAll('article, div[data-ft], #m_story_permalink_view, div[role="article"]')));
  const out = []; const seen = new Set();
  for (const root of roots) {
    const a = findPerma(root);
    if (!a) continue;
    const permalink = clean(a.getAttribute('href'));
    if (!permalink || seen.has(permalink)) continue;
    seen.add(permalink);
    let body = '';
    const isMsg = (root.getAttribute('data-ad-comet-preview') === 'message' || root.getAttribute('data-ad-preview') === 'message');
    const msg = isMsg ? root : root.querySelector('[data-ad-comet-preview="message"],[data-ad-preview="message"]');
    if (msg) body = msg.innerText || msg.textContent || '';
    if (!body || body.length < 4) {
      body = Array.from(root.querySelectorAll('p')).map((p) => (p.innerText || p.textContent) || '').join(' ').replace(/\s+/g,' ').trim();
    }
    if (!body || body.length < 4) {
      let best = '';
      for (const d of root.querySelectorAll('div[dir="auto"],span[dir="auto"]')) {
        const t = ((d.innerText || d.textContent) || '').trim();
        if (t.length > best.length) best = t;
      }
      body = best || (root.innerText || root.textContent || '');
    }
    body = String(body).replace(/\s+/g,' ').trim();
    body = body.replace(/^.{0,60}?·\s*\d+\s*[a-z]*\s*·\s*(Author\s*)?/i, '')
               .replace(/\s*(See more|See translation|Full Story|All reactions|Like|Comment|Share|Reply)\s*$/i, '')
               .trim().slice(0, 1400);
    const timeText = timeOf(root);
    const bt = root.innerText || root.textContent || '';
    let reactions = null;
    const rl = root.querySelector('[aria-label*="reaction" i],[aria-label*="reactions" i]');
    if (rl) reactions = numOf(rl.getAttribute('aria-label'));
    if (reactions == null) { const rx = bt.match(/([\d.,]+\s*[KkMm]?)\s*Reaction/i); if (rx) reactions = numOf(rx[1]); }
    const cm = bt.match(/([\d.,]+\s*[KkMm]?)\s*Comment/i);
    const sh = bt.match(/([\d.,]+\s*[KkMm]?)\s*Share/i);
    out.push({ url: permalink, text: body, time_text: timeText,
               reactions, comments: cm ? numOf(cm[1]) : null, shares: sh ? numOf(sh[1]) : null });
    if (out.length >= 40) break;
  }
  return out;
}
"""


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--url', required=True)
    ap.add_argument('--wait', type=int, default=20)
    ap.add_argument('--max', type=int, default=25)
    ap.add_argument('--headful', action='store_true')
    ap.add_argument('--user-data-dir', dest='user_data_dir')
    ap.add_argument('--profile-directory', dest='profile_directory')
    a = ap.parse_args()

    user_data_dir = a.user_data_dir or os.environ.get('RADAR_CHROME_PROFILE') or None
    profile_directory = a.profile_directory or os.environ.get('RADAR_CHROME_PROFILE_DIR') or None
    headful = a.headful or os.environ.get('RADAR_HEADFUL') == '1'
    if not user_data_dir:
        fail('no Chrome profile folder given')

    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        fail('Playwright is not installed. Run:  python -m pip install playwright')

    args = ['--disable-blink-features=AutomationControlled', '--no-first-run',
            '--no-default-browser-check', '--disable-dev-shm-usage']
    if profile_directory:
        args.append('--profile-directory=' + profile_directory)
    if headful:
        args += ['--window-position=-32000,-32000', '--window-size=980,1400']

    launch = {
        'user_data_dir': user_data_dir,
        'headless': not headful,
        'args': args,
        'viewport': {'width': 980, 'height': 1400},
        'locale': 'en-US',
        'timezone_id': os.environ.get('RADAR_TZ', 'Asia/Dhaka'),
        'ignore_default_args': ['--enable-automation'],
    }
    chrome_bin = os.environ.get('CHROME_BIN')
    if chrome_bin and os.path.isfile(chrome_bin):
        launch['executable_path'] = chrome_bin
    else:
        launch['channel'] = 'chrome'

    ms = max(5, a.wait) * 1000
    # mbasic.facebook.com now redirects to the www app (and a reduced "lite"
    # variant), so read the page's own www URL directly — that is where the post
    # bodies and their permalinks actually live.
    url = a.url
    posts = []
    try:
        with sync_playwright() as p:
            try:
                ctx = p.chromium.launch_persistent_context(**launch)
            except Exception as e:
                msg = str(e)
                if 'ProcessSingleton' in msg or 'lock' in msg.lower():
                    fail('That Chrome profile is already in use. Close the login window and try again.')
                fail('could not start the browser: ' + msg[:250])
            try:
                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                page.set_default_timeout(ms)
                now = datetime.now(timezone.utc)
                seen = set()
                cur = url
                # mbasic paginates with a "See more stories" link. Walk up to a few
                # pages so we capture the recent posts, not just the very top ones.
                for _pg in range(5):
                    try:
                        page.goto(cur, wait_until='domcontentloaded', timeout=ms)
                    except Exception as e:
                        if 'net::' in str(e) and _pg == 0:
                            fail('could not reach the page: ' + str(e)[:200])
                        break
                    # mbasic now redirects to the www app, which draws lazily.
                    # Give the app time to settle, then scroll to trigger posts.
                    try:
                        page.wait_for_load_state('networkidle', timeout=min(ms, 10000))
                    except Exception:
                        pass
                    page.wait_for_timeout(2500)
                    for _ in range(6):
                        try:
                            n = page.evaluate(
                                "() => document.querySelectorAll("
                                "'[data-ad-comet-preview=\"message\"],[data-ad-preview=\"message\"],"
                                "article, div[data-ft], div[role=\"article\"]').length") or 0
                            if n >= a.max:
                                break
                            if n == 0 and _ >= 4:
                                break
                            page.mouse.wheel(0, 2400)
                            page.wait_for_timeout(1200)
                        except Exception:
                            break
                    try:
                        rows = page.evaluate(POST_JS) or []
                    except Exception:
                        rows = []
                    for r in rows:
                        if not r or not r.get('url') or r['url'] in seen:
                            continue
                        seen.add(r['url'])
                        reactions = r.get('reactions'); comments = r.get('comments'); shares = r.get('shares')
                        engagement = sum(v for v in (reactions, comments, shares) if isinstance(v, (int, float)))
                        posts.append({
                            'url': r.get('url'),
                            'text': (r.get('text') or '')[:1400],
                            'posted_at': parse_fb_time(r.get('time_text'), now),
                            'reactions': reactions, 'comments': comments, 'shares': shares,
                            'engagement': int(engagement),
                        })
                    if len(posts) >= a.max:
                        break
                    # Find the "See more stories" link for the next page (mbasic only).
                    try:
                        nxt = page.evaluate(
                            "() => { const a=[...document.querySelectorAll('a[href]')]"
                            ".find(x=>/see more stories|more stories|show more/i.test((x.textContent||''))); "
                            "return a ? a.href : null }")
                    except Exception:
                        nxt = None
                    if not nxt or 'mbasic.facebook.com' not in str(nxt):
                        break
                    cur = nxt
            finally:
                try:
                    ctx.close()
                except Exception:
                    pass
    except SystemExit:
        raise
    except Exception as e:
        fail('browser error: ' + str(e)[:250])

    print(json.dumps({'ok': True, 'url': a.url, 'mobile_url': url, 'posts': posts}, ensure_ascii=False))


if __name__ == '__main__':
    main()
