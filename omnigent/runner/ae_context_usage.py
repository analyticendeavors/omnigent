"""Reconstruct a native session's context in a disposable Claude summary process."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import tempfile
import time
import weakref
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi.responses import JSONResponse

TTL = 180
_failures: dict[str, float] = {}
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_locks: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()


def launch_config(
    bridge: Path, process_root: Path = Path("/proc")
) -> tuple[list[str], dict[str, str], str, str]:
    """Use the owning Linux process, never another session's launch configuration."""
    raw = json.loads((bridge / "context_raw.json").read_text())
    if not isinstance(raw, dict):
        raise ValueError("Invalid context snapshot")
    session_id = raw.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("No Claude session reading yet. Send a message first.")
    settings_path = str(bridge / "claude-settings.json")
    for proc in sorted(process_root.glob("[0-9]*"), key=lambda p: int(p.name), reverse=True):
        try:
            original = (proc / "cmdline").read_bytes().decode().split("\0")
            argv = []
            for arg in original:
                argv.extend(arg.split("=", 1) if arg.startswith("--") and "=" in arg else [arg])
            if "--settings" not in argv or argv[argv.index("--settings") + 1] != settings_path:
                continue
            if Path(argv[0]).name != "claude" and "/claude/versions/" not in argv[0]:
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
            single = {
                "--model",
                "--append-system-prompt",
                "--system-prompt",
                "--agents",
                "--agent",
                "--setting-sources",
                "--autocompact",
                "--permission-mode",
                "--append-system-prompt-file",
                "--system-prompt-file",
            }
            multiple = {
                "--mcp-config",
                "--plugin-dir",
                "--add-dir",
                "--tools",
                "--allowedTools",
                "--allowed-tools",
                "--disallowedTools",
                "--disallowed-tools",
            }
            for i, flag in enumerate(argv):
                if flag == "--strict-mcp-config":
                    command.append(flag)
                elif flag in single and i + 1 < len(argv):
                    command.extend((flag, argv[i + 1]))
                elif flag in multiple:
                    command.append(flag)
                    for value in argv[i + 1 :]:
                        if value.startswith("--") or value == "":
                            break
                        command.append(value)
            model = raw.get("model", {})
            model_id = model.get("id") if isinstance(model, dict) else None
            if isinstance(model_id, str) and model_id:
                window = raw.get("context_window", {})
                if (
                    isinstance(window, dict)
                    and window.get("context_window_size") == 1000000
                    and "[1m]" not in model_id
                ):
                    model_id += "[1m]"
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


def isolated_command(command: list[str], cwd: str, scratch: Path) -> list[str]:
    """Redirect bridge advertisements to private copies before starting any MCP server."""
    result = list(command)
    index = 0
    while index < len(result):
        if result[index] != "--mcp-config":
            index += 1
            continue
        index += 1
        while index < len(result) and not result[index].startswith("--"):
            value = result[index]
            config = (
                json.loads(value)
                if value.lstrip().startswith("{")
                else json.loads((Path(cwd) / value).read_text())
            )
            for server in config.get("mcpServers", {}).values():
                args = server.get("args", [])
                if "omnigent.harnesses.claude_native.bridge" not in args:
                    continue
                if "--bridge-dir" not in args:
                    raise ValueError("Unsupported bridge launch configuration")
                position = args.index("--bridge-dir") + 1
                live = Path(args[position])
                if not live.is_absolute():
                    live = Path(cwd) / live
                copy = scratch / str(index)
                copy.mkdir(mode=0o700, exist_ok=True)
                for name in ("bridge.json", "tool_relay.json"):
                    source = live / name
                    if source.exists():
                        target = copy / name
                        target.write_bytes(source.read_bytes())
                        target.chmod(0o600)
                args[position] = str(copy)
            result[index] = json.dumps(config)
            index += 1
    return result


async def probe(command: list[str], env: dict[str, str], cwd: str) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="ae-context-") as scratch:
        isolated = await asyncio.to_thread(isolated_command, command, cwd, Path(scratch))
        return await _probe(isolated, env, cwd)


async def _probe(command: list[str], env: dict[str, str], cwd: str) -> dict[str, Any]:
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
            if not isinstance(message, dict):
                raise ValueError("Invalid control message")
            response = message.get("response", {})
            if not isinstance(response, dict):
                raise ValueError("Invalid control response")
            if message.get("type") != "control_response" or response.get("request_id") != rid:
                continue
            if response.get("subtype") != "success":
                raise ValueError(
                    "Claude Code does not support context summaries. Update it and retry."
                )
            payload = response.get("response", {})
            if not isinstance(payload, dict):
                raise ValueError("Invalid control payload")
            return payload
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
                if not isinstance(servers, list) or any(not isinstance(s, dict) for s in servers):
                    raise ValueError("Invalid MCP status")
                pending = any(s.get("status") in ("pending", "connecting") for s in servers)
                if attempt >= 3 and servers and not pending:
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
            if time.monotonic() - _failures.get(conversation_id, float("-inf")) < 30:
                raise ValueError("Recent probe failure")
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
            _failures.pop(conversation_id, None)
            _cache[key] = (now, answer)
            return JSONResponse(answer)
        except (OSError, ValueError, TimeoutError, AttributeError, TypeError, httpx.HTTPError):
            _failures.setdefault(conversation_id, time.monotonic())
            if time.monotonic() - _failures[conversation_id] >= 30:
                _failures[conversation_id] = time.monotonic()
            return JSONResponse(
                {
                    "available": False,
                    "reason": (
                        "Could not read Claude context. Resume the session, "
                        "check its MCP connections, and try again."
                    ),
                }
            )
