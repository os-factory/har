#!/usr/bin/env python3
"""Live progress dashboard for the v3 benchmark pipeline."""

from __future__ import annotations

import argparse
import json
import mimetypes
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

SCRIPT_DIR = Path(__file__).resolve().parent
BENCHMARK_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.pipeline_state import (  # noqa: E402
    PHASES,
    campaign_summary,
    load_state,
    log_path,
    save_state,
    set_approval,
    tail_log,
)

STATIC_DIR = SCRIPT_DIR / "dashboard_static"
INDEX_HTML = STATIC_DIR / "index.html"


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "HarBenchmarkDashboard/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        return

    def _send_json(self, payload: object, status: int = 200) -> None:
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, text: str, content_type: str = "text/plain; charset=utf-8", status: int = 200) -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path) -> None:
        if not path.exists():
            self._send_text("Not found", status=404)
            return
        data = path.read_bytes()
        mime, _ = mimetypes.guess_type(str(path))
        self.send_response(200)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path in {"/", "/index.html"}:
            return self._send_file(INDEX_HTML)

        if path.startswith("/static/"):
            rel = path.removeprefix("/static/")
            return self._send_file(STATIC_DIR / rel)

        if path == "/api/state":
            state = load_state()
            return self._send_json(
                {
                    "campaign": state.get("campaign_id"),
                    "updated_at": state.get("updated_at"),
                    "phases": list(PHASES),
                    "repos": state.get("repos", {}),
                    "summary": campaign_summary(state),
                }
            )

        if path == "/api/logs":
            qs = parse_qs(parsed.query)
            repo_id = (qs.get("repo") or [""])[0]
            phase = (qs.get("phase") or [""])[0]
            if not repo_id or not phase:
                return self._send_json({"error": "repo and phase required"}, status=400)
            return self._send_json({"repo": repo_id, "phase": phase, "text": tail_log(log_path(repo_id, phase), 300)})

        if path == "/api/issues":
            issues_path = BENCHMARK_ROOT / "issues.v3.yaml"
            if not issues_path.exists():
                return self._send_json({"issues": [], "path": str(issues_path)})
            from lib.common import load_yaml  # noqa: E402

            data = load_yaml(issues_path)
            return self._send_json({"issues": data.get("issues", []), "generated_at": data.get("generated_at")})

        self._send_text("Not found", status=404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/approve/"):
            repo_id = parsed.path.removeprefix("/api/approve/")
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            try:
                body = json.loads(raw or "{}")
            except json.JSONDecodeError:
                body = {}
            notes = body.get("notes", "")
            state = load_state()
            set_approval(state, repo_id, True, notes)
            save_state(state)
            return self._send_json({"ok": True, "repo_id": repo_id, "status": "approved"})

        if parsed.path.startswith("/api/reject/"):
            repo_id = parsed.path.removeprefix("/api/reject/")
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            try:
                body = json.loads(raw or "{}")
            except json.JSONDecodeError:
                body = {}
            notes = body.get("notes", "rejected")
            state = load_state()
            set_approval(state, repo_id, False, notes)
            save_state(state)
            return self._send_json({"ok": True, "repo_id": repo_id, "status": "rejected"})

        self._send_json({"error": "not found"}, status=404)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    if not INDEX_HTML.exists():
        raise SystemExit(f"Missing dashboard UI: {INDEX_HTML}")

    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    print(f"Benchmark dashboard: http://{args.host}:{args.port}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
