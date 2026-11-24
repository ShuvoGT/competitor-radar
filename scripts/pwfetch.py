#!/usr/bin/env python3
"""pwfetch.py — render a page with Playwright, driving the real Chrome.

Why this exists
---------------
`chrome --dump-dom` takes one snapshot and cannot wait for anything. On a
signed-in Facebook, X, TikTok or Quora page the app is still drawing when the
snapshot is taken, so the dump comes back empty. Playwright drives a real
browser: it can wait for the network to settle, scroll to trigger lazy loading,
and read the text the user would actually see.

It uses the SAME persistent profile folder as the login browser, so a one-time
sign-in carries over.

Usage
  pwfetch.py --url "https://..." [--wait 20] [--max 12000] [--media] [--headful]
      -> {"ok":true,"url":...,"title":...,"text":"...","media":[...]}
      -> {"ok":false,"error":"..."}  (exit 1)

Install once:
  python -m pip install playwright
(No browser download is needed — it uses the Chrome already installed.)
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

MEDIA_EXT = re.compile(r'\.(mp4|webm|m3u8|mov|m4v|jpg|jpeg|png|webp|gif)(?:[?#]|$)', re.I)


def extract_media(html, limit=40):
    urls, seen = [], set()

    def add(u):
        u = (u or '').replace('\\/', '/').replace('&amp;', '&').strip()
        if not u.startswith('http') or u in seen:
            return
        low = u.lower()
        if ('rsrc.php' in low or '.js' in low or '.css' in low or '/rsrc' in low or 'pixel' in low):
            return
        seen.add(u)
        urls.append(u)

    for m in re.finditer(r'(?:src|poster|content)=["\'](https?://[^"\']+)["\']', html, flags=re.I):
        u = m.group(1)
        if MEDIA_EXT.search(u) or 'scontent' in u or 'fbcdn' in u:
            add(u)
    for key in ('video_url', 'playable_url', 'playable_url_quality_hd', 'browser_native_hd_url',
                'browser_native_sd_url', 'preview_image_url'):
        for m in re.finditer(r'"' + key + r'":"(https?:[^"]+)"', html):
            add(m.group(1))
    for m in re.finditer(r'https://[^"\'\s<>]*(?:fbcdn|scontent)[^"\'\s<>]*', html):
        add(m.group(0))
    return urls[:limit]


def media_kind(u):
    if re.search(r'\.(mp4|webm|m3u8|mov|m4v)(?:[?#]|$)', u, re.I):
        return 'video'
    if re.search(r'\.(jpg|jpeg|png|webp|gif)(?:[?#]|$)', u, re.I):
        return 'image'
    return 'other'


def fail(msg):
    print(json.dumps({'ok': False, 'error': str(msg)[:400]}))
    sys.exit(1)


# Facebook shows the post time as the timestamp link text: "2h", "45m",
# "Yesterday at 5:00 AM", "20 September at 14:03", "September 20, 2025". Turn
# whatever we can into an ISO timestamp; return None when it is not parseable
# (the report then falls back to when the post was first seen).
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
        # Absolute: "20 september at 14:03" | "september 20 at 2:00 pm" |
        # "september 20, 2025" | "20 september 2025"
        month = None
        mm = re.search(r'\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b', s)
        if mm:
            abbr = mm.group(1)
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
                    hour = int(hm.group(1))
                    minute = int(hm.group(2))
                    ap_ = hm.group(3)
                    if ap_ == 'pm' and hour < 12:
                        hour += 12
                    if ap_ == 'am' and hour == 12:
                        hour = 0
                dt = datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
                # A date with no year that lands in the future belongs to last year.
                if not year_m and dt > now + timedelta(days=1):
                    dt = dt.replace(year=year - 1)
                return dt.isoformat()
    except Exception:
        return None
    return None


# Runs in the page. Returns one entry per post container with its body text,
# exact permalink (tracking params stripped), the timestamp link text and the
# reaction / comment / share counts where Facebook renders them.
POST_JS = r"""
() => {
  const numOf = (s) => {
    if (!s) return null;
    const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([KkMm])?/);
    if (!m) return null;
    let n = parseFloat(m[1]); if (isNaN(n)) return null;
    const u = (m[2] || '').toLowerCase();
    if (u === 'k') n *= 1e3; else if (u === 'm') n *= 1e6;
    return Math.round(n);
  };
  // A real per-post permalink. Only the PATH matters (Facebook serves www / web /
  // m hosts interchangeably). The Reels/Photos nav tabs and comment links are not
  // posts, so they are excluded.
  const isPerma = (h) => {
    if (!h) return false;
    try {
      const u = new URL(h, location.origin);
      if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return false;
      const p = u.pathname || '';
      if (/^\/reel\/?$/.test(p)) return false;                 // the Reels tab
      if (/^\/(permalink\.php|story\.php)$/.test(p)) return true;
      if (/\/(posts|reel|videos|photos)\//.test(p)) return true;
      if (/\/photo\.php$/.test(p)) return true;
      if (/^\/photo\/?$/.test(p) && u.searchParams.get('fbid')) return true;
      return false;
    } catch { return false; }
  };
  const clean = (h) => {
    try {
      const u = new URL(h, location.origin);
      if (/(^|\.)facebook\.com$/i.test(u.hostname)) u.hostname = 'www.facebook.com';
      u.hash = '';
      if (/\/(posts|reel|videos|photos)\//.test(u.pathname)) {
        u.search = '';
      } else {
        const keep = new URLSearchParams();
        for (const k of ['story_fbid', 'id', 'fbid', 'v']) { const val = u.searchParams.get(k); if (val) keep.set(k, val); }
        u.search = keep.toString();
      }
      return u.href;
    } catch { return h; }
  };
  // The permalink for a post body: an anchor inside the element, or the nearest
  // ancestor that carries one. On the current Facebook Page layout the whole post
  // (message included) is wrapped in its permalink anchor; on older markup the
  // role="article" container already holds it. This handles both.
  const findPerma = (el) => {
    for (let p = el, i = 0; p && i < 18; i++, p = p.parentElement) {
      const a = Array.from(p.querySelectorAll('a[href]')).find((x) => isPerma(x.getAttribute('href')));
      if (a) return a;
    }
    return null;
  };
  // Post time: Facebook renders it as a date aria-label (the timestamp link), or
  // as the short text of a timestamp link ("2h", "Yesterday at 5:00 AM"). It
  // lives in the post header/footer, OUTSIDE the message container, so walk up
  // the block until we find it (stop at the first level that has one).
  const timeOf = (root) => {
    for (let p = root, i = 0; p && i < 16; i++, p = p.parentElement) {
      for (const el of p.querySelectorAll('[aria-label]')) {
        const v = (el.getAttribute('aria-label') || '').trim();
        if (v && v.length < 60 && /\d|yesterday|just now/i.test(v) &&
            /\d{1,2}:\d{2}|yesterday|just now|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(v)) return v;
      }
      for (const el of p.querySelectorAll('a,span,abbr')) {
        const t = ((el.innerText || el.textContent) || '').trim();
        if (t && t.length < 24 && /^(yesterday|\d+\s*(s|m|h|d|w|y|min|minute|hour|hr|day|week))\b/i.test(t)) return t;
      }
    }
    return '';
  };
  // The message container is the reliable marker for a post body on the current
  // layout; also try the old role="article" containers so both markups work.
  const roots = Array.from(document.querySelectorAll('[data-ad-comet-preview="message"],[data-ad-preview="message"]'));
  roots.push(...Array.from(document.querySelectorAll('div[role="article"]')));
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
      // Reels / newer posts don't use the message container — the caption is
      // usually the longest dir="auto" text block in the post.
      let best = '';
      for (const d of root.querySelectorAll('div[dir="auto"],span[dir="auto"]')) {
        const t = ((d.innerText || d.textContent) || '').trim();
        if (t.length > best.length) best = t;
      }
      body = best || (root.innerText || root.textContent || '');
    }
    body = String(body).replace(/\s+/g, ' ').trim();
    // Strip the FB chrome that leaks in when we fall back to a wider block.
    body = body.replace(/^.{0,60}?·\s*\d+\s*[a-z]*\s*·\s*(Author\s*)?/i, '');
    body = body.replace(/\s*(See more|See translation|All reactions|Most relevant|Like|Comment|Share|Reply)\s*$/i, '').trim();
    body = body.slice(0, 1400);
    const timeText = timeOf(root);
    let reactions = null;
    const rl = root.querySelector('[aria-label*="reaction" i],[aria-label*="reactions" i],[aria-label*="Like:" i],[aria-label*="reacted" i]');
    if (rl) reactions = numOf(rl.getAttribute('aria-label'));
    const at = root.innerText || root.textContent || '';
    const cm = at.match(/([\d.,]+\s*[KkMm]?)\s*comments?/i);
    const sh = at.match(/([\d.,]+\s*[KkMm]?)\s*shares?/i);
    out.push({
      text: body, permalink, time_text: timeText,
      reactions, comments: cm ? numOf(cm[1]) : null, shares: sh ? numOf(sh[1]) : null,
    });
    if (out.length >= 30) break;
  }
  return out;
}
"""


def extract_posts(page):
    try:
        rows = page.evaluate(POST_JS) or []
    except Exception:
        return []
    now = datetime.now(timezone.utc)
    posts = []
    for r in rows:
        if not r or not r.get('permalink'):
            continue
        reactions = r.get('reactions')
        comments = r.get('comments')
        shares = r.get('shares')
        engagement = sum(v for v in (reactions, comments, shares) if isinstance(v, (int, float)))
        posts.append({
            'url': r.get('permalink'),
            'text': (r.get('text') or '')[:1400],
            'posted_at': parse_fb_time(r.get('time_text'), now),
            'reactions': reactions, 'comments': comments, 'shares': shares,
            'engagement': int(engagement),
        })
    return posts


# --- Share -> Copy link ----------------------------------------------------
# A Facebook Page feed often hides the post permalink from the DOM, but the UI
# always has Share -> "Copy link", which copies the post's CANONICAL link. The
# same post block carries the post date in an aria-label, so this pass returns
# {text, date, exact link} even when the anchor is missing.
SHARE_SEL = '[aria-label="Send this to friends or post it on your profile."]'

SHARE_BLOCK_JS = r"""
el => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const isPerma = (h) => !!h && /\/(posts|reel|videos|photos)\b/.test(h) && !/comment_id|reactions/.test(h);
  let block = el, text = '';
  for (let i = 0; i < 18 && block; i++, block = block.parentElement) {
    const m = block.querySelector && block.querySelector('[data-ad-comet-preview="message"],[data-ad-preview="message"]');
    if (m) { text = clean(m.innerText); break; }
  }
  if (!text) {
    // No message marker (video / image post): take the longest text block near.
    let best = '';
    for (let p = el, i = 0; p && i < 12; i++, p = p.parentElement) {
      for (const d of p.querySelectorAll('div[dir="auto"],span[dir="auto"]')) {
        const t = clean(d.innerText || d.textContent);
        if (t.length > best.length && t.length < 1400) best = t;
      }
      if (best.length > 60) break;
    }
    text = best;
  }
  const scan = block || el;
  let time = '', perma = '';
  for (const e of scan.querySelectorAll('[aria-label]')) {
    const v = (e.getAttribute('aria-label') || '').trim();
    if (v && /\d{1,2}:\d{2}|yesterday|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(v)) { time = v; break; }
  }
  for (const a of scan.querySelectorAll('a[href]')) {
    const h = a.getAttribute('href') || '';
    if (isPerma(h)) { try { const u = new URL(h, location.origin); perma = u.origin + u.pathname; } catch {} break; }
  }
  return { text, time, perma };
}
"""


def collect_share_posts(page, limit=12):
    out = []
    try:
        btns = page.locator(SHARE_SEL)
        n = btns.count()
    except Exception:
        return out
    now = datetime.now(timezone.utc)
    for i in range(min(n, limit)):
        btn = btns.nth(i)
        try:
            info = btn.evaluate(SHARE_BLOCK_JS) or {}
        except Exception:
            info = {}
        link = ''
        try:
            btn.scroll_into_view_if_needed(timeout=3000)
            btn.click(timeout=5000)
            page.wait_for_timeout(1100)
            cl = page.get_by_text('Copy link', exact=True)
            for j in range(cl.count()):
                try:
                    cl.nth(j).click(timeout=3000)
                    break
                except Exception:
                    pass
            page.wait_for_timeout(600)
            link = (page.evaluate("() => navigator.clipboard.readText().catch(() => '')") or '').strip()
        except Exception:
            link = ''
        finally:
            try:
                page.keyboard.press('Escape')
            except Exception:
                pass
            page.wait_for_timeout(250)
        if not link.startswith('http'):
            link = info.get('perma') or ''
        text = (info.get('text') or '').strip()
        if not link and not text:
            continue
        out.append({
            'url': link,
            'text': text[:1400],
            'posted_at': parse_fb_time(info.get('time'), now),
            'time_text': info.get('time') or '',
        })
    return out


def _norm_txt(s):
    return re.sub(r'[^\w\u0980-\u09FF]+', '', str(s or '').lower())


def _txt_overlap(a, b):
    x, y = _norm_txt(a), _norm_txt(b)
    if len(x) < 12 or len(y) < 12:
        return False
    sh, lg = (x, y) if len(x) <= len(y) else (y, x)
    w = min(25, len(sh))
    for i in range(0, len(sh) - w + 1, 8):
        if sh[i:i + w] in lg:
            return True
    return False


def merge_share_posts(posts, share):
    for s in share:
        match = None
        for p in posts:
            if (s.get('url') and p.get('url') == s['url']) or _txt_overlap(p.get('text'), s.get('text')):
                match = p
                break
        if match:
            if s.get('url') and not match.get('url'):
                match['url'] = s['url']
            if not match.get('text') and s.get('text'):
                match['text'] = s['text']
            if s.get('posted_at') and not match.get('posted_at'):
                match['posted_at'] = s['posted_at']
        elif s.get('text') or s.get('url'):
            posts.append({
                'url': s.get('url') or '', 'text': s.get('text') or '',
                'posted_at': s.get('posted_at'),
                'reactions': None, 'comments': None, 'shares': None, 'engagement': 0,
            })
    return posts


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--url', required=True)
    ap.add_argument('--wait', type=int, default=20, help='seconds to allow for loading')
    ap.add_argument('--max', type=int, default=12000)
    ap.add_argument('--media', action='store_true')
    ap.add_argument('--headful', action='store_true',
                    help='run a real visible window, positioned off screen. Hardest to block.')
    ap.add_argument('--user-data-dir', dest='user_data_dir')
    ap.add_argument('--profile-directory', dest='profile_directory')
    ap.add_argument('--capture', default=None,
                    help='collect the bodies of network responses whose URL contains this text '
                         '(used to read the data a JS app loads, e.g. Google Ads Transparency)')
    ap.add_argument('--posts', action='store_true',
                    help='also extract individual posts with their exact permalink, time and '
                         'reaction/comment/share counts (Facebook page feeds)')
    a = ap.parse_args()

    user_data_dir = a.user_data_dir or os.environ.get('RADAR_CHROME_PROFILE') or None
    profile_directory = a.profile_directory or os.environ.get('RADAR_CHROME_PROFILE_DIR') or None
    headful = a.headful or os.environ.get('RADAR_HEADFUL') == '1'
    captured = []
    if not user_data_dir:
        fail('no Chrome profile folder given')

    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        fail('Playwright is not installed. Run:  python -m pip install playwright')

    args = [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run', '--no-default-browser-check',
        '--disable-dev-shm-usage',
    ]
    if profile_directory:
        args.append('--profile-directory=' + profile_directory)
    if headful:
        # A real window, parked far off screen so it never appears or steals focus.
        args += ['--window-position=-32000,-32000', '--window-size=1366,900']

    launch = {
        'user_data_dir': user_data_dir,
        'headless': not headful,
        'args': args,
        'viewport': {'width': 1366, 'height': 900},
        'locale': 'en-US',
        'timezone_id': os.environ.get('RADAR_TZ', 'Asia/Dhaka'),
        'ignore_default_args': ['--enable-automation'],
        # Needed to read a post's canonical link via Share -> Copy link.
        'permissions': ['clipboard-read', 'clipboard-write'],
    }
    chrome_bin = os.environ.get('CHROME_BIN')
    if chrome_bin and os.path.isfile(chrome_bin):
        launch['executable_path'] = chrome_bin
    else:
        launch['channel'] = 'chrome'          # the installed Chrome, not a bundled build

    ms = max(5, a.wait) * 1000
    try:
        with sync_playwright() as p:
            try:
                ctx = p.chromium.launch_persistent_context(**launch)
            except Exception as e:
                msg = str(e)
                if 'channel' in msg.lower() or 'executable' in msg.lower():
                    fail('Chrome could not be launched by Playwright: ' + msg[:250])
                if 'ProcessSingleton' in msg or 'lock' in msg.lower():
                    fail('That Chrome profile is already in use. Close the login window and try again.')
                fail('could not start the browser: ' + msg[:250])

            try:
                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                page.set_default_timeout(ms)

                # Capture the data a JS app loads over the network (e.g. the
                # Google Ads Transparency search call). Registered before goto so
                # nothing fires before the listener is attached.
                captured = []
                if a.capture:
                    needle = a.capture

                    def on_response(resp):
                        try:
                            if needle in resp.url:
                                body = resp.text()
                                if body:
                                    captured.append(body[:400000])
                        except Exception:
                            pass
                    try:
                        page.on('response', on_response)
                    except Exception:
                        pass

                try:
                    page.goto(a.url, wait_until='domcontentloaded', timeout=ms)
                except Exception as e:
                    if 'net::' in str(e):
                        fail('could not reach the page: ' + str(e)[:200])
                # Let the app finish drawing. networkidle often never fires on
                # social feeds, so a failure here is not fatal.
                try:
                    page.wait_for_load_state('networkidle', timeout=min(ms, 12000))
                except Exception:
                    pass
                page.wait_for_timeout(2000)

                # Cloudflare and similar show "Just a moment..." first and then
                # replace the page. Wait it out instead of reading the notice.
                challenge = re.compile(
                    r'just a moment|checking your browser|verifying you are human|'
                    r'attention required|please wait while we verify', re.I)
                for _ in range(10):
                    try:
                        t = page.title() or ''
                    except Exception:
                        break
                    if not challenge.search(t):
                        break
                    page.wait_for_timeout(2500)

                # A nudge down the page starts lazy-loaded feed content.
                try:
                    page.mouse.wheel(0, 1600)
                    page.wait_for_timeout(1500)
                except Exception:
                    pass

                # If we are waiting on a data call and it has not arrived yet,
                # give it a little more time and another scroll to trigger it.
                if a.capture and not captured:
                    try:
                        page.mouse.wheel(0, 1600)
                        page.wait_for_timeout(3500)
                    except Exception:
                        pass

                title = ''
                try:
                    title = (page.title() or '').strip()[:200]
                except Exception:
                    pass
                text = ''
                try:
                    text = page.evaluate("() => document.body ? document.body.innerText : ''") or ''
                except Exception:
                    pass
                html = ''
                if a.media:
                    try:
                        html = page.content() or ''
                    except Exception:
                        pass
                posts = []
                if a.posts:
                    # Scroll the whole feed so we load the actual timeline posts,
                    # not just the pinned reels at the very top. We keep scrolling
                    # until the post count stops growing (or we hit the cap), so the
                    # capture sees the same posts the page-text read sees.
                    try:
                        last = 0
                        for _ in range(12):
                            n = page.evaluate(
                                "() => document.querySelectorAll("
                                "'[data-ad-comet-preview=\"message\"],[data-ad-preview=\"message\"],"
                                "div[role=\"article\"]').length") or 0
                            if n >= 30:
                                break
                            if n == last and _ >= 3:
                                break
                            last = n
                            page.mouse.wheel(0, 2400)
                            page.wait_for_timeout(1700)
                    except Exception:
                        pass
                    posts = extract_posts(page)
                    # The Page feed often hides the permalink; the Share ->
                    # Copy link flow supplies it (plus the post date).
                    try:
                        share = collect_share_posts(page)
                        if share:
                            posts = merge_share_posts(posts, share)
                    except Exception:
                        pass
            finally:
                try:
                    ctx.close()
                except Exception:
                    pass
    except SystemExit:
        raise
    except Exception as e:
        fail('browser error: ' + str(e)[:250])

    text = re.sub(r'[ \t\r\f\v]+', ' ', text)
    text = re.sub(r'\n\s*\n+', '\n', text).strip()
    if not text and not captured and not (a.posts and posts):
        fail('the page rendered but had no readable text (it may be blocked or still loading)')

    out = {'ok': True, 'url': a.url, 'title': title, 'text': text[:a.max], 'engine': 'playwright'}
    if a.media and html:
        out['media'] = [{'url': u, 'kind': media_kind(u)} for u in extract_media(html)]
    if captured:
        out['captured'] = captured
    if a.posts:
        out['posts'] = posts
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main()
