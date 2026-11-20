"""Classify what an agent actually did, from its stream-json transcript.

Protocol v2 gives both arms the same minimal prompt, so workflow behaviour is an
outcome to be measured, not an instruction. These are the measured behaviours.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

HAR_RE = re.compile(r"(?:^|[\s;&|(])har\s+(env|plugin|line|control|mcp)\b")
HAR_LAUNCH_RE = re.compile(r"har\s+env\s+launch\b")
HAR_VERIFY_RE = re.compile(r"har\s+env\s+verify\b")
HAR_VERIFY_FULL_RE = re.compile(r"har\s+env\s+verify\b[^\n;&|]*--full")
HAR_TEARDOWN_RE = re.compile(r"har\s+env\s+(teardown|complete)\b")

SERVICE_RE = re.compile(
    r"(docker\s+run|docker\s+compose\s+(up|start)|docker-compose\s+up|pm2\s+start|"
    r"npm\s+run\s+dev|yarn\s+dev|pnpm\s+dev|bun\s+run\s+dev|uvicorn\s|gunicorn\s|"
    r"flask\s+run|rails\s+s|manage\.py\s+runserver|vite(\s|$)|next\s+dev|har\s+env\s+setup-infra)"
)
TEST_RE = re.compile(
    r"(pytest|python\s+-m\s+pytest|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|bun\s+run\s+test|"
    r"npx\s+(jest|vitest|playwright|karma|mocha)|vitest|jest|mocha|karma\s+start|go\s+test|cargo\s+test|"
    r"mvn\s+test|gradlew?\s+test|make\s+test|tests-start\.sh|test\.sh)"
)
BUILD_LINT_RE = re.compile(
    r"(npm\s+run\s+(build|lint|typecheck)|yarn\s+(build|lint)|pnpm\s+(build|lint)|bun\s+run\s+(build|lint)|"
    r"tsc\b|mypy\b|ruff\b|flake8\b|eslint\b|biome\b|black\b|compileall|go\s+build|cargo\s+(check|build))"
)
INSTALL_RE = re.compile(
    r"(npm\s+(install|ci)\b|yarn\s+install|pnpm\s+install|bun\s+install|uv\s+(sync|venv|pip)|"
    r"pip\s+install|poetry\s+install|make\s+(install|venv|dev))"
)
COMMIT_RE = re.compile(r"git\s+(-C\s+\S+\s+)?commit\b")
STASH_RE = re.compile(r"git\s+(-C\s+\S+\s+)?stash\b")
TEST_PATH_RE = re.compile(r"(^|/)(tests?|__tests__|spec)(/|$)|\.(test|spec)\.[jt]sx?$|(^|/)test_[^/]+\.py$|_test\.py$")
HARNESS_DOC_RE = re.compile(r"(AGENTS\.md|CLAUDE\.md|\.har/README\.md|\.har/STAGES\.md|SKILL\.md)")
HAR_INTERNALS_RE = re.compile(r"node_modules/@osfactory/har")

EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}


def _iter_tool_uses(transcript: Path):
    if not transcript.exists():
        return
    for line in transcript.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.startswith("{") or '"tool_use"' not in line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "assistant":
            continue
        for block in (event.get("message") or {}).get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                yield block.get("name", "?"), (block.get("input") or {})


def classify(transcript: Path, *, work_dir: Path | None = None) -> dict[str, Any]:
    commands: list[str] = []
    edited: list[str] = []
    read_paths: list[str] = []
    for name, inp in _iter_tool_uses(transcript):
        if name == "Bash":
            commands.append(str(inp.get("command", "")))
        elif name in EDIT_TOOLS and inp.get("file_path"):
            edited.append(str(inp["file_path"]))
        elif name in {"Read", "Glob", "Grep"}:
            for key in ("file_path", "path", "pattern"):
                if inp.get(key):
                    read_paths.append(str(inp[key]))

    def any_cmd(rx: re.Pattern[str]) -> bool:
        return any(rx.search(c) for c in commands)

    def count_cmd(rx: re.Pattern[str]) -> int:
        return sum(1 for c in commands if rx.search(c))

    rel_edited = []
    for p in edited:
        try:
            rel_edited.append(str(Path(p).resolve().relative_to(work_dir.resolve())) if work_dir else p)
        except (ValueError, OSError):
            rel_edited.append(p)

    return {
        # HAR usage (only possible in ARM A, where the repository ships a harness)
        "har_any": any_cmd(HAR_RE),
        "har_commands": count_cmd(HAR_RE),
        "har_launch": any_cmd(HAR_LAUNCH_RE),
        "har_verify": any_cmd(HAR_VERIFY_RE),
        "har_verify_full": any_cmd(HAR_VERIFY_FULL_RE),
        "har_verify_count": count_cmd(HAR_VERIFY_RE),
        "har_teardown_or_complete": any_cmd(HAR_TEARDOWN_RE),
        "read_harness_docs": any(HARNESS_DOC_RE.search(p) for p in read_paths + rel_edited),
        "read_har_internals": any_cmd(HAR_INTERNALS_RE),
        # Workflow behaviour (both arms)
        "installed_deps": any_cmd(INSTALL_RE),  # the agent typed an install command itself
        # Provisioning happened one way or another: by hand, or by delegating to the harness
        # (a HAR launch installs dependencies and starts the app for the slot).
        "provisioned_environment": any_cmd(INSTALL_RE) or any_cmd(SERVICE_RE) or any_cmd(HAR_LAUNCH_RE),
        "started_services": any_cmd(SERVICE_RE),
        "ran_tests": any_cmd(TEST_RE),
        "ran_build_or_lint": any_cmd(BUILD_LINT_RE),
        "verified_anything": any_cmd(TEST_RE) or any_cmd(BUILD_LINT_RE) or any_cmd(HAR_VERIFY_RE),
        "committed": any_cmd(COMMIT_RE),
        "stashed": any_cmd(STASH_RE),
        "bash_commands": len(commands),
        "files_edited": sorted(set(rel_edited)),
        "test_files_edited": sorted({p for p in rel_edited if TEST_PATH_RE.search(p)}),
    }
