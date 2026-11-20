"""Per-repository cache of the adapted harness (file snapshot + adaptation history)."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from .common import BENCHMARK_ROOT, benchmark_config, now_iso, read_json, repo_slug, run_command, write_json
from .har_utils import HAR_EPHEMERAL_SUBDIRS

HARNESS_OWNED_PREFIXES = (".har/", ".claude/", ".cursor/", ".codex/")
HARNESS_OWNED_FILES = ("AGENTS.md", "CLAUDE.md", ".gitignore", ".har-mcp-setup.json")


def cache_dir(repo: str) -> Path:
    cfg = benchmark_config()
    return BENCHMARK_ROOT / cfg.get("har_cache_dir", ".har-cache") / repo_slug(repo)


def cache_meta(repo: str) -> dict[str, Any] | None:
    path = cache_dir(repo) / "meta.json"
    return read_json(path) if path.exists() else None


def cache_exists(repo: str) -> bool:
    return (cache_dir(repo) / "files" / ".har" / "harness.env").exists()


def _is_ephemeral(rel: str) -> bool:
    parts = rel.split("/")
    return len(parts) >= 2 and parts[0] == ".har" and parts[1] in HAR_EPHEMERAL_SUBDIRS


def is_harness_owned(rel: str) -> bool:
    rel = rel.replace("\\", "/")
    while rel.startswith("./"):
        rel = rel[2:]
    return rel in HARNESS_OWNED_FILES or any(rel.startswith(p) for p in HARNESS_OWNED_PREFIXES)


def changed_paths(repo_dir: Path, base_commit: str) -> list[str]:
    """Paths (tracked + untracked, respecting .gitignore) that differ from base_commit."""
    run_command(["git", "-C", str(repo_dir), "add", "-A", "--intent-to-add"], check=False)
    result = run_command(["git", "-C", str(repo_dir), "diff", "--name-only", base_commit], check=True)
    paths = [p.strip() for p in result.stdout.splitlines() if p.strip()]
    return [p for p in paths if not _is_ephemeral(p)]


def split_paths(paths: list[str]) -> tuple[list[str], list[str]]:
    owned = [p for p in paths if is_harness_owned(p)]
    foreign = [p for p in paths if not is_harness_owned(p)]
    return owned, foreign


def save_cache(
    repo: str,
    repo_dir: Path,
    base_commit: str,
    *,
    instance_id: str,
    profile: str | None,
    event: dict[str, Any],
) -> dict[str, Any]:
    owned, foreign = split_paths(changed_paths(repo_dir, base_commit))
    dest = cache_dir(repo)
    files = dest / "files"
    if files.exists():
        shutil.rmtree(files)
    for rel in owned:
        src = repo_dir / rel
        if not src.exists() or src.is_dir():
            continue
        target = files / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
    meta = cache_meta(repo) or {"repo": repo, "history": []}
    meta.update(
        {
            "profile": profile,
            "updated_at": now_iso(),
            "base_commit": base_commit,
            "instance_id": instance_id,
            "files": owned,
            "foreign_files_at_save": foreign,
        }
    )
    meta["history"].append({"at": now_iso(), "base_commit": base_commit, "instance_id": instance_id, **event})
    write_json(dest / "meta.json", meta)
    return meta


def apply_cache(repo: str, repo_dir: Path) -> list[str]:
    """Copy cached harness files onto a fresh checkout. .gitignore lines are merged, not replaced."""
    files = cache_dir(repo) / "files"
    applied: list[str] = []
    for path in sorted(p for p in files.rglob("*") if p.is_file()):
        rel = str(path.relative_to(files))
        target = repo_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if rel == ".gitignore" and target.exists():
            existing = target.read_text(encoding="utf-8", errors="replace").splitlines()
            cached = path.read_text(encoding="utf-8", errors="replace").splitlines()
            missing = [line for line in cached if line not in existing]
            if missing:
                target.write_text("\n".join(existing + missing) + "\n", encoding="utf-8")
        else:
            shutil.copy2(path, target)
        applied.append(rel)
    return applied


def commit_harness(repo_dir: Path, message: str = "chore: development environment setup") -> str | None:
    """Commit the harness. The message is visible to the solving agent in `git log`, so it
    must not mention the benchmark or HAR."""
    run_command(["git", "-C", str(repo_dir), "add", "-A"], check=True)
    status = run_command(["git", "-C", str(repo_dir), "status", "--porcelain"])
    if status.stdout.strip():
        run_command(["git", "-C", str(repo_dir), "commit", "--quiet", "-m", message], check=True)
    head = run_command(["git", "-C", str(repo_dir), "rev-parse", "HEAD"])
    return head.stdout.strip() or None
