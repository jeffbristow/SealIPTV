# =====================================================================
# Seal IPTV for Ubuntu Touch — backend/backend.py
# ---------------------------------------------------------------------
# What NativeBridge.java is on Android, for the same pages (mobile.html):
# a small web server on 127.0.0.1 (a free port) that
#   GET  /…                 the app's pages (www/), the saved playlist files
#                            (/catalog/<name>.json) and pictures (/img/?u=…, kept
#                            in the cache; while the VPN guard says no: only kept ones)
#   POST /n/<method>        the SealNative calls (utnative.js), JSON [args] -> { r }
#   POST /n/request         a web request for the pages (no CORS, any host)
#   GET  /n/events          events for the page (long poll): player, network, phonePost …
#   GET  /s/<token>/?u=…     a stream for Main.qml's player: fetched here with the provider's
#                            User-Agent (QtMultimedia can't set one), HLS playlists rewritten to
#                            come here too; refused while the VPN guard says no
# Two ports: the page, its files and the quick synchronous calls on one; web requests, events,
# pictures and streams on a second ("side") one. Chromium opens at most 6 connections to one
# host:port — with posters and slow requests on the same port, the synchronous calls queued
# behind them and the page froze. (The cookie below is sent to both: cookies ignore the port.)
# Only the page that has this launch's token (a cookie, set when Main.qml opens
# mobile.html?t=<token>) may call /n/… — other apps on the phone can't.
# Main.qml talks to it through pyotherside: start() -> the page's address,
# player events in (emit), player commands out (pyotherside.send('player', …)).
# Data: $XDG_DATA_HOME/<app id>/data (= /data in the pages), cache: $XDG_CACHE_HOME/<app id>.
# ===================================================================== */
import base64
import hashlib
import hmac
import http.client
import http.server
import json
import os
import queue
import re
import secrets
import socket
import socketserver
import ssl
import struct
import threading
import time
import urllib.parse

try:
    import pyotherside   # in the app (Main.qml); not when run on its own for tests
except ImportError:
    pyotherside = None

APP_ID = os.environ.get('APP_ID', 'seal-iptv.jeffbristow').split('_')[0]
HERE = os.path.dirname(os.path.abspath(__file__))
WWW = os.path.join(os.path.dirname(HERE), 'www')
DATA = os.path.join(os.environ.get('XDG_DATA_HOME', os.path.expanduser('~/.local/share')), APP_ID)
CACHE = os.path.join(os.environ.get('XDG_CACHE_HOME', os.path.expanduser('~/.cache')), APP_ID)
FILES = os.path.join(DATA, 'data')          # the pages' /data/…
BLOBS = os.path.join(CACHE, 'blobs')         # big answers, read a piece at a time
IMAGES = os.path.join(CACHE, 'images')       # posters / logos
VERSION = '0.0.0'
SMALL = 512 * 1024
CHUNK = 1024 * 1024
TOKEN = secrets.token_hex(24)

for d in (FILES, BLOBS, IMAGES):
    os.makedirs(d, exist_ok=True)

state = {'blocked': False, 'ua': None, 'port': 0, 'side': 0, 'stream_ua': None}
events = queue.Queue()


def emit(name, data):
    """an event for the page (window.__nativeEvent(name, json))"""
    events.put({'name': name, 'data': data if isinstance(data, str) else json.dumps(data)})


def to_qml(name, *args):
    if pyotherside:
        pyotherside.send(name, *args)


# ---------------- files (the pages' /data/…) ----------------
def path_of(p):
    p = str(p or '')
    if p.startswith('/data'):
        p = p[5:]
    p = p.lstrip('/')
    if any(part == '..' for part in p.split('/')):
        raise ValueError('bad path')
    return os.path.join(FILES, *[x for x in p.split('/') if x])


def read_file(p):
    try:
        with open(path_of(p), 'r', encoding='utf-8') as f:
            return f.read()
    except Exception:
        return None


def write_file(p, text):
    try:
        f = path_of(p)
        os.makedirs(os.path.dirname(f), exist_ok=True)
        with open(f, 'w', encoding='utf-8', newline='') as o:
            o.write(text)
            o.flush()
            os.fsync(o.fileno())
        return True
    except Exception:
        return False


def append_file(p, text):
    try:
        with open(path_of(p), 'a', encoding='utf-8', newline='') as o:
            o.write(text)
        return True
    except Exception:
        return False


def rename_file(a, b):
    try:
        a, b = path_of(a), path_of(b)
        if not os.path.exists(a):
            return False
        os.replace(a, b)
        return True
    except Exception:
        return False


def delete_file(p):
    try:
        os.remove(path_of(p))
        return True
    except Exception:
        return False


def exists(p):
    try:
        return os.path.exists(path_of(p))
    except Exception:
        return False


def file_size(p):
    try:
        f = path_of(p)
        return os.path.getsize(f) if os.path.isfile(f) else -1
    except Exception:
        return -1


def chunk_of(f, n):
    """piece n (CHUNK bytes) of a file as base64; '' past the end; None if there's no such file"""
    if not os.path.isfile(f):
        return None
    with open(f, 'rb') as r:
        at = int(n) * CHUNK
        if at >= os.path.getsize(f):
            return ''
        r.seek(at)
        return base64.b64encode(r.read(CHUNK)).decode('ascii')


def file_chunk(p, n):
    try:
        return chunk_of(path_of(p), n)
    except Exception:
        return None


def blob(name):
    if not re.fullmatch(r'b\d+', str(name)):
        raise ValueError('bad blob')
    return os.path.join(BLOBS, name)


def blob_chunk(name, n):
    return chunk_of(blob(name), n)


def blob_drop(name):
    try:
        os.remove(blob(name))
    except Exception:
        pass


# ---------------- passwords: sealed with a key kept in the app's own (confined) folder ----------------
# No Keystore on Ubuntu Touch. SHA-256 counter-mode keystream + HMAC-SHA256 tag (encrypt-then-MAC);
# the key file is readable only by this app (AppArmor confinement, mode 600).
def _key():
    kf = os.path.join(DATA, 'secret.key')
    try:
        with open(kf, 'rb') as f:
            k = f.read()
            if len(k) == 64:
                return k
    except Exception:
        pass
    k = secrets.token_bytes(64)
    fd = os.open(kf, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(k)
    return k


def _stream(key, nonce, n):
    out = bytearray()
    i = 0
    while len(out) < n:
        out += hashlib.sha256(key + nonce + struct.pack('>Q', i)).digest()
        i += 1
    return bytes(out[:n])


def encrypt(text):
    k = _key()
    nonce = secrets.token_bytes(16)
    data = text.encode('utf-8')
    ct = bytes(a ^ b for a, b in zip(data, _stream(k[:32], nonce, len(data))))
    tag = hmac.new(k[32:], nonce + ct, hashlib.sha256).digest()
    return base64.b64encode(b'U1' + nonce + ct + tag).decode('ascii')


def decrypt(b64):
    try:
        raw = base64.b64decode(b64)
        if raw[:2] != b'U1' or len(raw) < 2 + 16 + 32:
            return None
        k = _key()
        nonce, ct, tag = raw[2:18], raw[18:-32], raw[-32:]
        if not hmac.compare_digest(tag, hmac.new(k[32:], nonce + ct, hashlib.sha256).digest()):
            return None
        return bytes(a ^ b for a, b in zip(ct, _stream(k[:32], nonce, len(ct)))).decode('utf-8')
    except Exception:
        return None


# ---------------- network: interfaces, the VPN ----------------
def _ifaces():
    """{ name: { 'up': bool, 'ipv4': [addr] } } from /proc and ioctl (no programs run)"""
    out = {}
    try:
        names = [n for _, n in socket.if_nameindex()]
    except Exception:
        names = []
    try:
        import fcntl
    except ImportError:   # not Linux (tests on a PC): no interface details
        return out
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        for n in names:
            info = {'up': False, 'ipv4': []}
            try:
                flags = struct.unpack('16sH', fcntl.ioctl(s.fileno(), 0x8913, struct.pack('256s', n.encode()[:15]))[:18])[1]   # SIOCGIFFLAGS
                info['up'] = bool(flags & 1) and bool(flags & 0x40)   # IFF_UP, IFF_RUNNING
            except Exception:
                pass
            try:
                a = fcntl.ioctl(s.fileno(), 0x8915, struct.pack('256s', n.encode()[:15]))   # SIOCGIFADDR
                info['ipv4'].append(socket.inet_ntoa(a[20:24]))
            except Exception:
                pass
            out[n] = info
    finally:
        s.close()
    return out


def interfaces():
    """like Node's os.networkInterfaces()"""
    res = {}
    for n, i in _ifaces().items():
        res[n] = [{'address': a, 'family': 'IPv4', 'internal': n == 'lo' or a.startswith('127.'), 'netmask': '255.255.255.0'} for a in i['ipv4']]
    return json.dumps(res)


VPN_RE = re.compile(r'^(tun|tap|wg|ppp|ipsec|proton|nordlynx|vpn)', re.I)


def vpn_active():
    """'VPN (tun0)' while a VPN interface is up (NetworkManager's OpenVPN / WireGuard, Proton …), else None"""
    for n, i in _ifaces().items():
        if VPN_RE.match(n) and i['up'] and i['ipv4']:
            return 'VPN (%s)' % n
    return None


def device_name():
    for f in ('/etc/writable/machine-info', '/etc/machine-info'):
        try:
            for line in open(f, encoding='utf-8'):
                if line.startswith('PRETTY_HOSTNAME='):
                    v = line.split('=', 1)[1].strip().strip('"')
                    if v:
                        return v
        except Exception:
            pass
    try:
        for line in open('/system/build.prop', encoding='utf-8', errors='ignore'):
            if line.startswith('ro.product.model='):
                return line.split('=', 1)[1].strip()
    except Exception:
        pass
    return socket.gethostname() or 'Ubuntu Touch'


def watch_network():
    """VPN up / down, Wi-Fi changes -> 'network' (core.js checks the VPN again)"""
    last = None
    while True:
        now = json.dumps(sorted((n, i['up'], tuple(i['ipv4'])) for n, i in _ifaces().items()))
        if last is not None and now != last:
            emit('network', '{}')
        last = now
        time.sleep(2)


# ---------------- web requests ----------------
def do_request(o):
    url = o['url']
    method = o.get('method') or 'GET'
    timeout = (o.get('timeout') or 30000) / 1000.0
    follow = o.get('redirect') != 'error'
    headers = dict(o.get('headers') or {})
    body = o.get('body')
    try:
        for _ in range(6):
            u = urllib.parse.urlsplit(url)
            if u.scheme == 'https':
                c = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=timeout, context=ssl.create_default_context())
            elif u.scheme == 'http':
                c = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=timeout)
            else:
                return {'ok': False, 'error': 'not a web address'}
            path = (u.path or '/') + ('?' + u.query if u.query else '')
            data = body.encode('utf-8') if (body is not None and method != 'GET') else None
            h = {'Accept-Encoding': 'identity', **headers}
            c.request(method, path, body=data, headers=h)
            r = c.getresponse()
            loc = r.getheader('Location')
            if 300 <= r.status < 400 and loc:
                r.read()
                c.close()
                if not follow:
                    return {'ok': False, 'error': 'redirected'}
                url = urllib.parse.urljoin(url, loc)
                if r.status == 303:
                    method, body = 'GET', None
                continue
            ctype = r.getheader('Content-Type') or ''
            m = re.search(r'charset="?([\w-]+)', ctype, re.I)
            charset = m.group(1) if m else 'utf-8'
            out = {'ok': True, 'status': r.status, 'url': url, 'headers': {k: v for k, v in r.getheaders()}, 'body': ''}
            buf = bytearray()
            spill = None
            name = None
            while True:
                b = r.read(65536)
                if not b:
                    break
                if spill is None and len(buf) + len(b) > SMALL:
                    name = 'b%d' % time.time_ns()
                    spill = open(blob(name), 'wb')
                    spill.write(buf)
                    buf = None
                if spill is not None:
                    spill.write(b)
                else:
                    buf += b
            c.close()
            if spill is not None:
                spill.close()
                out.update({'blob': name, 'size': os.path.getsize(blob(name)), 'charset': charset})
            else:
                try:
                    out['body'] = bytes(buf).decode(charset, errors='replace')
                except LookupError:
                    out['body'] = bytes(buf).decode('utf-8', errors='replace')
            return out
        return {'ok': False, 'error': 'too many redirects'}
    except socket.gaierror:
        return {'ok': False, 'error': 'host not found', 'code': 'ENOTFOUND'}
    except ConnectionRefusedError:
        return {'ok': False, 'error': 'connection refused', 'code': 'ECONNREFUSED'}
    except (socket.timeout, TimeoutError):
        return {'ok': False, 'error': 'timed out', 'code': 'ETIMEDOUT'}
    except ssl.SSLError as e:
        return {'ok': False, 'error': 'secure connection failed: %s' % e, 'code': 'ESSL'}
    except Exception as e:
        return {'ok': False, 'error': str(e) or e.__class__.__name__}


# ---------------- pictures (/img/?u=…): kept in the cache ----------------
IMG_CAP = 300 * 1024 * 1024


def _bytes_request(url, ua):
    u = urllib.parse.urlsplit(url)
    C = http.client.HTTPSConnection if u.scheme == 'https' else http.client.HTTPConnection
    c = C(u.hostname, u.port, timeout=15)
    c.request('GET', (u.path or '/') + ('?' + u.query if u.query else ''), headers={'User-Agent': ua} if ua else {})
    return c.getresponse()


def picture(url, _hops=0):
    """-> (status, type, bytes); kept ones also while the VPN guard says no"""
    if not re.match(r'^https?://', url or '', re.I):
        return 400, 'text/plain', b'Bad address'
    key = hashlib.sha1(url.encode('utf-8')).hexdigest()
    f = os.path.join(IMAGES, key)
    if os.path.isfile(f):
        try:
            typ = open(f + '.type', encoding='ascii').read().strip() or 'image/jpeg'
        except Exception:
            typ = 'image/jpeg'
        return 200, typ, open(f, 'rb').read()
    if state['blocked']:
        return 403, 'text/plain', b'Blocked: VPN is off'
    try:
        r = _bytes_request(url, state['ua'])
        if 300 <= r.status < 400 and r.getheader('Location') and _hops < 5:
            return picture(urllib.parse.urljoin(url, r.getheader('Location')), _hops + 1)
        data = r.read()
        if r.status != 200:
            return 502, 'text/plain', b'Not loaded'
    except Exception:
        return 502, 'text/plain', b'Not loaded'
    typ = (r.getheader('Content-Type') or 'image/jpeg').split(';')[0]
    if not typ.startswith('image/') and data[:4] not in (b'\x89PNG', b'GIF8') and data[:3] != b'\xff\xd8\xff':
        return 502, 'text/plain', b'Not a picture'
    if len(data) < 4 * 1024 * 1024:
        with open(f, 'wb') as o:
            o.write(data)
        with open(f + '.type', 'w', encoding='ascii') as o:
            o.write(typ)
    return 200, typ, data


def trim_images():
    try:
        files = [(os.path.getmtime(os.path.join(IMAGES, n)), os.path.join(IMAGES, n)) for n in os.listdir(IMAGES) if not n.endswith('.type')]
        total = sum(os.path.getsize(p) for _, p in files)
        for _, p in sorted(files):
            if total <= IMG_CAP:
                break
            total -= os.path.getsize(p)
            for x in (p, p + '.type'):
                try:
                    os.remove(x)
                except Exception:
                    pass
    except Exception:
        pass


# ---------------- "Get it from another device": the setup server on the home network ----------------
class Setup:
    def __init__(self):
        self.srv = None
        self.html = ''
        self.hello = '{}'
        self.until = 0
        self.waits = {}
        self.replies = {}
        self.next = 1
        self.lock = threading.Lock()

    def start(self, port, html, hello):
        self.stop()
        self.html, self.hello = html or '', hello or '{}'
        me = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, status, typ, text):
                b = text.encode('utf-8')
                self.send_response(status)
                self.send_header('Content-Type', typ)
                self.send_header('Content-Length', str(len(b)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Referrer-Policy', 'no-referrer')
                self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.write(b)

            def do_GET(self):
                if time.time() > me.until:
                    return self._send(404, 'text/plain', 'Not here')
                if self.path == '/' or self.path.startswith('/?'):
                    return self._send(200, 'text/html; charset=utf-8', me.html)
                if self.path == '/hello':
                    return self._send(200, 'application/json', me.hello)
                self._send(404, 'text/plain', 'Not here')

            def do_POST(self):
                if self.path != '/send' or time.time() > me.until:
                    return self._send(404, 'text/plain', 'Not here')
                n = int(self.headers.get('Content-Length') or 0)
                if n <= 0 or n > 64 * 1024:
                    return self._send(413, 'application/json', '{"ok":false,"error":"too big"}')
                body = self.rfile.read(n).decode('utf-8', errors='replace')
                with me.lock:
                    pid = 'p%d' % me.next
                    me.next += 1
                ev = threading.Event()
                me.waits[pid] = ev
                emit('phonePost', {'id': pid, 'body': body})
                answered = ev.wait(60)
                me.waits.pop(pid, None)
                r = me.replies.pop(pid, None)
                self._send(200, 'application/json', r if answered and r else '{"ok":false,"error":"The phone didn\'t answer. Is the window with the code still open?"}')

        for p in range(port, port + 10):
            try:
                s = ThreadingServer(('0.0.0.0', p), H)
                self.srv = s
                self.until = time.time() + 15 * 60
                threading.Thread(target=s.serve_forever, daemon=True).start()
                return p
            except OSError:
                continue
        return -1

    def reply(self, pid, js):
        ev = self.waits.get(pid)
        if ev:
            self.replies[pid] = js
            ev.set()

    def stop(self):
        if self.srv:
            s, self.srv = self.srv, None
            threading.Thread(target=lambda: (s.shutdown(), s.server_close()), daemon=True).start()
        for ev in list(self.waits.values()):
            ev.set()


setup = Setup()


# ---------------- the SealNative calls ----------------
def set_guard(blocked, ua):
    state['blocked'] = bool(blocked)
    state['ua'] = ua or None


METHODS = {
    'readFile': read_file, 'writeFile': write_file, 'renameFile': rename_file, 'deleteFile': delete_file,
    'exists': exists, 'fileSize': file_size, 'fileChunk': file_chunk, 'appendFile': append_file,
    'blobChunk': blob_chunk, 'blobDrop': blob_drop,
    'encrypt': encrypt, 'decrypt': decrypt,
    'interfaces': interfaces, 'vpnActive': vpn_active, 'deviceName': device_name,
    'appVersion': lambda: VERSION, 'audioOutput': lambda: None,
    'setGuard': set_guard,
    'phoneStart': setup.start, 'phoneReply': setup.reply, 'phoneStop': setup.stop,
    # "Open ProtonVPN": Ubuntu Touch has no Proton app — its own VPN settings (WireGuard / OpenVPN) instead
    'launchApp': lambda pkg: (to_qml('external', 'settings:///system/vpn') or True) if pkg == 'ch.protonvpn.android' and pyotherside else False,
    'openExternal': lambda url, title, ua: (to_qml('external', url) or True) if pyotherside else False,
    'play': lambda js: play(js),
    'playerCommand': lambda js: to_qml('playerCommand', js),
    'voiceAvailable': lambda: False,
    'imageRoute': lambda: True,
    'sideOrigin': lambda: 'http://127.0.0.1:%d' % state['side'],
    'streamUrl': lambda url, ua='': (state.__setitem__('stream_ua', ua or None), stream_url(url))[1],   # utplayer.js
    'webReady': lambda: None, 'webVersion': lambda: VERSION, 'updateRestart': lambda: to_qml('reload'),
    'exitApp': lambda: to_qml('quit'),
    'showKeyboard': lambda: None,
}


def stream_url(url):
    return 'http://127.0.0.1:%d/s/%s/?u=%s' % (state['side'], TOKEN, urllib.parse.quote(url, safe=''))


def play(js):
    """player-tv.js -> Main.qml: the stream through this backend (User-Agent, VPN guard)"""
    o = json.loads(js)
    state['stream_ua'] = o.get('ua') or None
    if o.get('url'):
        o['source'] = o['url']
        o['url'] = stream_url(o['url'])
    to_qml('play', json.dumps(o))


URI_ATTR = re.compile(r'URI="([^"]+)"')


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
         '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.dat': 'text/plain; charset=utf-8'}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _cors(self):
        if self.server.server_address[1] == state['side']:
            self.send_header('Access-Control-Allow-Origin', 'http://127.0.0.1:%d' % state['port'])
            self.send_header('Access-Control-Allow-Credentials', 'true')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _send(self, status, typ, data, extra=None):
        if isinstance(data, str):
            data = data.encode('utf-8')
        self.send_response(status)
        self._cors()
        self.send_header('Content-Type', typ)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _mine(self):
        """this launch's page: it has the token cookie"""
        c = self.headers.get('Cookie') or ''
        return ('seal=' + TOKEN) in c.replace(' ', '').split(';')

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        p = urllib.parse.unquote(u.path)
        q = urllib.parse.parse_qs(u.query)
        if p == '/ut.html' and q.get('t', [''])[0] == TOKEN:
            # the token goes into a cookie; the address bar never needs it again
            return self._file('ut.html', {'Set-Cookie': 'seal=%s; Path=/; HttpOnly; SameSite=Strict' % TOKEN})
        if p == '/s/%s/' % TOKEN:
            return self._proxy(q.get('u', [''])[0])
        if p.startswith('/n/') or p.startswith('/catalog/') or p == '/img/':
            if not self._mine():
                return self._send(403, 'text/plain', 'Not allowed')
        if p == '/n/events':
            out = []
            try:
                out.append(events.get(timeout=25))
                while True:
                    out.append(events.get_nowait())
            except queue.Empty:
                pass
            try:
                return self._send(200, 'application/json', json.dumps(out))
            except OSError:
                for e in out:   # the page went (reloaded): keep them for the next one
                    events.put(e)
                return
        if p.startswith('/catalog/'):
            name = p.rsplit('/', 1)[-1]
            f = os.path.join(FILES, 'catalog', name)
            if not re.fullmatch(r'[\w.-]+\.json', name) or not os.path.isfile(f):
                return self._send(404, 'text/plain', 'Not found')
            with open(f, 'rb') as b:
                return self._send(200, 'application/json', b.read())
        if p == '/img/':
            st, typ, data = picture(q.get('u', [''])[0])
            return self._send(st, typ, data, {'Cache-Control': 'max-age=86400'} if st == 200 else None)
        return self._file(p.lstrip('/') or 'ut.html')

    def _proxy(self, url, hops=0):
        if state['blocked']:
            return self._send(403, 'text/plain', 'Blocked: VPN is off')
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ('http', 'https') or not u.hostname:
            return self._send(400, 'text/plain', 'Bad address')
        try:
            C = http.client.HTTPSConnection if u.scheme == 'https' else http.client.HTTPConnection
            c = C(u.hostname, u.port, timeout=20)
            h = {'User-Agent': state['stream_ua'] or 'SealIPTV/%s (Ubuntu Touch)' % VERSION, 'Accept-Encoding': 'identity'}
            if self.headers.get('Range'):
                h['Range'] = self.headers.get('Range')
            c.request('GET', (u.path or '/') + ('?' + u.query if u.query else ''), headers=h)
            r = c.getresponse()
        except Exception as e:
            return self._send(502, 'text/plain', 'Not reached: %s' % e)
        loc = r.getheader('Location')
        if 300 <= r.status < 400 and loc and hops < 6:
            r.read()
            c.close()
            return self._proxy(urllib.parse.urljoin(url, loc), hops + 1)
        first = r.read(65536)
        if first.lstrip()[:7] == b'#EXTM3U':
            # an HLS playlist: every address in it comes here too
            text = (first + r.read()).decode('utf-8', errors='replace')
            c.close()
            out = []
            for line in text.splitlines():
                t = line.strip()
                if t and not t.startswith('#'):
                    out.append(stream_url(urllib.parse.urljoin(url, t)))
                elif t.startswith('#') and 'URI="' in t:
                    out.append(URI_ATTR.sub(lambda m: 'URI="%s"' % stream_url(urllib.parse.urljoin(url, m.group(1))), line))
                else:
                    out.append(line)
            return self._send(r.status, 'application/vnd.apple.mpegurl', '\n'.join(out) + '\n')
        # anything else (TS, MP4, MKV, segments): passed through as it comes
        self.send_response(r.status)
        self._cors()   # utplayer.js (hls.js / mpegts.js) reads these from the page's port
        for k in ('Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges'):
            v = r.getheader(k)
            if v:
                self.send_header(k, v)
        if not r.getheader('Content-Length'):
            self.close_connection = True
            self.send_header('Connection', 'close')
        self.end_headers()
        try:
            self.wfile.write(first)
            while True:
                b = r.read(65536)
                if not b:
                    break
                self.wfile.write(b)
        except Exception:
            pass   # the player went away (closed, seek)
        finally:
            c.close()

    def _file(self, rel, extra=None):
        f = os.path.normpath(os.path.join(WWW, rel))
        if not f.startswith(os.path.normpath(WWW) + os.sep) or not os.path.isfile(f):
            return self._send(404, 'text/plain', 'Not found')
        with open(f, 'rb') as b:
            data = b.read()
        self._send(200, TYPES.get(os.path.splitext(f)[1], 'application/octet-stream'), data, extra)

    def do_POST(self):
        if not self._mine():
            return self._send(403, 'text/plain', 'Not allowed')
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n) if n else b''
        p = urllib.parse.urlsplit(self.path).path
        if p == '/n/request':
            return self._send(200, 'application/json', json.dumps(do_request(json.loads(raw.decode('utf-8')))))
        if p.startswith('/n/'):
            name = p[3:]
            fn = METHODS.get(name)
            if not fn:
                return self._send(404, 'application/json', '{"error":"no such call"}')
            args = json.loads(raw.decode('utf-8')) if raw else []
            try:
                r = fn(*args)
            except Exception as e:
                return self._send(200, 'application/json', json.dumps({'error': str(e)}))
            return self._send(200, 'application/json', json.dumps({'r': r}))
        self._send(404, 'text/plain', 'Not found')


server = None
side = None


def start(version=None):
    """Main.qml: start the server -> the address of the page to open"""
    global server, side, VERSION
    try:
        VERSION = version or json.load(open(os.path.join(os.path.dirname(HERE), 'manifest.json'), encoding='utf-8'))['version']
    except Exception:
        VERSION = version or '0.0.0'
    if server is None:
        server = ThreadingServer(('127.0.0.1', 0), Handler)
        state['port'] = server.server_address[1]
        side = ThreadingServer(('127.0.0.1', 0), Handler)
        state['side'] = side.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        threading.Thread(target=side.serve_forever, daemon=True).start()
        threading.Thread(target=watch_network, daemon=True).start()
        threading.Thread(target=trim_images, daemon=True).start()
    return 'http://127.0.0.1:%d/ut.html?t=%s' % (state['port'], TOKEN)


def player_event(js):
    """Main.qml's player: progress / ended / closed … -> the page (player-tv.js)"""
    emit('player', js)


def app_event(name, js='{}'):
    emit(name, js)


if __name__ == '__main__':   # on its own (tests): print the address and keep serving
    print(start('dev'), flush=True)
    while True:
        time.sleep(3600)
