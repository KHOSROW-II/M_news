#!/usr/bin/env python3
"""
News Aggregator desktop launcher.

Bundled as start.exe via PyInstaller on Windows.
Fetches latest data from GitHub only when it changed.
"""

import os
import sys

os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS",
                      "--disable-gpu --no-sandbox --disable-dev-shm-usage --disable-software-rasterizer")
os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
os.environ.setdefault("QT_QUICK_BACKEND", "software")
os.environ.setdefault("LIBGL_ALWAYS_SOFTWARE", "1")
os.environ.setdefault("QT_OPENGL", "software")
os.environ.setdefault("QT_LOGGING_RULES",
                      "qt.qpa.*=false;qt.webenginecontext.*=false;*.debug=false")

import argparse
import contextlib
import http.server
import io
import json
import socketserver
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

# ---- paths --------------------------------------------------------------
FROZEN = getattr(sys, "frozen", False)

if FROZEN:
    BASE_DIR = Path(sys._MEIPASS)
    WEB_DIR = BASE_DIR / "web"
else:
    BASE_DIR = Path(__file__).resolve().parent
    WEB_DIR = BASE_DIR

CACHE_BASE = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.cache")
CACHE_DIR = Path(CACHE_BASE) / "NewsAggregator"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DATA = CACHE_DIR / "news-data.json"
CACHE_ARCHIVE = CACHE_DIR / "archive.json"
CACHE_IMAGES = CACHE_DIR / "images"
CACHE_IMAGES.mkdir(parents=True, exist_ok=True)
LOG_FILE = CACHE_DIR / "start.log"

# ---- config -------------------------------------------------------------
HOST = "127.0.0.1"
RAW_BASE = os.environ.get(
    "NEWS_RAW_BASE",
    "https://raw.githubusercontent.com/KHOSROW-II/M_news/main/output",
).rstrip("/")
RAW_NEWS_URL = RAW_BASE + "/news-data.json"
RAW_ARCHIVE_URL = RAW_BASE + "/archive.json"
REFRESH_INTERVAL = 300
HTTP_TIMEOUT = 15

_refresh_lock = threading.Lock()
_last_refresh = {"ok": False, "message": "not started", "count": 0, "ts": 0}
_log_file = None

# ---- logging ------------------------------------------------------------
def open_log():
    global _log_file
    try:
        _log_file = open(LOG_FILE, "a", encoding="utf-8")
        _log_file.write(f"\n\n=== start {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
        _log_file.flush()
    except Exception:
        _log_file = None

def log(msg, level="info"):
    line = f"[{time.strftime('%H:%M:%S')}] {level}: {msg}"
    if _log_file:
        try:
            _log_file.write(line + "\n")
            _log_file.flush()
        except Exception:
            pass
    if not FROZEN or "--console" in sys.argv:
        prefix = {"info": "  ", "ok": "[+]", "warn": "[!]", "err": "[x]"}.get(level, "  ")
        print(f"{prefix} {msg}", flush=True)

# ---- splash -------------------------------------------------------------
class Splash:
    def __init__(self):
        self.root = None
        self.status = None
        self.available = False
        try:
            import tkinter as tk
            from tkinter import ttk

            self.tk = tk
            root = tk.Tk()
            root.overrideredirect(True)
            root.attributes("-topmost", True)
            root.configure(bg="#111827")

            w, h = 420, 220
            sw = root.winfo_screenwidth()
            sh = root.winfo_screenheight()
            root.geometry(f"{w}x{h}+{(sw - w) // 2}+{(sh - h) // 2}")

            tk.Label(root, text="NEWS", fg="#6b7280", bg="#111827",
                     font=("Segoe UI", 9, "bold")).pack(pady=(36, 0))
            tk.Label(root, text="Aggregator", fg="#ffffff", bg="#111827",
                     font=("Segoe UI", 22, "bold")).pack()
            self.status = tk.Label(root, text="Starting...", fg="#9ca3af", bg="#111827",
                                   font=("Segoe UI", 9))
            self.status.pack(pady=(18, 8))
            bar = ttk.Progressbar(root, length=320, mode="indeterminate")
            bar.pack()
            bar.start(12)

            self.root = root
            self.root.update()
            self.available = True
        except Exception as exc:
            log(f"splash unavailable: {exc}", "warn")
            self.available = False

    def update(self, text):
        if not self.available:
            return
        try:
            self.status.config(text=text)
            self.root.update()
        except Exception:
            pass

    def close(self):
        if not self.available:
            return
        try:
            self.root.destroy()
        except Exception:
            pass
        self.available = False

# ---- noise filter -------------------------------------------------------
_NOISE_PATTERNS = [
    "GTK cannot be loaded", "QT cannot be loaded",
    "No module named 'gi'", "No module named 'qtpy'",
    "webview/platforms/gtk.py", "webview/platforms/qt.py",
    "webview/guilib.py", "Sandboxing disabled by user",
    "vkDebug:", "EGL: Failed to query DRM", "GPUInfo not initialized",
    "Release of profile requested", "Expect troubles !",
]

class _NoiseFilter(io.TextIOBase):
    def __init__(self, target):
        self.target = target
    def write(self, s):
        for line in s.splitlines(keepends=True):
            st = line.strip()
            if not st:
                self.target.write(line)
                continue
            if any(p in st for p in _NOISE_PATTERNS):
                continue
            if st.startswith('File "') and "site-packages/webview/" in st:
                continue
            self.target.write(line)
        return len(s)
    def flush(self):
        try: self.target.flush()
        except Exception: pass

@contextlib.contextmanager
def quiet_stderr():
    old = sys.stderr
    sys.stderr = _NoiseFilter(old)
    try:
        yield
    finally:
        sys.stderr = old

# ---- http ---------------------------------------------------------------
def _http_get(url, timeout=HTTP_TIMEOUT):
    req = urllib.request.Request(url, headers={"User-Agent": "NewsAggregator/4.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()

def _http_head(url, timeout=10):
    req = urllib.request.Request(url, method="HEAD",
                                 headers={"User-Agent": "NewsAggregator/4.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return {
                "ok": True,
                "content_length": resp.headers.get("Content-Length"),
                "last_modified": resp.headers.get("Last-Modified"),
            }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

# ---- fetch --------------------------------------------------------------
def do_fetch(offline=False):
    global _last_refresh
    if offline:
        _last_refresh = {"ok": False, "message": "offline mode", "count": 0, "ts": time.time()}
        return False, "offline mode"
    if "USER/REPO" in RAW_BASE:
        _last_refresh = {"ok": False, "message": "URL not configured", "count": 0, "ts": time.time()}
        return False, "URL not configured"

    with _refresh_lock:
        try:
            # 1) HEAD check to avoid downloading when unchanged
            if CACHE_DATA.exists():
                try:
                    meta = _http_head(RAW_NEWS_URL)
                    if meta.get("ok") and meta.get("content_length"):
                        if int(meta["content_length"]) == CACHE_DATA.stat().st_size:
                            _last_refresh = {
                                "ok": True, "message": "up to date",
                                "count": _last_refresh.get("count", 0),
                                "ts": time.time(),
                            }
                            return True, "up to date"
                except Exception:
                    pass

            # 2) download news
            raw = _http_get(RAW_NEWS_URL).decode("utf-8")
            parsed = json.loads(raw)
            if not isinstance(parsed.get("news"), list):
                raise ValueError("invalid payload")

            # 3) skip write if lastUpdated unchanged
            if CACHE_DATA.exists():
                try:
                    old = json.loads(CACHE_DATA.read_text(encoding="utf-8"))
                    if old.get("lastUpdated") == parsed.get("lastUpdated"):
                        _last_refresh = {
                            "ok": True, "message": "up to date",
                            "count": len(parsed["news"]),
                            "ts": time.time(),
                        }
                        return True, "up to date"
                except Exception:
                    pass

            CACHE_DATA.write_text(raw, encoding="utf-8")

            # 4) download archive
            try:
                arch = _http_get(RAW_ARCHIVE_URL).decode("utf-8")
                json.loads(arch)
                CACHE_ARCHIVE.write_text(arch, encoding="utf-8")
            except Exception:
                pass

            # 5) download images
            downloaded = 0
            for item in parsed["news"]:
                img = item.get("image") or ""
                if not img.startswith("images/"):
                    continue
                fname = img.split("/")[-1]
                local = CACHE_IMAGES / fname
                if local.exists():
                    continue
                try:
                    data = _http_get(f"{RAW_BASE}/{img}", timeout=10)
                    local.write_bytes(data)
                    downloaded += 1
                except Exception:
                    pass

            _last_refresh = {
                "ok": True, "message": "updated",
                "count": len(parsed["news"]),
                "ts": time.time(),
            }
            return True, f"{len(parsed['news'])} stories, {downloaded} images"
        except Exception as exc:
            _last_refresh = {"ok": False, "message": str(exc), "count": 0, "ts": time.time()}
            return False, str(exc)

def background_refresher(offline):
    while True:
        time.sleep(REFRESH_INTERVAL)
        ok, msg = do_fetch(offline=offline)
        log(f"auto-refresh: {msg}", "ok" if ok else "warn")

# ---- resolve files ------------------------------------------------------
def _newest(paths):
    existing = [p for p in paths if p.exists()]
    if not existing:
        return None
    return max(existing, key=lambda p: p.stat().st_mtime)

def resolve_news_file():
    return _newest([
        CACHE_DATA,
        BASE_DIR / "output" / "news-data.json",
        WEB_DIR / "data" / "news-data.json",
    ])

def resolve_archive_file():
    return _newest([
        CACHE_ARCHIVE,
        BASE_DIR / "output" / "archive.json",
        WEB_DIR / "data" / "archive.json",
    ])

def resolve_image(name):
    safe = Path(name).name
    for p in [
        CACHE_IMAGES / safe,
        WEB_DIR / "images" / safe,
        WEB_DIR / "output" / "images" / safe,
        BASE_DIR / "output" / "images" / safe,
    ]:
        if p.exists() and p.is_file():
            return p
    return None

MIME_BY_EXT = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "webp": "image/webp", "gif": "image/gif", "svg": "image/svg+xml",
}

# ---- http server --------------------------------------------------------
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path, mime, cache="no-store"):
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        p = self.path

        if p.startswith("/output/news-data.json"):
            f = resolve_news_file()
            if not f:
                return self._send_json({"news": [], "lastUpdated": None}, 404)
            return self._send_file(f, "application/json; charset=utf-8")

        if p.startswith("/output/archive.json"):
            f = resolve_archive_file()
            if not f:
                return self._send_json({"news": [], "totalNews": 0}, 404)
            return self._send_file(f, "application/json; charset=utf-8")

        if p.startswith("/images/"):
            raw = p.split("/images/", 1)[1].split("?", 1)[0]
            name = urllib.parse.unquote(raw)
            if not name or ".." in name or "/" in name or "\\" in name:
                return self.send_error(404)
            f = resolve_image(name)
            if not f:
                return self.send_error(404)
            ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
            return self._send_file(
                f,
                MIME_BY_EXT.get(ext, "application/octet-stream"),
                cache="public, max-age=3600",
            )

        if p.startswith("/api/refresh"):
            ok, msg = do_fetch(offline=False)
            return self._send_json({"ok": ok, "message": msg, **_last_refresh})

        if p.startswith("/api/status"):
            return self._send_json(_last_refresh)

        return super().do_GET()

    def log_message(self, *args):
        pass

def start_server():
    httpd = socketserver.ThreadingTCPServer((HOST, 0), Handler)
    httpd.daemon_threads = True
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port

def _wait_for_exit():
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass

# ---- native window ------------------------------------------------------
def try_native(url):
    try:
        import webview
    except ImportError:
        log("pywebview not installed", "warn")
        return False

    shown = {"flag": False}
    try:
        w = webview.create_window(
            "News Aggregator", url,
            width=1280, height=850, min_size=(800, 600), text_select=True,
        )
        w.events.shown += lambda: shown.__setitem__("flag", True)
    except Exception as exc:
        log(f"create_window failed: {exc}", "err")
        return False

    try:
        with quiet_stderr():
            webview.start()
    except Exception as exc:
        log(f"webview.start failed: {exc}", "err")
        return False

    return shown["flag"]

# ---- main ---------------------------------------------------------------
def main():
    open_log()

    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", action="store_true", help="open in default browser")
    parser.add_argument("--no-open", action="store_true", help="server only")
    parser.add_argument("--no-splash", action="store_true", help="skip splash")
    parser.add_argument("--refresh-only", action="store_true", help="fetch and exit")
    parser.add_argument("--offline", action="store_true", help="skip network")
    args = parser.parse_args()

    splash = Splash() if (not args.no_splash and not args.refresh_only) else None
    if splash:
        splash.update("Loading runtime...")
    log(f"python {sys.version.split()[0]}")

    if splash:
        splash.update("Checking GitHub...")
    ok, msg = do_fetch(offline=args.offline)
    log(("downloaded: " if ok else "remote check: ") + msg, "ok" if ok else "warn")

    if args.refresh_only:
        if splash:
            splash.close()
        return

    if splash:
        splash.update("Starting server...")
    httpd, port = start_server()
    url = f"http://{HOST}:{port}/index.html"
    log(f"listening on {url}", "ok")

    if args.no_open:
        if splash:
            splash.close()
        _wait_for_exit()
        httpd.shutdown()
        return

    threading.Thread(target=background_refresher, args=(args.offline,), daemon=True).start()

    if splash:
        splash.update("Opening window...")
        time.sleep(0.2)
        splash.close()

    if args.browser:
        webbrowser.open(url)
        _wait_for_exit()
        httpd.shutdown()
        return

    window_ok = try_native(url)
    if not window_ok:
        log("native window not shown, opening browser", "warn")
        webbrowser.open(url)
        _wait_for_exit()

    httpd.shutdown()
    log("shutdown")

if __name__ == "__main__":
    main()