"""Build the graded model patch.

Two kinds of exclusion, both scoring mechanics rather than rules given to the agent:

1. harness-owned paths (`.har/`, `AGENTS.md`, …) — never part of a product change;
2. files the hidden test patch touches — the scorer re-applies that patch, so keeping the
   agent's version of those files would conflict (same convention as both datasets' runners).

Plus one contamination guard: files that launching the environment is known to dirty
(recorded task-blind during the readiness gate) are dropped unless the agent edited them.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from .common import benchmark_config, run_command

DIFF_GIT_RE = re.compile(r"^diff --git a/(.+?) b/(.+)$")

# Test-suite paths. Protocol v2 tells the agent nothing, so it may add or edit tests; those edits
# are recorded as behaviour but must never reach the graded patch, because both scorers own the
# test corpus (SWE-bench resets test files then applies test_patch; the PrototypeBench reference
# runner excludes `*test*` from the agent diff). Product code under such a path is not expected.
TEST_PATH_RE = re.compile(
    r"(^|/)(tests?|__tests__|spec|specs|e2e)(/|$)"
    r"|(^|/)test_[^/]+\.py$|_test\.py$|_test\.go$"
    r"|\.(test|spec)\.[cm]?[jt]sx?$"
    r"|(^|/)conftest\.py$",
    re.IGNORECASE,
)


def is_test_path(path: str) -> bool:
    return bool(TEST_PATH_RE.search(_norm(path)))


# A dependency lockfile without a matching manifest change is environment noise: it appears when
# an agent (or a launch) runs an install. Keeping it is not neutral — a stale lockfile can break
# the scorer's own install — and it must be treated the same way in every arm, whether the churn
# came from HAR's launch or from the raw arm's own `npm install`.
LOCKFILE_MANIFESTS = {
    "package-lock.json": "package.json",
    "npm-shrinkwrap.json": "package.json",
    "yarn.lock": "package.json",
    "pnpm-lock.yaml": "package.json",
    "bun.lock": "package.json",
    "bun.lockb": "package.json",
    "uv.lock": "pyproject.toml",
    "poetry.lock": "pyproject.toml",
    "Pipfile.lock": "Pipfile",
    "Cargo.lock": "Cargo.toml",
    "composer.lock": "composer.json",
    "Gemfile.lock": "Gemfile",
    "go.sum": "go.mod",
}


def orphan_lockfiles(paths: set[str]) -> set[str]:
    """Lockfiles in a diff whose manifest is not also in that diff."""
    normalized = {_norm(p) for p in paths}
    manifests = {Path(p).name for p in normalized}
    out = set()
    for path in normalized:
        manifest = LOCKFILE_MANIFESTS.get(Path(path).name)
        if manifest and manifest not in manifests:
            out.add(path)
    return out


def _norm(path: str) -> str:
    path = path.replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    return path


def exclude_prefixes() -> list[str]:
    return list(benchmark_config().get("patch_exclude_prefixes") or [])


def path_excluded(path: str, prefixes: list[str], exact: set[str] | None = None) -> bool:
    normalized = _norm(path)
    if exact and normalized in exact:
        return True
    for prefix in prefixes:
        p = _norm(prefix).rstrip("/")
        if normalized == p or normalized.startswith(f"{p}/"):
            return True
    return False


def files_in_patch(patch_text: str | None) -> set[str]:
    files: set[str] = set()
    for line in (patch_text or "").splitlines():
        m = DIFF_GIT_RE.match(line)
        if m:
            files.add(m.group(1))
            files.add(m.group(2))
    return files


def filter_patch(raw: str, prefixes: list[str], exact: set[str] | None = None) -> tuple[str, list[str], list[str]]:
    kept_blocks: list[str] = []
    kept_files: list[str] = []
    dropped_files: list[str] = []
    current_files: list[str] = []
    current_lines: list[str] = []

    def flush() -> None:
        nonlocal current_files, current_lines
        if not current_lines:
            return
        keep = any(not path_excluded(p, prefixes, exact) for p in current_files)
        if keep:
            kept_blocks.append("".join(current_lines))
            kept_files.extend(sorted(set(current_files)))
        else:
            dropped_files.extend(sorted(set(current_files)))
        current_files = []
        current_lines = []

    for line in raw.splitlines(keepends=True):
        m = DIFF_GIT_RE.match(line)
        if m:
            flush()
            current_files = [m.group(1), m.group(2)]
        current_lines.append(line)
    flush()
    patch = "".join(kept_blocks)
    if patch and not patch.endswith("\n"):
        patch += "\n"
    return patch, sorted(set(kept_files)), sorted(set(dropped_files))


def dirty_snapshot(work_dir: Path) -> dict[str, str]:
    """{path: content hash} for every modified or untracked (non-ignored) file.

    Read-only: it must not stage anything, or the agent would see it in `git status`.
    """
    status = run_command(["git", "-C", str(work_dir), "status", "--porcelain", "--untracked-files=all"], cwd=work_dir)
    snapshot: dict[str, str] = {}
    for line in status.stdout.splitlines():
        if len(line) < 4:
            continue
        path = line[3:].strip().strip('"')
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        target = work_dir / path
        if target.is_file():
            try:
                snapshot[_norm(path)] = hashlib.sha256(target.read_bytes()).hexdigest()
            except OSError:
                continue
    return snapshot


def stash_list(work_dir: Path) -> list[str]:
    result = run_command(["git", "-C", str(work_dir), "stash", "list"], cwd=work_dir)
    return [line for line in result.stdout.splitlines() if line.strip()]


def pop_stash(work_dir: Path) -> bool:
    """Restore stashed work: protocol v2 gives the agent no rules, so it may stash its change."""
    result = run_command(["git", "-C", str(work_dir), "stash", "pop"], cwd=work_dir)
    return result.returncode == 0


def working_tree_diff(work_dir: Path, from_commit: str) -> str:
    run_command(["git", "-C", str(work_dir), "add", "-A", "--intent-to-add"], check=False)
    result = run_command(["git", "-C", str(work_dir), "diff", "--binary", from_commit], cwd=work_dir)
    if result.returncode != 0:
        raise RuntimeError(f"git diff failed: {result.stderr or result.stdout}")
    return result.stdout


def commit_range_diff(repo_dir: Path, from_commit: str, ref: str) -> str:
    """Diff a session branch: used when the agent committed and its worktree is gone."""
    result = run_command(["git", "-C", str(repo_dir), "diff", "--binary", from_commit, ref], cwd=repo_dir)
    if result.returncode != 0:
        raise RuntimeError(f"git diff {from_commit}..{ref} failed: {result.stderr or result.stdout}")
    return result.stdout


def build_model_patch(
    raw_diff: str,
    *,
    hidden_test_patch: str | None = None,
    launch_side_effects: dict[str, str] | None = None,
    agent_edited: set[str] | None = None,
    work_dir: Path | None = None,
    exclude_tests: bool = True,
    exclude_orphan_lockfiles: bool = True,
) -> dict:
    """Filter a raw diff into the graded patch and report what was dropped and why."""
    exact = set(files_in_patch(hidden_test_patch))
    edited = {_norm(p) for p in (agent_edited or set())}
    side_effects: list[str] = []
    for path, digest in (launch_side_effects or {}).items():
        path = _norm(path)
        if path in edited:
            continue  # the agent worked on this file itself
        target = (work_dir / path) if work_dir else None
        unchanged = bool(target and target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == digest)
        exact.add(path)
        side_effects.append(path + ("" if unchanged else " (changed by the environment)"))
    in_diff = files_in_patch(raw_diff)
    test_paths: list[str] = []
    if exclude_tests:
        for path in in_diff:
            if is_test_path(path):
                exact.add(_norm(path))
                test_paths.append(_norm(path))
    lockfiles = sorted(orphan_lockfiles(in_diff)) if exclude_orphan_lockfiles else []
    exact.update(lockfiles)
    patch, kept, dropped = filter_patch(raw_diff, exclude_prefixes(), exact)
    return {
        "patch": patch,
        "files": kept,
        "dropped_files": dropped,
        "launch_side_effect_files": sorted(side_effects),
        "test_paths_excluded": sorted(set(test_paths)),
        "orphan_lockfiles_excluded": lockfiles,
        "empty": not patch.strip(),
    }


def extract_model_patch(
    work_dir: Path,
    from_commit: str,
    *,
    hidden_test_patch: str | None = None,
    launch_side_effects: dict[str, str] | None = None,
    agent_edited: set[str] | None = None,
) -> dict:
    """Working-tree patch, recovering stashed work if the tree looks empty."""
    raw = working_tree_diff(work_dir, from_commit)
    recovered = False
    if not raw.strip() and stash_list(work_dir):
        recovered = pop_stash(work_dir)
        if recovered:
            raw = working_tree_diff(work_dir, from_commit)
    out = build_model_patch(
        raw,
        hidden_test_patch=hidden_test_patch,
        launch_side_effects=launch_side_effects,
        agent_edited=agent_edited,
        work_dir=work_dir,
    )
    out["stash_recovered"] = recovered
    out["raw_diff"] = raw
    return out
