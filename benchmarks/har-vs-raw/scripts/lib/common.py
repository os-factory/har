"""Shared utilities for the HAR vs raw benchmark."""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

BENCHMARK_ROOT = Path(__file__).resolve().parents[2]
HAR_PROJECT_ROOT = BENCHMARK_ROOT.parents[1]
NODE_MODULES = HAR_PROJECT_ROOT / "node_modules"


def load_yaml(path: Path) -> Any:
    """Load YAML via the repo's js-yaml dependency."""
    script = """
const yaml = require('js-yaml');
const fs = require('fs');
const target = process.argv[1];
console.log(JSON.stringify(yaml.load(fs.readFileSync(target, 'utf8'))));
"""
    result = subprocess.run(
        ["node", "-e", script, str(path)],
        cwd=HAR_PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to load YAML {path}: {result.stderr.strip()}")
    return json.loads(result.stdout)


def dump_yaml(path: Path, data: Any) -> None:
    script = """
const yaml = require('js-yaml');
const fs = require('fs');
const target = process.argv[1];
fs.writeFileSync(target, yaml.dump(JSON.parse(process.argv[2]), { lineWidth: 120 }));
"""
    subprocess.run(
        ["node", "-e", script, str(path), json.dumps(data)],
        cwd=HAR_PROJECT_ROOT,
        check=True,
    )


def load_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def merge_env(*sources: dict[str, str]) -> dict[str, str]:
    merged: dict[str, str] = {}
    for source in sources:
        merged.update(source)
    return merged


def github_request(path: str, token: str | None = None) -> Any:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "har-vs-raw-benchmark",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"https://api.github.com{path}", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API error {exc.code} for {path}: {body}") from exc


def github_search_issues(owner: str, repo: str, query: str, token: str | None = None) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode(
        {
            "q": f"repo:{owner}/{repo} is:issue is:closed {query}",
            "sort": "updated",
            "order": "desc",
            "per_page": "30",
        }
    )
    data = github_request(f"/search/issues?{params}", token=token)
    return data.get("items", [])


def github_issue_timeline(owner: str, repo: str, issue_number: int, token: str | None = None) -> list[dict[str, Any]]:
    return github_request(f"/repos/{owner}/{repo}/issues/{issue_number}/timeline", token=token)


def github_pull(owner: str, repo: str, pull_number: int, token: str | None = None) -> dict[str, Any]:
    return github_request(f"/repos/{owner}/{repo}/pulls/{pull_number}", token=token)


def github_pull_files(owner: str, repo: str, pull_number: int, token: str | None = None) -> list[str]:
    files = github_request(f"/repos/{owner}/{repo}/pulls/{pull_number}/files?per_page=100", token=token)
    return [item.get("filename", "") for item in files if item.get("filename")]


def github_compare(owner: str, repo: str, base: str, head: str, token: str | None = None) -> dict[str, Any]:
    return github_request(f"/repos/{owner}/{repo}/compare/{base}...{head}", token=token)


def find_closing_pull(owner: str, repo: str, issue_number: int, token: str | None = None) -> dict[str, Any] | None:
    timeline = github_issue_timeline(owner, repo, issue_number, token=token)
    for event in timeline:
        if event.get("event") != "cross-referenced":
            continue
        source = event.get("source") or {}
        issue = source.get("issue") or {}
        if not issue.get("pull_request"):
            continue
        pull_number = issue.get("number")
        if not pull_number:
            continue
        pull = github_pull(owner, repo, pull_number, token=token)
        if pull.get("merged_at"):
            return pull
    return None


def base_commit_before_merge(owner: str, repo: str, pull: dict[str, Any], token: str | None = None) -> str | None:
    base_branch = pull.get("base", {}).get("ref")
    merge_commit = pull.get("merge_commit_sha")
    if not base_branch or not merge_commit:
        return None
    compare = github_compare(owner, repo, base_branch, merge_commit, token=token)
    if compare.get("status") == "identical":
        return merge_commit
    commits = compare.get("commits") or []
    if not commits:
        return pull.get("base", {}).get("sha")
    return commits[0].get("parents", [{}])[0].get("sha") or commits[0].get("sha")


def is_frontend_issue(issue: dict[str, Any]) -> bool:
    text = " ".join(
        [
            issue.get("title") or "",
            issue.get("body") or "",
            " ".join(label.get("name", "") for label in issue.get("labels", [])),
        ]
    ).lower()
    frontend_terms = (
        "frontend",
        "ui",
        "ux",
        "browser",
        "react",
        "vue",
        "css",
        "dashboard",
        "web",
        "page",
        "modal",
        "button",
        "toggle",
        "chart",
        "table",
        "routing",
        "blank page",
        "render",
        "playwright",
        "e2e",
    )
    backend_only = (
        "migration",
        "database",
        "postgres",
        "redis",
        "infra",
        "docker",
        "kubernetes",
        "backend-only",
        "api-only",
        "s3",
        "irsa",
        "duckdb",
    )
    if any(term in text for term in backend_only):
        return False
    return any(term in text for term in frontend_terms)


def render_template(path: Path, values: dict[str, Any]) -> str:
    text = path.read_text(encoding="utf-8")
    for key, value in values.items():
        text = text.replace(f"{{{{{key}}}}}", str(value))
    return text


def run_command(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout: int | None = None,
    check: bool = False,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        cmd,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if check and result.returncode != 0:
        raise RuntimeError(
            f"Command failed ({result.returncode}): {' '.join(cmd)}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def resolve_base_commit_before_date(repo_url: str, iso_date: str, branch: str = "main") -> str:
    """Approximate replay base commit as the last commit on branch before issue close."""
    cache_root = BENCHMARK_ROOT / ".repo-cache"
    ensure_dir(cache_root)
    repo_key = slugify(repo_url.replace("https://github.com/", "").replace(".git", ""))
    tmp = cache_root / repo_key
    if not tmp.exists():
        run_command(["git", "clone", "--quiet", "--branch", branch, "--single-branch", repo_url, str(tmp)], check=True)
    else:
        run_command(["git", "fetch", "--quiet", "origin", branch], cwd=tmp, check=False)
    result = run_command(["git", "rev-list", "-1", f"--before={iso_date}", f"origin/{branch}"], cwd=tmp, check=True)
    sha = result.stdout.strip()
    if not sha:
        result = run_command(["git", "rev-list", "-1", f"--before={iso_date}", branch], cwd=tmp, check=True)
        sha = result.stdout.strip()
    if not sha:
        raise RuntimeError(f"No commit found before {iso_date} on {branch}")
    return sha


def slugify(value: str) -> str:
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


def langfuse_auth_header(public_key: str, secret_key: str) -> str:
    token = base64.b64encode(f"{public_key}:{secret_key}".encode("utf-8")).decode("ascii")
    return f"Authorization=Basic {token},x-langfuse-ingestion-version=4"


def langfuse_request(
    method: str,
    path: str,
    *,
    host: str,
    public_key: str,
    secret_key: str,
    payload: dict[str, Any] | None = None,
) -> Any:
    url = f"{host.rstrip('/')}{path}"
    data = None
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Basic {base64.b64encode(f'{public_key}:{secret_key}'.encode()).decode()}",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Langfuse API error {exc.code} for {path}: {body}") from exc


def load_benchmark_env() -> dict[str, str]:
    env = dict(os.environ)
    env.update(load_env_file(BENCHMARK_ROOT / ".env.local"))
    return env


def benchmark_config() -> dict[str, Any]:
    return load_yaml(BENCHMARK_ROOT / "config.yaml")


def benchmark_repos() -> list[dict[str, Any]]:
    return load_yaml(BENCHMARK_ROOT / "repos.yaml")["repos"]


def benchmark_issues() -> list[dict[str, Any]]:
    path = BENCHMARK_ROOT / "issues.yaml"
    if not path.exists():
        return []
    data = load_yaml(path)
    return data.get("issues", [])


def write_json(path: Path, data: Any) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))
