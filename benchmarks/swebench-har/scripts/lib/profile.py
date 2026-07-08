"""Infer HAR init profile from repository signals."""

from __future__ import annotations

from pathlib import Path


def _exists_any(repo_path: Path, relative_paths: tuple[str, ...]) -> bool:
    return any((repo_path / rel).exists() for rel in relative_paths)


def infer_har_profile(repo_path: Path) -> str:
    """Return `cli` for library/test-suite repos, `default` for web-app repos."""
    if _exists_any(
        repo_path,
        (
            "next.config.js",
            "next.config.mjs",
            "next.config.ts",
            "vite.config.ts",
            "vite.config.js",
            "nuxt.config.ts",
            "angular.json",
            "apps/web/package.json",
            "packages/frontend/package.json",
        ),
    ):
        return "default"

    if _exists_any(
        repo_path,
        (
            "pyproject.toml",
            "setup.py",
            "setup.cfg",
            "tox.ini",
            "pytest.ini",
            "requirements.txt",
        ),
    ):
        return "cli"

    if (repo_path / "package.json").exists():
        return "default"

    return "cli"
