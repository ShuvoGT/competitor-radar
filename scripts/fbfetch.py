#!/usr/bin/env python3
"""fbfetch.py — fetch a public Facebook page / Ad Library / post as rendered text.

Facebook blocks plain HTTP clients ("Facebook is not available on this browser"),
so this renders the URL in headless Chrome (real browser engine) and returns the
visible text. Use it for competitor Facebook research.

Usage:
  fbfetch.py --url "https://www.facebook.com/ads/library/?..." [--wait 8] [--max 12000]
      -> {"ok":true,"url":...,"title":...,"text":"..."}  (text trimmed)
      -> {"ok":false,"error":"..."}  (exit 1)

  # Ad Library search for a competitor (convenience):
  fbfetch.py --adlib "Hubstaff" [--country ALL] [--active active|all]
  fbfetch.py --page "Hubstaff"           # try the public page
"""
import argparse
import html
import json
import os
import re
import subprocess
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass


def find_chrome():
    env = os.environ.get('CHROME_BIN')
    if env and os.path.isfile(env):
        return env
    candidates = []
    if os.name == 'nt':
        for root in (os.environ.get('PROGRAMFILES', 'C:\\Program Files'),
                     os.environ.get('PROGRAMFILES(X86)', 'C:\\Program Files (x86)'),
                     os.environ.get('LOCALAPPDATA', '')):
            candidates += [
                os.path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
                os.path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            ]
    else:
        candidates += [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
        ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return ''


_CHROME_MAJOR = None


def chrome_major(chrome, user_data_dir=None):
    """The installed Chrome's major version.

    The user agent must match the real browser. Claiming an old version while
    running a new binary is an obvious mismatch and several sites block it.
    chrome.exe --version prints nothing on Windows, so the profile's
    "Last Version" file and the versioned folder beside the binary are tried
    first.
    """
    global _CHROME_MAJOR
    if _CHROME_MAJOR:
        return _CHROME_MAJOR
    try:
        lv = os.path.join(user_data_dir or '', 'Last Version')
        if user_data_dir and os.path.isfile(lv):
            with open(lv, encoding='utf-8', errors='ignore') as f:
                m = re.match(r'(\d+)\.', f.read().strip())
            if m:
                _CHROME_MAJOR = m.group(1)
                return _CHROME_MAJOR
    except Exception:
        pass
    try:
        for name in sorted(os.listdir(os.path.dirname(chrome)), reverse=True):
            m = re.match(r'^(\d+)\.\d+\.\d+\.\d+$', name)
            if m:
                _CHROME_MAJOR = m.group(1)
                return _CHROME_MAJOR
    except Exception:
        pass
    try:
        r = subprocess.run([chrome, '--version'], capture_output=True, text=True, timeout=20)
        m = re.search(r'(\d+)\.\d+\.\d+', (r.stdout or '') + (r.stderr or ''))
        if m:
            _CHROME_MAJOR = m.group(1)
            return _CHROME_MAJOR
    except Exception:
        pass
    return None


def render(url, wait, user_data_dir=None, profile_directory=None):
    chrome = find_chrome()
    if not chrome:
        return None, 'chrome not found (set CHROME_BIN)'
    # A persistent, logged-in profile (authenticated capture) or a throwaway one.
    if user_data_dir:
        profile = user_data_dir
        try:
            os.makedirs(profile, exist_ok=True)
        except Exception:
            pass
    else:
        profile = os.path.join(tempfile.mkdtemp(), 'prof')
    major = chrome_major(chrome, user_data_dir)

    def build(mode):
        a = [
            chrome, mode, '--disable-gpu', '--no-sandbox',
            '--disable-dev-shm-usage', '--hide-scrollbars',
            # Headless Chrome sets navigator.webdriver and is trivially detected.
            '--disable-blink-features=AutomationControlled',
            '--no-first-run', '--no-default-browser-check',
            '--window-size=1366,900', '--lang=en-US',
            '--user-data-dir=' + profile,
        ]
        if profile_directory:
            a.append('--profile-directory=' + profile_directory)
        if major:
            a.append('--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                     '(KHTML, like Gecko) Chrome/' + major + '.0.0.0 Safari/537.36')
        a += ['--virtual-time-budget=' + str(int(wait * 1000)), '--dump-dom', url]
        return a

    last_err = None
    # New headless first. Some sites serve an empty shell to it, so fall back
    # to the old headless mode once before giving up.
    for mode in ('--headless=new', '--headless=old'):
        try:
            r = subprocess.run(build(mode), capture_output=True, text=True, timeout=wait + 90)
        except Exception as e:
            last_err = 'chrome failed: ' + str(e)[:200]
            continue
        dom = r.stdout or ''
        if len(dom.strip()) > 500:
            return dom, None
        last_err = 'chrome returned an empty page in ' + mode.replace('--headless=', '') + ' headless mode'
    return None, last_err or 'chrome returned nothing'


# Open a normal (visible) Chrome window on the persistent profile so the user can
# sign in once. Cookies persist in the profile for later headless capture.
def open_login(user_data_dir, profile_directory=None):
    chrome = find_chrome()
    if not chrome:
        print(json.dumps({'ok': False, 'error': 'chrome not found (set CHROME_BIN)'}))
        sys.exit(1)
    try:
        os.makedirs(user_data_dir, exist_ok=True)
    except Exception:
        pass
    sites = [
        'https://www.facebook.com/login', 'https://www.instagram.com/accounts/login/',
        'https://www.linkedin.com/login', 'https://x.com/login',
        'https://www.tiktok.com/login', 'https://www.quora.com',
    ]
    args = [chrome, '--new-window', '--user-data-dir=' + user_data_dir]
    if profile_directory:
        args.append('--profile-directory=' + profile_directory)
    args += sites
    try:
        subprocess.Popen(args)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': 'launch failed: ' + str(e)[:200]}))
        sys.exit(1)
    print(json.dumps({'ok': True, 'note': 'login window opened', 'profile': user_data_dir}))


def dom_to_text(dom):
    t = re.sub(r'<script[\s\S]*?</script>', ' ', dom, flags=re.I)
    t = re.sub(r'<style[\s\S]*?</style>', ' ', t, flags=re.I)
    t = re.sub(r'<[^>]+>', ' ', t)
    t = html.unescape(t)
    t = re.sub(r'[ \t\r\f\v]+', ' ', t)
    t = re.sub(r'\n\s*\n+', '\n', t)
    return t.strip()


MEDIA_EXT = re.compile(r'\.(mp4|webm|m3u8|mov|m4v|jpg|jpeg|png|webp|gif)(?:[?#]|$)', re.I)


def extract_media(dom, limit=40):
    """Pull creative media URLs (video/image) out of the rendered DOM."""
    urls, seen = [], set()

    def add(u):
        u = (u or '').replace('\\/', '/').replace('&amp;', '&').strip()
        if not u.startswith('http') or u in seen:
            return
        low = u.lower()
        # skip bundles / stylesheets / tracking
        if ('rsrc.php' in low or 'static.xx.fbcdn.net' in low or '.js' in low or '.css' in low
                or '/rsrc' in low or 'pixel' in low):
            return
        seen.add(u)
        urls.append(u)

    for m in re.finditer(r'(?:src|poster|content)=["\'](https?://[^"\']+)["\']', dom, flags=re.I):
        u = m.group(1)
        if MEDIA_EXT.search(u) or 'scontent' in u or 'fbcdn' in u:
            add(u)
    for key in ('video_url', 'playable_url', 'playable_url_quality_hd', 'browser_native_hd_url',
                'browser_native_sd_url', 'preview_image_url', 'videoPreviewImage'):
        for m in re.finditer(r'"' + key + r'":"(https?:[^"]+)"', dom):
            add(m.group(1))
    for m in re.finditer(r'https://[^"\'\s<>]*(?:fbcdn|scontent)[^"\'\s<>]*', dom):
        add(m.group(0))
    return urls[:limit]


def media_kind(u):
    if re.search(r'\.(mp4|webm|m3u8|mov|m4v)(?:[?#]|$)', u, re.I):
        return 'video'
    if re.search(r'\.(jpg|jpeg|png|webp|gif)(?:[?#]|$)', u, re.I):
        return 'image'
    return 'other'


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--url')
    ap.add_argument('--adlib', help='competitor keyword → Facebook Ad Library search')
    ap.add_argument('--page', help='competitor page name → public page URL')
    ap.add_argument('--country', default='ALL')
    ap.add_argument('--active', default='active')
    ap.add_argument('--wait', type=int, default=16)
    ap.add_argument('--max', type=int, default=12000)
    ap.add_argument('--media', action='store_true', help='also return creative media URLs')
    ap.add_argument('--user-data-dir', dest='user_data_dir', help='persistent Chrome profile dir (logged-in capture)')
    ap.add_argument('--profile-directory', dest='profile_directory', help='profile sub-directory name')
    ap.add_argument('--login', action='store_true', help='open a visible Chrome window to sign in, then exit')
    ap.add_argument('--which', action='store_true', help='print the Chrome binary that would be used, then exit')
    a = ap.parse_args()

    # Profile can come from args or environment (set by the Node fetcher).
    user_data_dir = a.user_data_dir or os.environ.get('RADAR_CHROME_PROFILE') or None
    profile_directory = a.profile_directory or os.environ.get('RADAR_CHROME_PROFILE_DIR') or None

    if a.which:
        c = find_chrome()
        print(json.dumps({'ok': bool(c), 'chrome': c or '',
                          'error': '' if c else 'Chrome not found. Set the Chrome path in Config.'}))
        return

    if a.login:
        if not user_data_dir:
            print(json.dumps({'ok': False, 'error': 'login needs --user-data-dir'}))
            sys.exit(1)
        open_login(user_data_dir, profile_directory)
        return

    url = a.url
    if not url and a.adlib:
        from urllib.parse import quote
        url = ('https://www.facebook.com/ads/library/?active_status=' + a.active +
               '&ad_type=all&country=' + a.country + '&q=' + quote(a.adlib) +
               '&search_type=keyword_unordered')
    if not url and a.page:
        from urllib.parse import quote
        url = 'https://www.facebook.com/' + quote(a.page)
    if not url:
        print(json.dumps({'ok': False, 'error': 'provide --url, --adlib or --page'}))
        sys.exit(1)

    dom, err = render(url, a.wait, user_data_dir, profile_directory)
    if err:
        print(json.dumps({'ok': False, 'error': err, 'url': url}))
        sys.exit(1)
    text = dom_to_text(dom)
    title = ''
    m = re.search(r'<title[^>]*>([\s\S]*?)</title>', dom, flags=re.I)
    if m:
        title = html.unescape(m.group(1)).strip()[:200]
    if not text:
        print(json.dumps({'ok': False, 'error': 'empty page (login wall or blocked)', 'url': url, 'title': title}))
        sys.exit(1)
    out = {'ok': True, 'url': url, 'title': title, 'text': text[:a.max]}
    if a.media:
        media = extract_media(dom)
        out['media'] = [{'url': u, 'kind': media_kind(u)} for u in media]
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main()
