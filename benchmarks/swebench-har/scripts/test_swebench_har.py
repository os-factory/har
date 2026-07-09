#!/usr/bin/env python3
"""Smoke tests for the SWE-bench HAR benchmark (no Codex / Docker required)."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from lib.common import benchmark_config, render_template, sanitize_instance_row  # noqa: E402
from lib.har_cache import har_cache_exists, invalidate_har_cache, load_har_cache, save_har_cache  # noqa: E402
from lib.har_utils import (  # noqa: E402
    build_init_adapt_prompt,
    har_validate_launch,
    har_validate_ready,
    har_validate_smoke,
    read_har_adapt_prompt,
)
from lib.patch import extract_model_patch, filter_changed_files  # noqa: E402
from lib.profile import infer_har_profile  # noqa: E402


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=False)


def test_config_loads() -> None:
    cfg = benchmark_config()
    assert cfg["dataset_name"] == "SWE-bench/SWE-bench_Lite"
    assert cfg["model"] == "gpt-5-mini"
    assert cfg["setup_model"] == "gpt-5.5"
    assert cfg["setup_budget_minutes"] == 120
    assert cfg["setup_max_rounds"] == 6
    assert cfg["readiness_timeout_minutes"] == 20


def test_har_cache_roundtrip() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        harness_root = tmp_path / "repo"
        harness_root.mkdir()
        har_dir = harness_root / ".har"
        har_dir.mkdir()
        (har_dir / "launch.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        (har_dir / "verify.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        (har_dir / "slots").mkdir()
        (har_dir / "slots" / "agent-1.json").write_text("{}", encoding="utf-8")

        import lib.har_cache as har_cache

        original_cache_root = har_cache.cache_root
        try:
            har_cache.cache_root = lambda: tmp_path / "har-cache"  # type: ignore[method-assign]
            repo_slug = "test/cache-repo"
            save_har_cache(repo_slug, harness_root, "cli")
            assert har_cache_exists(repo_slug, "cli")
            assert not (tmp_path / "har-cache" / "test-cache-repo" / ".har" / "slots").exists()

            dest = tmp_path / "dest"
            dest.mkdir()
            assert load_har_cache(repo_slug, dest)
            assert (dest / ".har" / "launch.sh").exists()
            assert not (dest / ".har" / "slots").exists()
        finally:
            har_cache.cache_root = original_cache_root  # type: ignore[method-assign]


def test_har_cache_invalidate() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        harness_root = tmp_path / "repo"
        harness_root.mkdir()
        har_dir = harness_root / ".har"
        har_dir.mkdir()
        (har_dir / "launch.sh").write_text("#!/bin/sh\n", encoding="utf-8")

        import lib.har_cache as har_cache

        original_cache_root = har_cache.cache_root
        try:
            har_cache.cache_root = lambda: tmp_path / "har-cache"  # type: ignore[method-assign]
            repo_slug = "test/invalidate-repo"
            save_har_cache(repo_slug, harness_root, "cli")
            assert har_cache_exists(repo_slug, "cli")
            assert invalidate_har_cache(repo_slug)
            assert not har_cache_exists(repo_slug, "cli")
        finally:
            har_cache.cache_root = original_cache_root  # type: ignore[method-assign]


def test_task_readiness_prompt_render() -> None:
    text = render_template(
        ROOT / "prompts" / "har-task-readiness.md",
        {
            "repo": "django/django",
            "instance_id": "django__django-11099",
            "base_commit": "abc123",
            "har_profile": "cli",
            "problem_statement": "Fix URL validator edge case",
            "task_overlay_dir": "/tmp/task-overlay",
            "readiness_failure_context": "",
        },
    )
    assert "Fix URL validator edge case" in text
    assert "task-overlay" in text
    assert "Do **not** edit `launch.sh`" in text
    assert "{{" not in text


def test_sanitize_instance() -> None:
    row = {
        "instance_id": "foo__bar-1",
        "repo": "foo/bar",
        "base_commit": "abc",
        "problem_statement": "fix it",
        "patch": "secret",
        "test_patch": "secret",
        "FAIL_TO_PASS": "[]",
    }
    safe = sanitize_instance_row(row)
    assert "patch" not in safe
    assert "test_patch" not in safe
    assert safe["problem_statement"] == "fix it"


def test_profile_inference() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        (repo / "pyproject.toml").write_text("[project]\nname='x'\n", encoding="utf-8")
        assert infer_har_profile(repo) == "cli"
        (repo / "next.config.js").write_text("module.exports = {}", encoding="utf-8")
        assert infer_har_profile(repo) == "default"


def test_patch_filtering() -> None:
    files = [".har/verify.sh", "src/fix.py", "AGENT.md", "lib/a.py"]
    kept = filter_changed_files(files)
    assert set(kept) == {"src/fix.py", "lib/a.py"}


def test_patch_extraction_excludes_har() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "a@b.c"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.name", "bench"], cwd=repo, check=True)
        (repo / "README.md").write_text("base\n", encoding="utf-8")
        subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True)
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
        ).stdout.strip()
        (repo / "src.py").write_text("print(1)\n", encoding="utf-8")
        (repo / ".har").mkdir()
        (repo / ".har" / "verify.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-m", "changes"], cwd=repo, check=True)
        patch = extract_model_patch(repo, base)
        assert "src.py" in patch
        assert ".har/verify.sh" not in patch
        assert "har/verify.sh" not in patch


def test_prompt_render() -> None:
    text = render_template(
        ROOT / "prompts" / "raw-fix.md",
        {
            "repo": "foo/bar",
            "instance_id": "foo__bar-1",
            "base_commit": "abc",
            "problem_statement": "broken",
        },
    )
    assert "foo/bar" in text
    assert "broken" in text
    assert "{{" not in text

    setup = render_template(
        ROOT / "prompts" / "har-setup.md",
        {
            "repo": "foo/bar",
            "instance_id": "foo__bar-1",
            "har_profile": "cli",
            "har_adapt_prompt": build_init_adapt_prompt("cli"),
            "setup_failure_context": "",
        },
    )
    assert "Do **not** run `har env launch`" in setup
    assert "Do not edit" in setup and "launch.sh" in setup
    assert "Generic HAR adaptation prompt" in setup
    assert "Adapt the `.har/` harness" in setup
    assert "smoke-only" in setup


def test_read_har_adapt_prompt_prefers_file() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        harness_root = Path(tmp) / "repo"
        har_dir = harness_root / ".har"
        har_dir.mkdir(parents=True)
        (har_dir / "ADAPT-PROMPT.md").write_text("custom adapt prompt\n", encoding="utf-8")
        assert read_har_adapt_prompt(harness_root, "cli") == "custom adapt prompt"


def test_build_init_adapt_prompt_fills_profile() -> None:
    prompt = build_init_adapt_prompt("cli")
    assert "## Profile: cli" in prompt
    assert "CLI/library profile" in prompt
    assert "{{PROFILE}}" not in prompt


def test_har_validate_helpers_exported() -> None:
    assert callable(har_validate_launch)
    assert callable(har_validate_smoke)
    assert callable(har_validate_ready)


def test_har_validate_ready_shape() -> None:
    """Gate result exposes split launch/smoke without calling HAR CLI."""
    import inspect

    source = inspect.getsource(har_validate_ready)
    assert "har_validate_launch" in source
    assert "har_validate_smoke" in source
    assert '"launch"' in source
    assert '"smoke"' in source


def test_dry_run_orchestration() -> None:
    result = run([sys.executable, str(SCRIPTS / "run_one.py"), "--seed", "7", "--dry-run"])
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout.strip())
    run_dir = Path(payload["run_dir"])
    assert (run_dir / "instance.json").exists()
    assert (run_dir / "run.json").exists()


def test_evaluate_dry_run() -> None:
    run([sys.executable, str(SCRIPTS / "run_one.py"), "--seed", "8", "--dry-run"])
    result = run([sys.executable, str(SCRIPTS / "evaluate_predictions.py"), "--latest", "--dry-run"])
    assert result.returncode == 0, result.stderr


def main() -> int:
    tests = [
        test_config_loads,
        test_har_cache_roundtrip,
        test_har_cache_invalidate,
        test_task_readiness_prompt_render,
        test_sanitize_instance,
        test_profile_inference,
        test_patch_filtering,
        test_patch_extraction_excludes_har,
        test_prompt_render,
        test_read_har_adapt_prompt_prefers_file,
        test_build_init_adapt_prompt_fills_profile,
        test_har_validate_helpers_exported,
        test_har_validate_ready_shape,
        test_dry_run_orchestration,
        test_evaluate_dry_run,
    ]
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    print(f"All {len(tests)} smoke tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
