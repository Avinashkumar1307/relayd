#!/usr/bin/env python3
"""
Render the Claude Design export in design/ into per-frame HTML and PNGs.

Why this exists: the .dc.html files are not static. Most frames are generated
at page load by the export's runtime (support.js) from data arrays — the
wizard steps, detail states, empty and error states, banners — and every
page frame pulls the shell in through <dc-import name="Shell">, which only
resolves over HTTP. Reading the raw files therefore shows a fraction of the
design. This script loads each file in a headless Chromium (Edge on Windows,
Chrome elsewhere), dumps the rendered DOM, cuts it into one self-contained
HTML file per frame, screenshots each at the frame's own size, and writes an
index. CLAUDE.md section 15: every page must match its frame — this is how
the frame is looked at.

Usage (Git Bash, WSL or Linux CI — never assumes PowerShell):

  python3 scripts/design/render-frames.py                 # everything
  python3 scripts/design/render-frames.py --only B,G,K    # some sections
  python3 scripts/design/render-frames.py --no-shots      # HTML only

Output (git-ignored): .design-rendered/
  rendered/<file>.html      the full rendered DOM of each export file
  frames/<S>/<ID>.html      one frame, self-contained (styles + fonts inline)
  frames/<S>/<ID>.png       the frame at its own width and height
  sheet/<section>.html|png  the design-system sheet, one file per section
  index.json, index.md      every frame: id, title, route, variant, files

Browser: RELAYD_BROWSER=<path> overrides detection. Standard library only.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import html
import json
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from render_frames_lib import find_browser, run_browser  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DESIGN = ROOT / "design"
OUT_DEFAULT = ROOT / ".design-rendered"

SHEET_FILE = "00 Design System"
SHEET_SECTIONS = [
    "colour", "type", "space", "buttons", "inputs", "badges", "progress",
    "table", "states", "overlays", "secrets", "toasts", "skeletons", "banners",
]

# The runtime stamps data-dc-tpl attributes ahead of class, so nothing here
# assumes attribute order or adjacency.
FRAME_RE = re.compile(
    r'<div[^>]*\bclass="dv-opt"[^>]*\bid="(?P<id>[^"]+)"[^>]*>\s*'
    r'<div[^>]*\bclass="dv-olabel"[^>]*>(?P<label>.*?)</div>',
    re.S,
)
CARD_RE = re.compile(r'<div[^>]*\bclass="dv-card"[^>]*>')
# The rendered DOM does not preserve attribute order, so match the tag first
# and pull each attribute out of it separately.
CANVAS_RE = re.compile(r'<div(?P<attrs>[^>]*\bdata-screen-label="[^"]*"[^>]*)>', re.S)
ATTR_RE = {
    "screen": re.compile(r'\bdata-screen-label="([^"]*)"'),
    "theme": re.compile(r'\bdata-theme="(light|dark)"'),
    "style": re.compile(r'\bstyle="([^"]*)"'),
}


def attr(attrs: str, name: str, default: str = "") -> str:
    m = ATTR_RE[name].search(attrs)
    return html.unescape(m.group(1)) if m else default
STYLE_RE = re.compile(r"<style[^>]*>.*?</style>", re.S)
LINK_RE = re.compile(r"<link[^>]*>", re.S)
SCRIPT_RE = re.compile(r"<script[^>]*>.*?</script>", re.S)
TAG_RE = re.compile(r"<[^>]+>")


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def start_server(port: int) -> subprocess.Popen | None:
    """Serve design/ over HTTP; the export's imports do not resolve over file://."""
    if port_open(port):
        log(f"using the server already on :{port}")
        return None
    proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1", "--directory", str(DESIGN)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(50):
        if port_open(port):
            return proc
        time.sleep(0.1)
    proc.terminate()
    sys.exit("could not start the design HTTP server")


def dump_dom(browser: str, url: str, profile: Path, budget_ms: int) -> str:
    raw = run_browser(browser, [f"--virtual-time-budget={budget_ms}", "--dump-dom", url], profile)
    return raw.decode("utf-8", errors="replace")


def screenshot(browser: str, page: Path, png: Path, width: int, height: int, profile: Path) -> None:
    run_browser(
        browser,
        [
            f"--window-size={width},{height}",
            "--virtual-time-budget=10000",
            f"--screenshot={png}",
            page.resolve().as_uri(),
        ],
        profile,
    )


def text_of(fragment: str) -> str:
    return html.unescape(TAG_RE.sub("", fragment)).strip()


def head_assets(rendered: str) -> str:
    """Every stylesheet and font link the rendered page carried, deduplicated."""
    seen: list[str] = []
    for m in LINK_RE.finditer(rendered):
        tag = m.group(0)
        if ("stylesheet" in tag or "fonts.g" in tag) and tag not in seen:
            seen.append(tag)
    for m in STYLE_RE.finditer(rendered):
        if m.group(0) not in seen:
            seen.append(m.group(0))
    return "\n".join(seen)


def px(style: str, prop: str) -> int | None:
    m = re.search(rf"(?<![-\w]){prop}:\s*(\d+)px", style)
    return int(m.group(1)) if m else None


def parse_screen(screen: str) -> tuple[str, str, str]:
    """'B4 Reset password /reset-password/:token' -> (title, route, variant)."""
    screen = html.unescape(screen)
    parts = screen.split(" ")
    route_i = next((i for i, p in enumerate(parts) if p.startswith("/")), None)
    if route_i is None:
        return screen, "", ""
    title = " ".join(parts[1:route_i]).strip()
    route = parts[route_i]
    variant = " ".join(parts[route_i + 1 :]).strip(" ·-—")
    return title, route, variant


def wrap(assets: str, body: str, width: int, theme: str) -> str:
    body = SCRIPT_RE.sub("", body)
    return (
        "<!doctype html>\n"
        f'<html data-theme="{theme}"><head><meta charset="utf-8">\n'
        f"{assets}\n"
        "<style>html,body{margin:0;background:#e5e7eb}"
        ".rf-frame{display:inline-block;vertical-align:top}</style>\n"
        "</head><body>\n"
        f'<div class="rf-frame" style="width:{width}px">{body}</div>\n'
        "</body></html>\n"
    )


def frame_record(section_code: str, fid: str, label: str, card: str) -> dict | None:
    canvas = CANVAS_RE.search(card)
    if canvas is None:
        return None
    attrs = canvas.group("attrs")
    style = attr(attrs, "style")
    screen = attr(attrs, "screen")
    theme = attr(attrs, "theme", "light")
    # Shell frames size the imported shell, not the canvas; read that too.
    width = px(style, "width") or 1440
    height = px(style, "height") or px(style, "min-height") or px(card[:4000], "min-height") or 1024
    title, route, variant = parse_screen(screen)
    label = re.sub(rf"^{re.escape(section_code)}\d*[a-z]?\s*", "", text_of(label))
    return {
        "id": fid,
        "section": section_code,
        "screen": screen,
        "title": title,
        "route": route,
        "variant": variant,
        "description": label,
        "theme": theme,
        "width": width,
        "height": height,
        "_body": card,
    }


def split_frames(rendered: str, section_code: str) -> list[dict]:
    starts = list(FRAME_RE.finditer(rendered))
    frames: list[dict] = []
    if not starts:
        # No option wrappers (01 Shell + Dashboard options): one frame per
        # canvas, named by the nearest preceding id or by position.
        canvases = list(CANVAS_RE.finditer(rendered))
        for i, m in enumerate(canvases):
            end = canvases[i + 1].start() if i + 1 < len(canvases) else len(rendered)
            near = re.findall(r'\bid="([^"]+)"', rendered[max(0, m.start() - 800) : m.start()])
            fid = near[-1] if near else f"{section_code}-{i + 1}"
            rec = frame_record(section_code, fid, "", rendered[m.start() : end])
            if rec:
                frames.append(rec)
        return frames
    for i, m in enumerate(starts):
        end = starts[i + 1].start() if i + 1 < len(starts) else len(rendered)
        chunk = rendered[m.start() : end]
        card_tag = CARD_RE.search(chunk)
        if card_tag is None:
            continue
        rec = frame_record(section_code, m.group("id"), m.group("label"), chunk[card_tag.end() :])
        if rec:
            frames.append(rec)
    return frames


def split_sheet(rendered: str) -> list[tuple[str, str]]:
    """The component sheet has no frames; cut it at its section ids instead."""
    positions = []
    for sid in SHEET_SECTIONS:
        m = re.search(rf'<[a-z]+[^>]*\bid="{sid}"', rendered)
        if m:
            positions.append((m.start(), sid))
    positions.sort()
    out = []
    for i, (start, sid) in enumerate(positions):
        end = positions[i + 1][0] if i + 1 < len(positions) else rendered.rfind("</body>")
        out.append((sid, rendered[start:end]))
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(OUT_DEFAULT))
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--only", default="", help="comma list of section codes, e.g. B,G,K,00,01")
    ap.add_argument("--budget", type=int, default=15000, help="virtual time budget per page, ms")
    ap.add_argument("--no-shots", action="store_true")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    out = Path(args.out)
    (out / "rendered").mkdir(parents=True, exist_ok=True)
    (out / "frames").mkdir(exist_ok=True)
    (out / "sheet").mkdir(exist_ok=True)
    profiles = out / "tmp"
    browser = find_browser()
    log(f"browser: {browser}")

    only = {s.strip() for s in args.only.split(",") if s.strip()}
    files = sorted(DESIGN.glob("*.dc.html"))
    server = start_server(args.port)
    index: list[dict] = []
    shots: list[tuple[Path, Path, int, int]] = []
    try:
        for file in files:
            name = file.stem.replace(".dc", "")
            code = name.split(" ")[0]
            if only and code not in only:
                continue
            url = f"http://127.0.0.1:{args.port}/" + file.name.replace(" ", "%20").replace("&", "%26")
            rendered = dump_dom(browser, url, profiles / "dom", args.budget)
            (out / "rendered" / f"{name}.html").write_text(rendered, encoding="utf-8")
            assets = head_assets(rendered)
            left = rendered.count("sc-placeholder")

            if name == SHEET_FILE:
                for sid, chunk in split_sheet(rendered):
                    page = out / "sheet" / f"{sid}.html"
                    page.write_text(wrap(assets, chunk, 1440, "light"), encoding="utf-8")
                    shots.append((page, page.with_suffix(".png"), 1500, 1800))
                log(f"{name}: {len(SHEET_SECTIONS)} sheet sections, {left} placeholders left")
                continue

            frames = split_frames(rendered, code)
            sect_dir = out / "frames" / code
            sect_dir.mkdir(exist_ok=True)
            for fr in frames:
                page = sect_dir / f"{fr['id']}.html"
                page.write_text(wrap(assets, fr.pop("_body"), fr["width"], fr["theme"]), encoding="utf-8")
                fr["html"] = str(page.relative_to(out)).replace("\\", "/")
                fr["png"] = str(page.with_suffix(".png").relative_to(out)).replace("\\", "/")
                fr["file"] = file.name
                index.append(fr)
                shots.append((page, page.with_suffix(".png"), fr["width"] + 60, fr["height"] + 60))
            log(f"{name}: {len(frames)} frames, {left} placeholders left")

        if not args.no_shots and shots:
            log(f"screenshots: {len(shots)} with {args.workers} workers")

            def shoot(job: tuple[int, tuple[Path, Path, int, int]]) -> str:
                n, (page, png, w, h) = job
                screenshot(browser, page, png, w, h, profiles / f"shot{n % args.workers}")
                return png.name

            with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
                done = 0
                for _ in pool.map(shoot, enumerate(shots)):
                    done += 1
                    if done % 20 == 0:
                        log(f"  {done}/{len(shots)}")
    finally:
        if server is not None:
            server.terminate()

    # Merge with any existing index so --only runs do not drop other sections.
    index_path = out / "index.json"
    existing: list[dict] = []
    if index_path.exists() and only:
        existing = [e for e in json.loads(index_path.read_text(encoding="utf-8")) if e["section"] not in only]
    merged = sorted(existing + index, key=lambda e: (e["section"], e["id"]))
    index_path.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")

    lines = ["# Rendered design frames", "", "| id | screen | route | variant | description | files |", "|---|---|---|---|---|---|"]
    for e in merged:
        lines.append(
            f"| {e['id']} | {e['title']} | `{e['route']}` | {e['variant']} | {e['description']} | "
            f"[html]({e['html']}) [png]({e['png']}) |"
        )
    (out / "index.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    log(f"index: {len(merged)} frames -> {index_path}")
    shutil.rmtree(profiles, ignore_errors=True)


if __name__ == "__main__":
    main()
