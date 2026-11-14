"""Protocol guards: prompt neutrality, task-blind adaptation, patch filtering, behaviour classification."""

from __future__ import annotations

import json
from pathlib import Path

from lib.behaviors import classify
from lib.common import PROMPTS_DIR, render_template
from lib.har_cache import is_harness_owned, split_paths
from lib.patch import build_model_patch, files_in_patch, filter_patch
from run_instance import task_prompt

INSTANCE = {
    "repo": "o/r",
    "base_commit": "abc123",
    "problem_statement": "Return 404 when the id does not exist.",
    "hidden": {},
}

# Phrases that would import our workflow into the agent's head. The minimal prompt must have none.
# ("commit" alone is allowed: the prompt names the base commit.)
FORBIDDEN = ("har ", "verify", "install", " test", "launch", "docker", "git commit", "stash", "benchmark", "harness", "ground rule")


def test_task_prompt_is_minimal_and_neutral():
    prompt = task_prompt(INSTANCE, assets="", variant="minimal")
    body = prompt.replace(INSTANCE["problem_statement"], "")
    lowered = body.lower()
    for word in FORBIDDEN:
        assert word not in lowered, f"minimal prompt mentions {word!r}: {body!r}"
    assert "{{" not in prompt
    assert INSTANCE["problem_statement"] in prompt
    assert INSTANCE["repo"] in prompt and INSTANCE["base_commit"] in prompt


def test_prompt_does_not_depend_on_arm():
    """There is one prompt builder and no arm argument: both arms get identical bytes."""
    assert task_prompt(INSTANCE, assets="", variant="minimal") == task_prompt(INSTANCE, assets="", variant="minimal")
    ablation = task_prompt(INSTANCE, assets="", variant="verify")
    assert ablation != task_prompt(INSTANCE, assets="", variant="minimal")
    assert "verify" in ablation.lower()


def test_no_environment_note_prompts_remain():
    assert not (PROMPTS_DIR / "env-har.md").exists()
    assert not (PROMPTS_DIR / "env-raw.md").exists()


def test_adaptation_prompts_are_task_blind():
    for name in ("har-adapt.md", "har-drift.md"):
        text = (PROMPTS_DIR / name).read_text(encoding="utf-8")
        assert "{{problem_statement}}" not in text
        assert "{{instance_id}}" not in text
        assert "not told" in text


def test_filter_patch_drops_harness_and_hidden_test_files():
    raw = (
        "diff --git a/.har/harness.env b/.har/harness.env\n--- a/.har/harness.env\n+++ b/.har/harness.env\n@@ -1 +1 @@\n-a\n+b\n"
        "diff --git a/src/app.py b/src/app.py\n--- a/src/app.py\n+++ b/src/app.py\n@@ -1 +1 @@\n-x\n+y\n"
        "diff --git a/tests/test_app.py b/tests/test_app.py\n--- a/tests/test_app.py\n+++ b/tests/test_app.py\n@@ -1 +1 @@\n-t\n+u\n"
        "diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-m\n+n\n"
    )
    hidden = "diff --git a/tests/test_app.py b/tests/test_app.py\n"
    patch, kept, dropped = filter_patch(raw, [".har/", "AGENTS.md"], files_in_patch(hidden))
    assert kept == ["src/app.py"]
    assert set(dropped) == {".har/harness.env", "tests/test_app.py", "AGENTS.md"}


def test_launch_side_effects_dropped_unless_the_agent_edited_them():
    """Files the readiness gate saw launch dirty are noise — unless the agent worked on them."""
    raw = (
        "diff --git a/lib/x.js b/lib/x.js\n--- a/lib/x.js\n+++ b/lib/x.js\n@@ -1 +1 @@\n-a\n+b\n"
        "diff --git a/src/routeTree.gen.ts b/src/routeTree.gen.ts\n--- a/src/routeTree.gen.ts\n+++ b/src/routeTree.gen.ts\n@@ -1 +1 @@\n-1\n+2\n"
        "diff --git a/src/schema.ts b/src/schema.ts\n--- a/src/schema.ts\n+++ b/src/schema.ts\n@@ -1 +1 @@\n-1\n+2\n"
    )
    side_effects = {"src/routeTree.gen.ts": "hash-from-gate", "src/schema.ts": "hash-from-gate"}
    out = build_model_patch(raw, launch_side_effects=side_effects, agent_edited={"src/schema.ts"})
    assert out["files"] == ["lib/x.js", "src/schema.ts"]
    assert out["dropped_files"] == ["src/routeTree.gen.ts"]
    assert any(p.startswith("src/routeTree.gen.ts") for p in out["launch_side_effect_files"])


def test_orphan_lockfiles_dropped_in_every_arm():
    """An install's lockfile churn is environment noise unless the manifest changed too."""
    npm = (
        "diff --git a/lib/x.js b/lib/x.js\n--- a/lib/x.js\n+++ b/lib/x.js\n@@ -1 +1 @@\n-a\n+b\n"
        "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-1\n+2\n"
    )
    out = build_model_patch(npm)
    assert out["files"] == ["lib/x.js"]
    assert out["orphan_lockfiles_excluded"] == ["package-lock.json"]

    deps = (
        "diff --git a/backend/pyproject.toml b/backend/pyproject.toml\n--- a/backend/pyproject.toml\n+++ b/backend/pyproject.toml\n@@ -1 +1 @@\n-a\n+b\n"
        "diff --git a/uv.lock b/uv.lock\n--- a/uv.lock\n+++ b/uv.lock\n@@ -1 +1 @@\n-1\n+2\n"
    )
    kept = build_model_patch(deps)
    assert kept["orphan_lockfiles_excluded"] == []
    assert "uv.lock" in kept["files"]


def test_harness_ownership_split():
    owned, foreign = split_paths([".har/stages.json", "AGENTS.md", "CLAUDE.md", ".claude/skills/x/SKILL.md", ".gitignore", "backend/app/main.py"])
    assert foreign == ["backend/app/main.py"]
    assert len(owned) == 5
    assert is_harness_owned(".har/plugins/db-integrity/stages/x.sh")
    assert not is_harness_owned("pyproject.toml")


def _transcript(tmp_path: Path, commands: list[str], edits: list[str]) -> Path:
    blocks = [{"type": "tool_use", "name": "Bash", "input": {"command": c}} for c in commands]
    blocks += [{"type": "tool_use", "name": "Edit", "input": {"file_path": e}} for e in edits]
    path = tmp_path / "t.jsonl"
    path.write_text(json.dumps({"type": "assistant", "message": {"content": blocks}}) + "\n", encoding="utf-8")
    return path


def test_behaviour_classification(tmp_path):
    t = _transcript(
        tmp_path,
        [
            "cd /w && har env launch 1",
            "har env verify 1 --full 2>&1 | tail -40",
            "docker run -d --name pg postgres:17",
            "uv run pytest tests/ -q",
            "git commit -m wip",
        ],
        ["/w/app/main.py", "/w/tests/test_main.py"],
    )
    b = classify(t, work_dir=Path("/w"))
    assert b["har_launch"] and b["har_verify"] and b["har_verify_full"] and b["har_commands"] >= 2
    assert b["started_services"] and b["ran_tests"] and b["verified_anything"] and b["committed"]
    assert b["files_edited"] == ["app/main.py", "tests/test_main.py"]
    assert b["test_files_edited"] == ["tests/test_main.py"]


def test_behaviour_classification_raw_arm(tmp_path):
    t = _transcript(tmp_path, ["npm install", "npm test"], ["/w/lib/x.js"])
    b = classify(t, work_dir=Path("/w"))
    assert not b["har_any"] and not b["har_launch"]
    assert b["installed_deps"] and b["ran_tests"] and not b["committed"]
