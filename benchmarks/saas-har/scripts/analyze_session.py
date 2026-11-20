#!/usr/bin/env python3
"""Summarize one Claude Code stream-json transcript: tools, files edited, shell commands, HAR usage, verify attempts."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.claude_runner import summarize_transcript  # noqa: E402

VERIFY_RE = re.compile(r"(har env verify|pytest|npm (run )?test|npx playwright|vitest|jest|uv run pytest|make test|npm run (lint|build|typecheck)|ruff|mypy|eslint|tsc)")


def analyze(path: Path) -> dict:
    summary = summarize_transcript(path)
    files = Counter()
    reads = Counter()
    commands: list[str] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "assistant":
            continue
        for block in (event.get("message") or {}).get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            name = block.get("name")
            inp = block.get("input") or {}
            if name in {"Edit", "Write", "MultiEdit", "NotebookEdit"} and inp.get("file_path"):
                files[inp["file_path"]] += 1
            elif name == "Read" and inp.get("file_path"):
                reads[inp["file_path"]] += 1
            elif name == "Bash":
                commands.append(str(inp.get("command", "")))
    verify_cmds = [c for c in commands if VERIFY_RE.search(c)]
    har_cmds = [c for c in commands if re.search(r"(^|\s|;|&&)har\s", c)]
    har_kinds = Counter()
    for c in har_cmds:
        m = re.search(r"har\s+(env\s+\S+|plugin\s+\S+|\S+)", c)
        if m:
            har_kinds[m.group(1)] += 1
    result = summary.get("result") or {}
    return {
        "transcript": str(path),
        "num_turns": result.get("num_turns"),
        "cost_usd": result.get("total_cost_usd"),
        "duration_min": round((result.get("duration_ms") or 0) / 60000, 1),
        "tool_calls": summary.get("tool_calls"),
        "tools": summary.get("tool_names"),
        "files_edited": dict(files.most_common()),
        "files_read_top": dict(reads.most_common(15)),
        "bash_commands": len(commands),
        "verify_like_commands": len(verify_cmds),
        "verify_like_sample": verify_cmds[:30],
        "har_commands": len(har_cmds),
        "har_command_kinds": dict(har_kinds.most_common()),
        "reads_har_internals": sum(1 for c in commands if "node_modules/@osfactory/har" in c),
        "final_text": result.get("final_text"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("transcripts", nargs="+")
    parser.add_argument("--brief", action="store_true")
    args = parser.parse_args()
    for t in args.transcripts:
        data = analyze(Path(t))
        if args.brief:
            data.pop("final_text", None)
            data.pop("verify_like_sample", None)
            data.pop("files_read_top", None)
        print(json.dumps(data, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
