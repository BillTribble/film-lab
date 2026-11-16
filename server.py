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
                "inDir": str(Config.in_dir),
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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="in_dir", default=".", help="folder of JPEGs (default: current folder)")
    ap.add_argument("--out", dest="out_dir", default=str(Path.home() / "Downloads"), help="where exports go")
    ap.add_argument("--leaks", dest="leak_dir", default=os.environ.get("FILM_LAB_LEAKS"), help="folder of light-leak scans")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8790)))
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args()

    Config.in_dir = Path(a.in_dir).expanduser().resolve()
    Config.out_dir = Path(a.out_dir).expanduser()
    Config.out_dir.mkdir(parents=True, exist_ok=True)
    Config.leak_dir = Path(a.leak_dir).expanduser() if a.leak_dir else None
    Config.state_file = Config.in_dir / ".film-lab-state.json"

    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    url = f"http://localhost:{a.port}/"
    print(f"Film lab on {url}\n  photos: {Config.in_dir}\n  saves:  {Config.out_dir}\n  leaks:  {Config.leak_dir or '-'}")
    if not a.no_open:
        webbrowser.open(url)
    srv.serve_forever()


if __name__ == "__main__":
    main()
