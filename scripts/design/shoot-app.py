#!/usr/bin/env python3
"""
Screenshot the running web app, route by route, with the same headless
Chromium that render-frames.py uses for the design, so a page and its frame
can be put side by side.

The app must be running with the mocked API (VITE_DEMO=1), because a
headless browser cannot sign in: the demo backend answers the session refresh
on load, so any authenticated route renders directly.

Usage (Git Bash, WSL or Linux CI):

  python3 scripts/design/shoot-app.py /login /dashboard /audience/contacts
  python3 scripts/design/shoot-app.py --from-index --param id=cmp_7q1m9z --param token=demo
  python3 scripts/design/shoot-app.py --mobile /login /campaigns
  python3 scripts/design/shoot-app.py --theme dark /dashboard

--from-index takes every distinct route in .design-rendered/index.json and
substitutes :params from --param; routes with an unknown param are skipped
and listed. --theme appends ?theme=light|dark, which the app honours only in
demo mode (apps/web/src/main.tsx).

Output: .design-rendered/app/<slug>.png (plus -mobile / -dark suffixes).
Standard library only. RELAYD_BROWSER overrides browser detection.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from render_frames_lib import find_browser, run_browser  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT_DEFAULT = ROOT / ".design-rendered" / "app"
INDEX = ROOT / ".design-rendered" / "index.json"


def slug(path: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", path).strip("-")
    return s or "root"


def app_path(raw: str) -> str:
    """
    Git Bash rewrites arguments that look like POSIX paths ("/login" becomes
    "C:/Program Files/Git/login") before Python sees them. Undo that using the
    MSYS root it exports, and accept paths given without the leading slash.
    """
    path = raw.replace("\\", "/")
    msys_root = os.environ.get("EXEPATH", "").replace("\\", "/").rstrip("/")
    if msys_root and path.lower().startswith(msys_root.lower()):
        path = path[len(msys_root) :]
    if re.match(r"^[A-Za-z]:/", path):
        path = "/" + path.split("/", 3)[-1] if path.count("/") >= 3 else path
    return path if path.startswith("/") else "/" + path


def serve(directory: Path) -> tuple[ThreadingHTTPServer, int]:
    """
    A throwaway static server for the mobile shim.

    The shim has to be fetched over http: Chrome will not let a file:// page
    frame an http:// one, and a blank iframe is exactly as misleading as the
    clipped screenshot it replaces.
    """
    handler = partial(SimpleHTTPRequestHandler, directory=str(directory))
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, port


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--base", default="http://127.0.0.1:5174")
    ap.add_argument("--out", default=str(OUT_DEFAULT))
    ap.add_argument("--from-index", action="store_true")
    ap.add_argument("--param", action="append", default=[], help="name=value for :name in routes")
    ap.add_argument("--mobile", action="store_true", help="390x844 instead of 1440x1024")
    ap.add_argument("--height", type=int, default=0, help="override the viewport height")
    ap.add_argument("--theme", choices=["light", "dark"], default="")
    ap.add_argument("--budget", type=int, default=6000)
    args = ap.parse_args()

    params = dict(p.split("=", 1) for p in args.param)
    paths: list[str] = [app_path(p) for p in args.paths]
    skipped: list[str] = []
    if args.from_index:
        for entry in json.loads(INDEX.read_text(encoding="utf-8")):
            route = entry["route"]
            if not route or route in paths:
                continue
            missing = [m for m in re.findall(r":(\w+)", route) if m not in params]
            if missing:
                skipped.append(route)
                continue
            for name, value in params.items():
                route = route.replace(f":{name}", value)
            if route not in paths:
                paths.append(route)
    if not paths:
        sys.exit("nothing to shoot; pass paths or --from-index")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    browser = find_browser()
    width, height = (390, 844) if args.mobile else (1440, 1024)
    if args.height:
        height = args.height
    suffix = ("-mobile" if args.mobile else "") + (f"-{args.theme}" if args.theme else "")
    # One profile per process: several agents shoot at once, and two headless
    # runs on one user-data-dir fail silently.
    profile = out / f".profile-{os.getpid()}"
    shim_server = serve(out) if args.mobile else None

    for path in paths:
        url = args.base.rstrip("/") + path
        if args.theme:
            url += ("&" if "?" in url else "?") + f"theme={args.theme}"
        png = out / f"{slug(path)}{suffix}.png"

        target, win_w, win_h = url, width, height
        budget = args.budget
        if args.mobile:
            # Windows clamps a browser window to about 500px, so
            # --window-size=390 lays the page out at ~500 and crops the
            # screenshot to 390 — which looks exactly like a page that
            # overflows, on a page that does not. Render the app inside an
            # iframe of the true width instead, in a window wide enough not
            # to be clamped. Cross-origin is fine: we only need it painted.
            shim = out / f".frame-{slug(path)}{suffix}.html"
            shim.write_text(
                "<!doctype html><meta charset=\"utf-8\">"
                "<style>html,body{margin:0;background:#fff}"
                f"iframe{{width:{width}px;height:{height}px;border:0;display:block}}</style>"
                f'<iframe src="{url}" scrolling="no"></iframe>',
                encoding="utf-8",
            )
            assert shim_server is not None
            target = f"http://127.0.0.1:{shim_server[1]}/{shim.name}"
            win_w, win_h = width + 40, height + 40
            # The SPA has to boot inside the frame before the shot is taken.
            budget = max(budget, 20000)

        run_browser(
            browser,
            [
                f"--window-size={win_w},{win_h}",
                f"--virtual-time-budget={budget}",
                f"--screenshot={png}",
                target,
            ],
            profile,
        )
        print(f"{path} -> {png.relative_to(ROOT)}")
    for route in sorted(set(skipped)):
        print(f"skipped (unknown param): {route}")
    if shim_server is not None:
        shim_server[0].shutdown()
    shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
