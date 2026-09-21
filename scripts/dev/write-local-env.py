#!/usr/bin/env python3
"""
Write a local .env from .env.example plus a development JWT keypair.

Why this exists rather than a line in a README: `scripts/lib/load-env.sh`
reads one KEY=value per line, so a 28-line PEM cannot go in verbatim. The
config layer (packages/config/src/schema.ts) unescapes the newlines on read,
so the file has to hold them escaped, and doing that by hand is how people
end up with a key that silently fails to import.

Usage, from the repository root:

    python3 scripts/dev/write-local-env.py            # refuses to clobber
    python3 scripts/dev/write-local-env.py --force    # overwrite

Generate the keypair first:

    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \\
        -out .secrets/jwt.key
    openssl rsa -pubout -in .secrets/jwt.key -out .secrets/jwt.pub

Development keys only. .secrets/ and .env are both git-ignored.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

AUTH_BLOCK = """
# --- access-token signing (packages/config, authEnv) -----------------------
# RS256 with a key id so keys can be rotated. Generated locally into
# .secrets/ (git-ignored):
#   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out .secrets/jwt.key
#   openssl rsa -pubout -in .secrets/jwt.key -out .secrets/jwt.pub
#
# The newlines are escaped because scripts/lib/load-env.sh reads one key per
# line; packages/config unescapes them before jose imports the key. These are
# DEVELOPMENT keys - never reuse them anywhere real.
JWT_PRIVATE_KEY={private}
JWT_PUBLIC_KEY={public}
JWT_KEY_ID=k1

# 15 minutes and 30 days, per docs/06.
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_DAYS=30

# Where the browser reaches the SPA. Verification and invitation emails build
# their links from it, so a wrong value produces links that 404.
APP_BASE_URL=http://localhost:5173
"""


def escaped(path: Path) -> str:
    """A PEM as one line, with its newlines written as a backslash and an n."""
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n").strip()
    if "-----BEGIN" not in text:
        sys.exit(f"{path} does not look like a PEM")
    return text.replace("\n", "\\" + "n")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true", help="overwrite an existing .env")
    args = ap.parse_args()

    env_path = ROOT / ".env"
    if env_path.exists() and not args.force:
        sys.exit(".env already exists; pass --force to overwrite it")

    example = ROOT / ".env.example"
    private = ROOT / ".secrets" / "jwt.key"
    public = ROOT / ".secrets" / "jwt.pub"
    for required in (example, private, public):
        if not required.exists():
            sys.exit(f"missing {required.relative_to(ROOT)} - see this script's docstring")

    body = example.read_text(encoding="utf-8").rstrip("\n")
    body += "\n" + AUTH_BLOCK.format(private=escaped(private), public=escaped(public))
    env_path.write_text(body, encoding="utf-8", newline="\n")

    keys = [
        line.split("=", 1)[0]
        for line in body.split("\n")
        if "=" in line and not line.lstrip().startswith("#")
    ]
    print(f"wrote {env_path.relative_to(ROOT)} with {len(keys)} variables:")
    for key in keys:
        print(f"  {key}")


if __name__ == "__main__":
    main()
