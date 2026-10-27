"""Forward Claude Code's ``Elicitation`` hook to the active Omnigent session (omnigent-ae).

An MCP server's question (``--require-confirmation`` on powerbi-modeling-sp, for one) fires
this hook. We park it on the server as a pending elicitation and print the answer JSON
Claude reads. Every failure path exits 0 with nothing on stdout, so Claude Code opens its own
dialog. Never exit 2: Claude Code reads that as a silent decline.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from omnigent.harnesses.claude_native.bridge import (
    approval_wait_marker_path,
    read_active_session_id,
    read_permission_hook_config,
    url_component,
)


def _headers(raw: str | None, config: dict[str, object]) -> dict[str, str]:
    from omnigent.harnesses.claude_native.hook import _parse_headers

    headers = _parse_headers(raw)
    if not headers and isinstance(config.get("ap_auth_headers"), dict):
        headers = {str(k): str(v) for k, v in config["ap_auth_headers"].items()}  # type: ignore[union-attr]
    return headers


def main(argv: list[str]) -> int:
    """Run the ``mcp-elicitation`` subcommand; returns 0 on every path."""
    try:
        return _run(argv)
    except SystemExit:
        # argparse exits 2 on bad arguments, which Claude Code reads as a silent decline.
        return 0
    except Exception as exc:  # noqa: BLE001 (any failure must leave the TUI dialog to Claude)
        print(f"omnigent claude mcp elicitation hook: {exc.__class__.__name__}", file=sys.stderr)
        return 0


def _run(argv: list[str]) -> int:
    from omnigent.cli_auth import databricks_request_headers
    from omnigent.harnesses.claude_native.hook import _post_hook_with_reattach
    from omnigent.native.native_policy_hook import policy_hook_reauth

    parser = argparse.ArgumentParser(prog="hook mcp-elicitation")
    parser.add_argument("--bridge-dir", required=True)
    parser.add_argument("--omnigent-server-url")
    parser.add_argument("--omnigent-auth-headers-json")
    args = parser.parse_args(argv)
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        return 0
    # URL-mode elicitations stay in the TUI for now.
    if not isinstance(payload, dict) or payload.get("mode") == "url":
        return 0
    bridge_dir = Path(args.bridge_dir)
    session_id = read_active_session_id(bridge_dir)
    config = read_permission_hook_config(bridge_dir)
    server_url = args.omnigent_server_url or config.get("ap_server_url")
    if not session_id or not isinstance(server_url, str) or not server_url:
        return 0
    headers = _headers(args.omnigent_auth_headers_json, config)
    headers.update(databricks_request_headers(server_url))
    base = f"{server_url.rstrip('/')}/v1/sessions/{url_component(session_id)}"
    url = f"{base}/hooks/ae-mcp-elicitation"
    resp = _post_hook_with_reattach(
        url,
        headers,
        payload,
        "claude mcp elicitation",
        reauth=policy_hook_reauth(server_url, headers),
        wait_marker=approval_wait_marker_path(session_id, bridge_dir=bridge_dir),
    )
    if resp is not None and resp.content:
        sys.stdout.write(resp.text)
    return 0
