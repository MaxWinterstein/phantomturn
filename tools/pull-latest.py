#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["garminconnect>=0.3.11"]
# ///
"""Fetch the most recent pool swim from Garmin Connect as an original .fit.

Garmin has no official personal API. garth, the long-time community answer,
was deprecated in 2026 after Garmin changed their SSO flow; garminconnect
survived by reimplementing the mobile app's login natively (curl_cffi does
the TLS impersonation that gets past Cloudflare). Tokens persist and
auto-refresh, so: `--login` once, then every later run is credential-free.

Two rules this script enforces on purpose:

  * The download is the ORIGINAL file ("Export Original"), not one of
    Garmin's re-encoded exports. The whole repository exists because
    decode/encode roundtrips lose data; fetching a lossy export here would
    poison every golden file downstream.

  * The output directory must lie OUTSIDE the repository. A raw export
    carries the owner's name, biometrics and watch serial (see AGENTS.md),
    and .gitignore is the last line of defence, not the first.

Status text goes to stderr; stdout carries exactly one line, the path of
the downloaded file, so callers can chain it:

    node packages/fitfix/src/cli.mjs "$(uv run tools/pull-latest.py)" --dry-run
"""

import argparse
import io
import os
import sys
import zipfile
from pathlib import Path

from garminconnect import Garmin, GarminConnectAuthenticationError

REPO = Path(__file__).resolve().parents[1]
TOKEN_DIR = os.environ.get("GARMINTOKENS", "~/.garminconnect")

say = lambda *a: print(*a, file=sys.stderr)


def prompt_mfa() -> str:
    # A pre-supplied code beats an interactive prompt in environments where
    # stdin is not a terminal (CI, agent sandboxes).
    return os.environ.get("GARMIN_MFA_CODE") or input("MFA code: ")


def login() -> None:
    email = os.environ.get("GARMIN_EMAIL") or input("Garmin email: ")
    password = os.environ.get("GARMIN_PASSWORD") or input("Garmin password: ")
    g = Garmin(email, password, prompt_mfa=prompt_mfa)
    g.login(TOKEN_DIR)  # fresh login dumps tokens to TOKEN_DIR itself
    say(f"Logged in; tokens saved to {TOKEN_DIR}")


def pull(out_dir: Path, limit: int) -> Path:
    out_dir = out_dir.expanduser().resolve()
    if out_dir.is_relative_to(REPO):
        sys.exit(f"refusing to write a raw activity inside the repo ({out_dir})")

    g = Garmin()
    try:
        g.login(TOKEN_DIR)
    except GarminConnectAuthenticationError:
        sys.exit(f"no usable tokens in {TOKEN_DIR} -- run with --login first")

    activities = g.get_activities(0, limit)
    swim = next(
        (a for a in activities if a["activityType"]["typeKey"] == "lap_swimming"),
        None,
    )
    if swim is None:
        sys.exit(f"no pool swim among the last {limit} activities")

    aid = swim["activityId"]
    say(
        f"Latest pool swim: {aid} on {swim['startTimeLocal']} "
        f"({swim.get('distance') or 0:.0f} m as recorded)"
    )

    dest = out_dir / f"{aid}_ACTIVITY.fit"
    if dest.exists():
        say(f"Already downloaded: {dest}")
        return dest

    # ORIGINAL returns a zip wrapping the file as uploaded by the watch.
    # Whatever the inner name, it is renamed to the <activityId>_ACTIVITY.fit
    # convention the rest of the workflow expects.
    blob = g.download_activity(str(aid), dl_fmt=Garmin.ActivityDownloadFormat.ORIGINAL)
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        fits = [n for n in zf.namelist() if n.lower().endswith(".fit")]
        if len(fits) != 1:
            sys.exit(f"expected one .fit in the export, got {fits}")
        dest.write_bytes(zf.read(fits[0]))
    say(f"Saved {dest} ({dest.stat().st_size} bytes)")
    return dest


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--login", action="store_true", help="authenticate once and save tokens")
    ap.add_argument("--out", type=Path, default=REPO.parent, help="where to save (default: repo parent)")
    ap.add_argument("--limit", type=int, default=50, help="how many recent activities to search")
    args = ap.parse_args()

    if args.login:
        login()
        return
    print(pull(args.out, args.limit))


if __name__ == "__main__":
    main()
