"""
Shared bits for the design tooling: finding a headless Chromium and running
it. Used by render-frames.py (the design export) and shoot-app.py (the app).
Standard library only; RELAYD_BROWSER overrides detection.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

BROWSER_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def find_browser() -> str:
    env = os.environ.get("RELAYD_BROWSER")
    if env and Path(env).exists():
        return env
    for candidate in BROWSER_CANDIDATES:
        if Path(candidate).exists():
            return candidate
    for name in ("msedge", "google-chrome", "chromium", "chrome"):
        found = shutil.which(name)
        if found:
            return found
    sys.exit("no Chromium found; set RELAYD_BROWSER to msedge.exe or chrome")


def run_browser(browser: str, args: list[str], profile: Path, timeout: int = 120) -> bytes:
    """One headless run; each concurrent caller needs its own profile dir."""
    profile.mkdir(parents=True, exist_ok=True)
    cmd = [
        browser,
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--disable-extensions",
        "--hide-scrollbars",
        f"--user-data-dir={profile}",
        *args,
    ]
    result = subprocess.run(cmd, capture_output=True, timeout=timeout)
    return result.stdout
