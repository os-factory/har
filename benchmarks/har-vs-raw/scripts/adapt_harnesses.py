#!/usr/bin/env python3
"""Adapt pilot repo harnesses one-by-one: Claude + HAR MCP, gate before next repo."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import BENCHMARK_ROOT, benchmark_config, benchmark_repos, write_json  # noqa: E402


def run(cmd: list[str]) -> int:
    print(f"\n>>> {' '.join(cmd)}", flush=True)
    result = subprocess.run(cmd, cwd=BENCHMARK_ROOT)
    return result.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout-minutes", type=int, default=180)
    parser.add_argument("--launch-timeout-seconds", type=int, default=7200)
    parser.add_argument("--repo", help="Only adapt one repo id or owner/name")
    args = parser.parse_args()

    config = benchmark_config()
    pilot_repos = config.get("pilot_repos") or []
    repos = benchmark_repos()
    repos = [r for r in repos if f"{r['owner']}/{r['name']}" in pilot_repos or r["id"] in pilot_repos]
    if args.repo:
        repos = [r for r in repos if r["id"] == args.repo or f"{r['owner']}/{r['name']}" == args.repo]

    # jitsi closest to working — then lightdash, novu
    order = ["jitsi-meet", "lightdash", "novu"]
    repos.sort(key=lambda r: order.index(r["id"]) if r["id"] in order else 99)

    summary = []
    for repo in repos:
        print(f"\n{'='*60}\nAdapting {repo['owner']}/{repo['name']}\n{'='*60}", flush=True)
        code = run(
            [
                sys.executable,
                str(SCRIPT_DIR / "setup_harness.py"),
                "--repo",
                repo["id"],
                "--require-full-verify",
                "--timeout-minutes",
                str(args.timeout_minutes),
                "--launch-timeout-seconds",
                str(args.launch_timeout_seconds),
            ]
        )
        gate = run(
            [
                sys.executable,
                str(SCRIPT_DIR / "verify_harness_gate.py"),
                "--repo",
                repo["id"],
                "--launch-timeout-seconds",
                str(args.launch_timeout_seconds),
            ]
        )
        passed = code == 0 and gate == 0
        summary.append({"repo_id": repo["id"], "setup_exit": code, "gate_exit": gate, "passed": passed})
        if not passed:
            print(f"\nSTOP: {repo['id']} did not pass harness gate. Fix before continuing.", flush=True)
            write_json(BENCHMARK_ROOT / "results" / "adapt-harnesses-summary.json", summary)
            return 1
        print(f"\n✓ {repo['id']} passed harness gate — OK to run HAR issue-fix sessions", flush=True)

    write_json(BENCHMARK_ROOT / "results" / "adapt-harnesses-summary.json", summary)
    print("\nAll pilot harnesses adapted and gated.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
