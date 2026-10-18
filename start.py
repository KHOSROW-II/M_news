#!/usr/bin/env python3
"""
News Aggregator desktop launcher.

Bundled as start.exe via PyInstaller on Windows.
On Linux, requires pywebview[qt] (with software rendering) or falls back to browser.
"""

import os
import sys

# --- Qt/Chromium env vars MUST be set before importing webview ----------
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

# ---- config -------------------------------------------------------------
HOST = "127.0.0.1"
RAW_BASE = os.environ.get(
    "NEWS_RAW_BASE",
    "https://raw.githubusercontent.com/USER/REPO/main/output",
).rstrip("/")
RAW_NEWS_URL = RAW_BASE + "/news-data.json"
RAW_ARCHIVE_URL = RAW_BASE + "/archive.json"
REFRESH_INTERVAL = 300
HTTP_TIMEOUT = 15

_refresh_lock = threading.Lock()
_last_refresh = {"ok": False, "message": "not started", "count": 0, "ts": 0}

# ---- noise filter -------------------------------------------------------
_NOISE_PATTERNS = [
    "GTK cannot be loaded",
    "QT cannot be loaded",
    "No module named 'gi'",
    "No module named 'qtpy'",
    "import webview.platforms.gtk",
    "import webview.platforms.qt",
    "webview/platforms/gtk.py",
    "webview/platforms/qt.py",
    "webview/guilib.py",
    "Sandboxing disabled by user",
    "vkDebug:",
    "EGL: Failed to query DRM",
    "GPUInfo not initialized",
    "Release of profile requested but WebEnginePage still not deleted",
    "Expect troubles !",
]


class _NoiseFilter(io.TextIOBase):
    def __init__(self, target):
        self.target = target

    def write(self, s):
        for line in s.splitlines(keepends=True):
            stripped = line.strip()
            if not stripped:
                self.target.write(line)
                continue
            if any(p in stripped for p in _NOISE_PATTERNS):
                continue
            if stripped.startswith('File "') and "site-packages/webview/" in stripped:
                continue
            if stripped.startswith("Traceback (most recent call last)"):
                continue
            if stripped.startswith('import ') or stripped.startswith('from '):
                continue
            if set(stripped) <= set("^~ "):
                continue
            self.target.write(line)
        return len(s)

    def flush(self):
        try:
            self.target.flush()
        except Exception:
            pass


@contextlib.contextmanager
def quiet_webview(verbose=False):
    if verbose:
        yield
        return
    old_stderr = sys.stderr
    sys.stderr = _NoiseFilter(old_stderr)
    try:
        yield
    finally:
        sys.stderr = old_stderr


# ---- logging ------------------------------------------------------------
def log(msg, level="info"):
    prefix = {"info": "  ", "ok": "[+]", "warn": "[!]", "err": "[x]"}.get(level, "  ")
    print(f"{prefix} {msg}", flush=True)


def progress(duration, label):
    if not sys.stdout.isatty():
        print(f"  {label}...", flush=True)
        time.sleep(duration)
        return
    steps = 28
    for i in range(steps + 1):
        pct = int(100 * i / steps)
        filled = int(28 * i / steps)
        bar = "=" * filled + "-" * (28 - filled)
        sys.stdout.write(f"\r  {label} [{bar}] {pct:3d}%")
        sys.stdout.flush()
        time.sleep(duration / steps)
    sys.stdout.write("\n")
    sys.stdout.flush()


# ---- remote fetch -------------------------------------------------------
def _http_get(url, timeout=HTTP_TIMEOUT):
    req = urllib.request.Request(url, headers={"User-Agent": "NewsAggregator/4.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def do_fetch():
    global _last_refresh

    if "USER/REPO" in RAW_BASE:
        _last_refresh = {"ok": False, "message": "URL not configured", "count": 0, "ts": time.time()}
        return False, "URL not configured"

    with _refresh_lock:
        try:
            raw = _http_get(RAW_NEWS_URL).decode("utf-8")
            parsed = json.loads(raw)
            if not isinstance(parsed.get("news"), list):
                raise ValueError("invalid payload")

            CACHE_DATA.write_text(raw, encoding="utf-8")

            try:
                arch_raw = _http_get(RAW_ARCHIVE_URL).decode("utf-8")
                if isinstance(json.loads(arch_raw), dict):
                    CACHE_ARCHIVE.write_text(arch_raw, encoding="utf-8")
            except Exception:
                pass

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

            _last_refresh = {"ok": True, "message": "updated", "count": len(parsed["news"]), "ts": time.time()}
            return True, f"{len(parsed['news'])} stories, {downloaded} images"
        except Exception as exc:
            _last_refresh = {"ok": False, "message": str(exc), "count": 0, "ts": time.time()}
            return False, str(exc)


def background_refresher():
    while True:
        time.sleep(REFRESH_INTERVAL)
        ok, msg = do_fetch()
        log(f"auto-refresh: {msg}", "ok" if ok else "warn")


# ---- file resolution ----------------------------------------------------
def resolve_news_file():
    candidates = [CACHE_DATA, BASE_DIR / "output" / "news-data.json", WEB_DIR / "data" / "news-data.json"]
    existing = [p for p in candidates if p.exists()]
    if not existing:
        return None
    return max(existing, key=lambda p: p.stat().st_mtime)


def resolve_archive_file():
    candidates = [CACHE_ARCHIVE, BASE_DIR / "output" / "archive.json", WEB_DIR / "data" / "archive.json"]
    existing = [p for p in candidates if p.exists()]
    if not existing:
        return None
    return max(existing, key=lambda p: p.stat().st_mtime)


def resolve_image(name):
    safe = Path(name).name
    candidates = [
        CACHE_IMAGES / safe,
        WEB_DIR / "images" / safe,
        WEB_DIR / "output" / "images" / safe,
        BASE_DIR / "output" / "images" / safe,
    ]
    for p in candidates:
        if p.exists() and p.is_file():
            return p
    return None


MIME_BY_EXT = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
    "gif": "image/gif",
    "svg": "image/svg+xml",
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

    def _send_file(self, file_path, mime, cache="no-store"):
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path

        # --- news JSON ---
        if path.startswith("/output/news-data.json"):
            news = resolve_news_file()
            if not news:
                return self._send_json({"news": [], "lastUpdated": None, "translationStats": {}}, 404)
            return self._send_file(news, "application/json; charset=utf-8")

        # --- archive JSON ---
        if path.startswith("/output/archive.json"):
            archive = resolve_archive_file()
            if not archive:
                return self._send_json({"news": [], "totalNews": 0}, 404)
            return self._send_file(archive, "application/json; charset=utf-8")

        # --- images ---
        if path.startswith("/images/"):
            raw_name = path.split("/images/", 1)[1].split("?", 1)[0]
            name = urllib.parse.unquote(raw_name)
            if not name or ".." in name or "/" in name or "\\" in name:
                return self.send_error(404)
            file_path = resolve_image(name)
            if not file_path:
                return self.send_error(404)
            ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
            mime = MIME_BY_EXT.get(ext, "application/octet-stream")
            return self._send_file(file_path, mime, cache="public, max-age=3600")

        # --- api ---
        if path.startswith("/api/refresh"):
            ok, msg = do_fetch()
            return self._send_json({"ok": ok, "message": msg, **_last_refresh})

        if path.startswith("/api/status"):
            return self._send_json(_last_refresh)

        # --- static files ---
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
def try_native(url, verbose=False):
    try:
        import webview
    except ImportError:
        log("pywebview not installed", "warn")
        return False

    shown = {"flag": False}

    try:
        window = webview.create_window(
            "News Aggregator",
            url,
            width=1280,
            height=850,
            min_size=(800, 600),
            text_select=True,
        )
        window.events.shown += lambda: shown.__setitem__("flag", True)
    except Exception as exc:
        log(f"create_window failed: {exc}", "err")
        return False

    started = time.time()
    try:
        with quiet_webview(verbose):
            webview.start()
    except Exception as exc:
        log(f"webview.start failed: {exc}", "err")
        return False

    duration = time.time() - started
    if shown["flag"]:
        log(f"window closed after {duration:.0f}s", "info")
    return shown["flag"]


# ---- main ---------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", action="store_true")
    parser.add_argument("--no-open", action="store_true")
    parser.add_argument("--refresh-only", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    progress(0.3, "Loading runtime")
    log(f"python {sys.version.split()[0]}", "ok")

    progress(0.2, "Preparing cache")
    log(f"cache: {CACHE_DIR}", "ok")

    progress(0.6, "Checking GitHub")
    ok, msg = do_fetch()
    if ok:
        log(f"downloaded: {msg}", "ok")
    else:
        log(f"remote check: {msg}", "warn")
        log("using bundled or cached data", "info")

    if args.refresh_only:
        log("refresh-only, exiting", "info")
        return

    progress(0.3, "Starting local server")
    httpd, port = start_server()
    url = f"http://{HOST}:{port}/index.html"
    log(f"listening on {url}", "ok")

    if args.no_open:
        log("server running, no window", "info")
        _wait_for_exit()
        httpd.shutdown()
        return

    threading.Thread(target=background_refresher, daemon=True).start()

    if args.browser:
        log("opening browser", "info")
        webbrowser.open(url)
        _wait_for_exit()
        httpd.shutdown()
        return

    progress(0.2, "Opening window")
    window_shown = try_native(url, verbose=args.verbose)

    if not window_shown:
        log("native window not shown, opening browser", "warn")
        webbrowser.open(url)
        _wait_for_exit()

    httpd.shutdown()
    log("shutdown", "info")


if __name__ == "__main__":
    main()