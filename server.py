#!/usr/bin/env python3
"""Film lab, local folder mode.

    python3 server.py --in ~/Pictures/roll-01 [--leaks ~/Pictures/light-leaks]

Serves the web app on http://localhost:8790 with that folder's JPEGs already
loaded. Exports are saved to ~/Downloads (change with --out). Originals are
never modified. Python 3 standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import threading
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

WEB = Path(__file__).resolve().parent / "web"
IMAGE_EXT = (".jpg", ".jpeg")
LEAK_EXT = (".jpg", ".jpeg", ".png", ".webp")


class Config:
    in_dir: Path
    out_dir: Path
    leak_dir: Path | None
    state_file: Path
    lock = threading.Lock()


def _list(folder: Path | None, exts: tuple[str, ...]) -> list[str]:
    if not folder or not folder.is_dir():
        return []
    return sorted(p.name for p in folder.iterdir() if p.suffix.lower() in exts and not p.name.startswith("."))


def _child(folder: Path | None, name: str) -> Path | None:
    """Resolve a client-supplied filename strictly inside `folder`."""
    if not folder:
        return None
    p = (folder / unquote(name)).resolve()
    return p if p.parent == folder.resolve() and p.is_file() else None


def _unique(path: Path) -> Path:
    n, out = 1, path
    while out.exists():
        out = path.with_name(f"{path.stem}-{n}{path.suffix}")
        n += 1
    return out


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if args and "/api/photo/" in str(args[0]):
            return
        super().log_message(fmt, *args)

    def _json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path):
        data = path.read_bytes()
        ctype = {".png": "image/png", ".webp": "image/webp"}.get(path.suffix.lower(), "image/jpeg")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if parts[:2] == ["api", "photos"]:
            return self._json({
                "photos": [{"name": n} for n in _list(Config.in_dir, IMAGE_EXT)],
                "leaks": _list(Config.leak_dir, LEAK_EXT),
                "inDir": str(Config.in_dir) if Config.in_dir else "",
                "outDir": str(Config.out_dir),
            })
        if parts[:2] == ["api", "state"]:
            with Config.lock:
                text = Config.state_file.read_text() if Config.state_file.exists() else "{}"
            return self._json(json.loads(text))
        if len(parts) == 3 and parts[:2] in (["api", "photo"], ["api", "leak"]):
            folder = Config.in_dir if parts[1] == "photo" else Config.leak_dir
            path = _child(folder, parts[2])
            if not path:
                return self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return self._file(path)
        return super().do_GET()

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if parts[:2] == ["api", "state"]:
            with Config.lock:
                Config.state_file.write_text(json.dumps(json.loads(body), indent=2))
            return self._json({"ok": True})
        if len(parts) == 3 and parts[:2] == ["api", "export"]:
            name = Path(unquote(parts[2])).name
            if not name.lower().endswith(".jpg"):
                return self._json({"error": "bad name"}, HTTPStatus.BAD_REQUEST)
            out = _unique(Config.out_dir / name)
            out.write_bytes(body)
            return self._json({"ok": True, "path": str(out)})
        return self._json({"error": "unknown route"}, HTTPStatus.NOT_FOUND)


def _in_use(port: int) -> bool:
    """True if anything answers on localhost:port (IPv4 or IPv6)."""
    for host in ("127.0.0.1", "::1"):
        try:
            with socket.create_connection((host, port), timeout=0.2):
                return True
        except OSError:
            pass
    return False


def _bind(port: int) -> ThreadingHTTPServer:
    """Bind the first free port from `port` upward (another copy may be running)."""
    for p in range(port, port + 20):
        if _in_use(p):
            continue
        try:
            return ThreadingHTTPServer(("127.0.0.1", p), Handler)
        except OSError:
            continue
    raise SystemExit(f"No free port between {port} and {port + 19}.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", nargs="?", help="folder of JPEGs to load (optional; you can also import in the app)")
    ap.add_argument("--in", dest="in_dir", help="same as the folder argument")
    ap.add_argument("--out", dest="out_dir", default=str(Path.home() / "Downloads"), help="where exports go (default: ~/Downloads)")
    ap.add_argument("--leaks", dest="leak_dir", default=os.environ.get("FILM_LAB_LEAKS"), help="folder of light-leak scans")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8790)))
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args()

    folder = a.in_dir or a.folder
    Config.in_dir = Path(folder).expanduser().resolve() if folder else None
    if Config.in_dir and not Config.in_dir.is_dir():
        raise SystemExit(f"Not a folder: {Config.in_dir}")
    Config.out_dir = Path(a.out_dir).expanduser()
    Config.out_dir.mkdir(parents=True, exist_ok=True)
    Config.leak_dir = Path(a.leak_dir).expanduser() if a.leak_dir else None
    Config.state_file = (Config.in_dir or Path.home()) / ".film-lab-state.json"

    srv = _bind(a.port)
    url = f"http://localhost:{srv.server_address[1]}/"
    print(f"Film lab on {url}\n  photos: {Config.in_dir or 'import in the app'}\n  saves:  {Config.out_dir}\n  leaks:  {Config.leak_dir or '-'}")
    print("Press Ctrl+C to stop.", flush=True)
    if not a.no_open:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
