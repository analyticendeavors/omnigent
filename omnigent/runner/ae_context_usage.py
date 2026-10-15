"""Reconstruct a native session's context in a disposable Claude summary process."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import time
import weakref
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi.responses import JSONResponse

TTL = 180
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_locks: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()


def launch_config(
    bridge: Path, process_root: Path = Path("/proc")
) -> tuple[list[str], dict[str, str], str, str]:
    """Use the owning Linux process, never another session's launch configuration."""
    raw = json.loads((bridge / "context_raw.json").read_text())
    session_id = raw.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("No Claude session reading yet. Send a message first.")
    settings_path = str(bridge / "claude-settings.json")
    for proc in process_root.glob("[0-9]*"):
        try:
            argv = (proc / "cmdline").read_bytes().decode().split("\0")
            if "--settings" not in argv or argv[argv.index("--settings") + 1] != settings_path:
                continue
            if Path(argv[0]).name != "claude":
                continue
            env = dict(
                item.split("=", 1)
                for item in (proc / "environ").read_bytes().decode().split("\0")
                if "=" in item
            )
            env.pop("CLAUDECODE", None)
            cwd = os.readlink(proc / "cwd")
            settings = json.loads(Path(settings_path).read_text())
            settings.pop("hooks", None)
            settings["disableAllHooks"] = True
            settings["statusLine"] = {"type": "command", "command": "true"}
            command = [
                argv[0],
                "-p",
                "--resume",
                session_id,
                "--fork-session",
                "--no-session-persistence",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--settings",
                json.dumps(settings),
            ]
            for flag in (
                "--model",
                "--mcp-config",
                "--append-system-prompt",
                "--system-prompt",
                "--plugin-dir",
                "--add-dir",
                "--agents",
                "--agent",
                "--setting-sources",
            ):
                for i, arg in enumerate(argv[:-1]):
                    if arg == flag:
                        command.extend((flag, argv[i + 1]))
            model = raw.get("model", {})
            model_id = model.get("id") if isinstance(model, dict) else None
            if isinstance(model_id, str) and model_id:
                if "--model" in command:
                    command[command.index("--model") + 1] = model_id
                else:
                    command.extend(("--model", model_id))
            return command, env, cwd, session_id
        except (OSError, ValueError, IndexError):
            continue
    raise ValueError("No live Claude process for this session. Resume it and try again.")


def normalize(body: dict[str, Any], *, complete: bool) -> dict[str, Any]:
    """Allow only display data across the runner boundary, never MCP configuration."""
    categories = body.get("categories")
    maximum = body.get("maxTokens")
    total = body.get("totalTokens")
    if (
        not isinstance(categories, list)
        or not isinstance(maximum, (int, float))
        or maximum <= 0
        or not isinstance(total, (int, float))
        or total < 0
    ):
        raise ValueError(
            "Claude returned an unsupported context response. Update Claude Code and retry."
        )
    clean = []
    for row in categories:
        if not isinstance(row, dict) or row.get("kind") not in (
            "used",
            "free",
            "buffer",
            "deferred",
        ):
            continue
        tokens = row.get("tokens")
        if (
            not isinstance(tokens, (int, float))
            or tokens < 0
            or not isinstance(row.get("name"), str)
        ):
            continue
        clean.append({"name": row["name"], "tokens": tokens, "kind": row["kind"]})
    threshold = body.get("autoCompactThreshold")
    return {
        "available": True,
        "categories": clean,
        "totalTokens": total,
        "maxTokens": maximum,
        "autoCompactThreshold": threshold
        if isinstance(threshold, (int, float)) and threshold > 0
        else None,
        "isAutoCompactEnabled": body.get("isAutoCompactEnabled") is True,
        "observedAt": datetime.now(UTC).isoformat(),
        "complete": complete,
        "details": detail_rows(body),
    }


def detail_rows(body: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    result = {}
    for key, label, names in (
        ("memoryFiles", "Memory files", ("path", "name")),
        ("mcpTools", "MCP tools", ("name", "toolName")),
        ("agents", "Custom agents", ("name", "agentType")),
    ):
        rows = body.get(key, [])
        result[label] = _rows(rows, names)
    skills = body.get("skills", {})
    result["Skills"] = _rows(
        skills.get("skillFrontmatter", []) if isinstance(skills, dict) else [], ("name",)
    )
    return result


def _rows(rows: object, names: tuple[str, ...]) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        return []
    result = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = next((row[n] for n in names if isinstance(row.get(n), str)), None)
        tokens = row.get("tokens")
        if name and isinstance(tokens, (int, float)) and tokens >= 0:
            result.append({"name": name, "tokens": tokens})
    return result


async def probe(command: list[str], env: dict[str, str], cwd: str) -> dict[str, Any]:
    proc = await asyncio.create_subprocess_exec(
        *command,
        env=env,
        cwd=cwd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        start_new_session=True,
        limit=8 * 1024 * 1024,
    )
    assert proc.stdin is not None and proc.stdout is not None
    sequence = 0

    async def request(body: dict[str, Any]) -> dict[str, Any]:
        nonlocal sequence
        sequence += 1
        rid = str(sequence)
        proc.stdin.write(
            (
                json.dumps({"type": "control_request", "request_id": rid, "request": body}) + "\n"
            ).encode()
        )
        await proc.stdin.drain()
        while line := await proc.stdout.readline():
            message = json.loads(line)
            response = message.get("response", {})
            if message.get("type") != "control_response" or response.get("request_id") != rid:
                continue
            if response.get("subtype") != "success":
                raise ValueError(
                    "Claude Code does not support context summaries. Update it and retry."
                )
            return response.get("response", {})
        raise ValueError("Claude stopped before returning context. Try again.")

    try:
        async with asyncio.timeout(25):
            await request({"subtype": "initialize"})
            complete = False
            # MCP discovery starts asynchronously after initialization.
            for attempt in range(16):
                await asyncio.sleep(0.5)
                status = await request({"subtype": "mcp_status"})
                servers = status.get("mcpServers", [])
                pending = any(s.get("status") in ("pending", "connecting") for s in servers)
                if attempt >= 3 and not pending:
                    complete = all(s.get("status") == "connected" for s in servers)
                    break
            body = await request({"subtype": "get_context_usage", "detail": "summary"})
            return normalize(body, complete=complete)
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGKILL)
        transport = getattr(proc, "_transport", None)
        if transport is not None:
            transport.close()
        await proc.wait()


async def handle_context_usage(
    conversation_id: str, *, harness: str | None, server_client: httpx.AsyncClient
) -> JSONResponse:
    from omnigent.harnesses.claude_native.bridge import bridge_dir_for_bridge_id
    from omnigent.runner.native import _claude_native_bridge_id_for_session

    if harness != "claude-native":
        return JSONResponse(
            {
                "available": False,
                "reason": "Context categories require a running Claude Code session.",
            }
        )
    lock = _locks.setdefault(conversation_id, asyncio.Lock())
    async with lock:
        try:
            bridge_id = await _claude_native_bridge_id_for_session(
                server_client=server_client, session_id=conversation_id
            )
            command, env, cwd, session_id = await asyncio.to_thread(
                launch_config, bridge_dir_for_bridge_id(bridge_id)
            )
            model = command[command.index("--model") + 1] if "--model" in command else ""
            key = f"{conversation_id}:{session_id}:{model}"
            cached = _cache.get(key)
            if cached and time.monotonic() - cached[0] < TTL:
                return JSONResponse(cached[1])
            answer = await probe(command, env, cwd)
            now = time.monotonic()
            for old in list(_cache):
                if now - _cache[old][0] >= TTL:
                    del _cache[old]
            _cache[key] = (now, answer)
            return JSONResponse(answer)
        except (OSError, ValueError, TimeoutError):
            return JSONResponse(
                {
                    "available": False,
                    "reason": (
                        "Could not read Claude context. Resume the session, "
                        "check its MCP connections, and try again."
                    ),
                }
            )
