"""Thin wrapper around the OpenAI Codex Python SDK."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from openai_codex import ApprovalMode, Codex, Sandbox

from .har_utils import serialize_turn_result


@dataclass
class CodexRunRecord:
    prompt: str
    cwd: Path
    model: str
    result: dict[str, Any]
    wall_clock_seconds: float


def run_codex_turn(
    *,
    cwd: Path,
    prompt: str,
    model: str,
    api_key: str | None,
    timeout_seconds: int | None = None,
    artifacts_dir: Path | None = None,
) -> CodexRunRecord:
    import time

    started = time.time()
    cwd = cwd.resolve()
    artifacts_dir = artifacts_dir or (cwd / ".benchmark-codex")
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    (artifacts_dir / "prompt.md").write_text(prompt, encoding="utf-8")

    with Codex() as codex:
        if api_key:
            codex.login_api_key(api_key)
        thread = codex.thread_start(
            cwd=str(cwd),
            model=model,
            sandbox=Sandbox.workspace_write,
            approval_mode=ApprovalMode.auto_review,
        )
        turn_kwargs: dict[str, Any] = {
            "cwd": str(cwd),
            "sandbox": Sandbox.workspace_write,
            "model": model,
        }
        if timeout_seconds is not None:
            turn_kwargs["config"] = {"turn_timeout_ms": timeout_seconds * 1000}

        result = thread.run(prompt, **turn_kwargs)

    record = serialize_turn_result(result)
    (artifacts_dir / "turn-result.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")

    return CodexRunRecord(
        prompt=prompt,
        cwd=cwd,
        model=model,
        result=record,
        wall_clock_seconds=round(time.time() - started, 2),
    )
