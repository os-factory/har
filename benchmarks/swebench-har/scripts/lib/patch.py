"""Extract SWE-bench model patches while excluding harness scaffolding."""

from __future__ import annotations

import re
from pathlib import Path

from .common import benchmark_config, run_command


def _exclude_prefixes() -> list[str]:
    cfg = benchmark_config()
    return list(cfg.get("patch_exclude_prefixes") or [])


def _path_excluded(path: str, prefixes: list[str]) -> bool:
    normalized = path.replace("\\", "/").lstrip("./")
    for prefix in prefixes:
        p = prefix.replace("\\", "/").lstrip("./").rstrip("/")
        if normalized == p or normalized.startswith(f"{p}/"):
            return True
    return False


def filter_changed_files(files: list[str], prefixes: list[str] | None = None) -> list[str]:
    prefixes = prefixes or _exclude_prefixes()
    return [path for path in files if not _path_excluded(path, prefixes)]


def extract_model_patch(work_dir: Path, base_commit: str) -> str:
    """Return a git diff suitable for SWE-bench, excluding harness files."""
    prefixes = _exclude_prefixes()
    result = run_command(["git", "diff", "--binary", base_commit, "HEAD"], cwd=work_dir)
    if result.returncode != 0:
        raise RuntimeError(f"git diff failed: {result.stderr or result.stdout}")
    raw = result.stdout
    if not raw.strip():
        return ""

    filtered_blocks: list[str] = []
    current_files: list[str] = []
    current_lines: list[str] = []

    def flush_block() -> None:
        nonlocal current_files, current_lines
        if not current_lines:
            return
        keep = any(not _path_excluded(path, prefixes) for path in current_files)
        if keep:
            filtered_blocks.append("".join(current_lines))
        current_files = []
        current_lines = []

    diff_git_re = re.compile(r"^diff --git a/(.+?) b/(.+)$")

    for line in raw.splitlines(keepends=True):
        match = diff_git_re.match(line)
        if match:
            flush_block()
            current_files = [match.group(1), match.group(2)]
        current_lines.append(line)
    flush_block()

    patch = "".join(filtered_blocks)
    if not patch.endswith("\n") and patch:
        patch += "\n"
    return patch
