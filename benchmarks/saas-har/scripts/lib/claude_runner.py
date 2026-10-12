"""Headless Claude Code runner with a full stream-json transcript per session."""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import time
from pathlib import Path
from typing import Any, Callable

from .common import ensure_dir, load_benchmark_env, now_iso

USAGE_LIMIT_RE = re.compile(r"(usage|session|rate)[\s-]*limit|limit\s*·\s*resets|\b429\b", re.IGNORECASE)


def is_usage_limited(session: dict[str, Any]) -> bool:
    """True when the session returned immediately because the plan's usage cap was hit."""
    result = session.get("result") or {}
    text = f"{result.get('final_text') or ''}\n{session.get('stderr_tail') or ''}"
    if not result.get("is_error") and session.get("exit_code") == 0:
        return False
    return bool(USAGE_LIMIT_RE.search(text)) and (session.get("tool_calls") or 0) == 0


def run_claude_with_retry(
    *,
    max_retries: int = 0,
    wait_seconds: int = 1200,
    on_wait: Callable[[int, int], None] | None = None,
    label: str = "session",
    **kwargs: Any,
) -> dict[str, Any]:
    """run_claude, but wait and retry while the plan's usage cap is blocking the session.

    Needed for unattended runs: a capped plan answers in one turn with is_error, which would
    otherwise silently turn into an unresolved instance.
    """
    attempts: list[dict[str, Any]] = []
    for attempt in range(1, max_retries + 2):
        this_label = label if attempt == 1 else f"{label}-retry{attempt - 1}"
        session = run_claude(label=this_label, **kwargs)
        if not is_usage_limited(session):
            if attempts:
                session["usage_limit_retries"] = len(attempts)
                session["usage_limit_attempts"] = attempts
            return session
        attempts.append({"label": this_label, "at": session.get("finished_at"), "text": ((session.get("result") or {}).get("final_text") or "")[:200]})
        if attempt > max_retries:
            session["usage_limited"] = True
            session["usage_limit_retries"] = len(attempts)
            session["usage_limit_attempts"] = attempts
            return session
        if on_wait:
            on_wait(attempt, wait_seconds)
        time.sleep(wait_seconds)
    raise AssertionError("unreachable")


def run_claude(
    *,
    cwd: Path,
    prompt: str,
    model: str,
    timeout_seconds: int,
    log_dir: Path,
    add_dirs: list[Path] | None = None,
    disallowed_tools: list[str] | None = None,
    env: dict[str, str] | None = None,
    label: str = "session",
) -> dict[str, Any]:
    """Run `claude -p` non-interactively and return metrics parsed from the final `result` event."""
    ensure_dir(log_dir)
    prompt_path = log_dir / f"{label}.prompt.md"
    prompt_path.write_text(prompt, encoding="utf-8")
    transcript_path = log_dir / f"{label}.stream.jsonl"
    stderr_path = log_dir / f"{label}.stderr.log"

    cmd = [
        "claude",
        "-p",
        "--model",
        model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--no-session-persistence",
    ]
    for d in add_dirs or []:
        cmd += ["--add-dir", str(d)]
    if disallowed_tools:
        cmd += ["--disallowedTools", *disallowed_tools]

    run_env = dict(env or load_benchmark_env())
    started = time.time()
    started_iso = now_iso()
    timed_out = False
    with transcript_path.open("w", encoding="utf-8") as out, stderr_path.open("w", encoding="utf-8") as err:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            env=run_env,
            stdin=subprocess.PIPE,
            stdout=out,
            stderr=err,
            text=True,
            start_new_session=True,
        )
        try:
            assert proc.stdin is not None
            proc.stdin.write(prompt)
            proc.stdin.close()
        except BrokenPipeError:
            pass
        try:
            proc.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
            _stop(proc)
    wall = round(time.time() - started, 2)

    summary = summarize_transcript(transcript_path)
    summary.update(
        {
            "label": label,
            "model": model,
            "cwd": str(cwd),
            "command": cmd,
            "exit_code": proc.returncode,
            "timed_out": timed_out,
            "timeout_seconds": timeout_seconds,
            "started_at": started_iso,
            "finished_at": now_iso(),
            "wall_clock_seconds": wall,
            "transcript_path": str(transcript_path),
            "prompt_path": str(prompt_path),
            "stderr_tail": stderr_path.read_text(encoding="utf-8", errors="replace")[-3000:],
        }
    )
    return summary


def _stop(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()


def summarize_transcript(transcript_path: Path) -> dict[str, Any]:
    """Parse the stream-json transcript: final result metrics + tool-call statistics."""
    result_event: dict[str, Any] | None = None
    tool_calls = 0
    tool_names: dict[str, int] = {}
    bash_commands: list[str] = []
    har_commands = 0
    assistant_messages = 0
    if not transcript_path.exists():
        return {"result": None, "tool_calls": 0}
    for line in transcript_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        etype = event.get("type")
        if etype == "result":
            result_event = event
        elif etype == "assistant":
            assistant_messages += 1
            message = event.get("message") or {}
            for block in message.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    tool_calls += 1
                    name = block.get("name", "?")
                    tool_names[name] = tool_names.get(name, 0) + 1
                    if name == "Bash":
                        command = str((block.get("input") or {}).get("command", ""))
                        bash_commands.append(command)
                        stripped = command.strip()
                        if "har env" in command or stripped.startswith("har ") or " har " in command or "har_" in command:
                            har_commands += 1
    out: dict[str, Any] = {
        "result": None,
        "tool_calls": tool_calls,
        "tool_names": tool_names,
        "assistant_messages": assistant_messages,
        "bash_commands": len(bash_commands),
        "har_commands": har_commands,
        "bash_commands_sample": bash_commands[:400],
    }
    if result_event:
        usage = result_event.get("usage") or {}
        text = result_event.get("result")
        out["result"] = {
            "subtype": result_event.get("subtype"),
            "is_error": result_event.get("is_error"),
            "num_turns": result_event.get("num_turns"),
            "duration_ms": result_event.get("duration_ms"),
            "duration_api_ms": result_event.get("duration_api_ms"),
            "total_cost_usd": result_event.get("total_cost_usd"),
            "stop_reason": result_event.get("stop_reason"),
            "terminal_reason": result_event.get("terminal_reason"),
            "session_id": result_event.get("session_id"),
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
            "cache_creation_input_tokens": usage.get("cache_creation_input_tokens"),
            "model_usage": result_event.get("modelUsage"),
            "final_text": text[-6000:] if isinstance(text, str) else None,
        }
    return out
