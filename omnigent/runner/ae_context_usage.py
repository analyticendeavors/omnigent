"""Reconstruct a native session's context in a disposable Claude summary process."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import os
import re
import signal
import tempfile
import time
import weakref
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

TTL = 180
_failures: dict[str, float] = {}
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_locks: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()


class ContextNotReady(ValueError):
    """Claude has not started yet; the route answers ``pending`` with no backoff."""


class ContextUnsupported(ValueError):
    """Retrying can never succeed in this session; the route answers ``final``."""


class _RecentFailure(ValueError):
    """Inside the 30-second backoff after a real failure; logged once, not per request."""


def launch_config(
    bridge: Path, process_root: Path = Path("/proc")
) -> tuple[list[str], dict[str, str], str, str]:
    """Use the owning Linux process, never another session's launch configuration."""
    try:
        text = (bridge / "context_raw.json").read_text()
    except FileNotFoundError as exc:
        # Claude's statusLine shim writes this file once Claude is up.
        raise ContextNotReady("Claude has not written its first status reading yet.") from exc
    raw = json.loads(text)
    if not isinstance(raw, dict):
        raise ValueError("Invalid context snapshot")
    session_id = raw.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        raise ContextNotReady("No Claude session reading yet. Send a message first.")
    if not process_root.is_dir():
        raise ContextUnsupported("Context categories need the Linux /proc interface.")
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
    raise ContextNotReady("No live Claude process for this session. Resume it and try again.")


MCP_STATUSES = ("connected", "failed", "needs-auth", "pending", "disabled")


def mcp_rows(servers: object) -> list[dict[str, str]]:
    """Each server's name and status only; config, URLs and error text stay on the runner."""
    if not isinstance(servers, list):
        return []
    rows = []
    for server in servers:
        if not isinstance(server, dict) or not isinstance(server.get("name"), str):
            continue
        name = server["name"].strip()[:120]
        if not name:
            continue
        status = server.get("status")
        if status == "connecting":
            status = "pending"
        rows.append({"name": name, "status": status if status in MCP_STATUSES else "unknown"})
    return rows


def normalize(body: dict[str, Any], *, complete: bool, servers: object = None) -> dict[str, Any]:
    """Allow only display data across the runner boundary, never MCP configuration."""
    categories = body.get("categories")
    maximum = body.get("maxTokens")
    total = body.get("totalTokens")
    if (
        not isinstance(categories, list)
        or not categories
        or not isinstance(maximum, (int, float))
        or not math.isfinite(maximum)
        or maximum <= 0
        or not isinstance(total, (int, float))
        or not math.isfinite(total)
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
            raise ValueError("Claude returned an unsupported context category.")
        tokens = row.get("tokens")
        if (
            not isinstance(tokens, (int, float))
            or not math.isfinite(tokens)
            or tokens < 0
            or not isinstance(row.get("name"), str)
        ):
            raise ValueError("Claude returned an unsupported context category.")
        clean.append({"name": row["name"], "tokens": tokens, "kind": row["kind"]})
    threshold = body.get("autoCompactThreshold")
    return {
        "available": True,
        "categories": clean,
        "totalTokens": total,
        "maxTokens": maximum,
        "autoCompactThreshold": threshold
        if isinstance(threshold, (int, float)) and math.isfinite(threshold) and threshold > 0
        else None,
        "isAutoCompactEnabled": body.get("isAutoCompactEnabled") is True,
        "observedAt": datetime.now(UTC).isoformat(),
        "complete": complete,
        "details": detail_rows(body),
        "mcpServers": mcp_rows(servers),
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
        if name and isinstance(tokens, (int, float)) and math.isfinite(tokens) and tokens >= 0:
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
            for number, server in enumerate(config.get("mcpServers", {}).values()):
                args = server.get("args", [])
                if "omnigent.harnesses.claude_native.bridge" not in args:
                    if any(
                        "bridge-dir" in str(arg) or "claude_native.bridge" in str(arg)
                        for arg in args
                    ):
                        raise ValueError("Unrecognized bridge launch; cannot isolate safely")
                    continue
                if "--bridge-dir" not in args:
                    raise ValueError("Unsupported bridge launch configuration")
                position = args.index("--bridge-dir") + 1
                live = Path(args[position])
                if not live.is_absolute():
                    live = Path(cwd) / live
                copy = scratch / f"{index}-{number}"
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


def _scratch_parent() -> Path:
    """Return the claude-native bridge root, created owner-only, to hold probe copies.

    The bridge refuses any ``--bridge-dir`` outside its allowed roots, so copies in the
    system temp dir make the probe's omnigent MCP server fail to start. The orphan
    sweep skips children without an ``owner.pid`` marker, which the copies lack.
    """
    from omnigent.harnesses.claude_native.bridge import (
        bridge_dir_for_bridge_id,
        ensure_secure_dir,
    )

    root = bridge_dir_for_bridge_id("ae-context-probe").parent
    try:
        ensure_secure_dir(root)
    except RuntimeError as exc:
        # ValueError keeps the route's "unavailable" answer and its 30-second backoff.
        raise ValueError(
            f"Bridge root {root} failed its owner or permission check ({exc}). "
            "Fix that directory's owner and mode, then retry."
        ) from exc
    return root


async def probe(command: list[str], env: dict[str, str], cwd: str) -> dict[str, Any]:
    parent = await asyncio.to_thread(_scratch_parent)
    with tempfile.TemporaryDirectory(prefix="ae-context-", dir=parent) as scratch:
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
            servers: list[Any] = []
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
            return normalize(body, complete=complete, servers=servers)
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGKILL)
        transport = getattr(proc, "_transport", None)
        if transport is not None:
            transport.close()
        await proc.wait()


_PENDING = {"available": False, "pending": True, "reason": "Claude is starting."}


def _log_detail(exc: BaseException) -> str:
    """The message's first line with every path cut to its last part; never config or env."""
    text = exc.strerror if isinstance(exc, OSError) and exc.strerror else str(exc)
    first = text.splitlines()[0] if text else ""
    return re.sub(r"(?:/[^\s/]+)+/([^\s/]+)", r"\1", first)[:200]


async def handle_context_usage(
    conversation_id: str, *, harness: str | None, server_client: httpx.AsyncClient
) -> JSONResponse:
    from omnigent.harnesses.claude_native.bridge import bridge_dir_for_bridge_id
    from omnigent.runner.native import _claude_native_bridge_id_for_session

    if harness is None:
        # The runner has not loaded this session's spec yet: starting, not final.
        return JSONResponse(_PENDING)
    if harness != "claude-native":
        return JSONResponse(
            {
                "available": False,
                "final": True,
                "reason": "Context categories require a running Claude Code session.",
            }
        )
    lock = _locks.setdefault(conversation_id, asyncio.Lock())
    async with lock:
        try:
            for expired in list(_failures):
                if time.monotonic() - _failures[expired] >= 30:
                    _failures.pop(expired, None)
            if time.monotonic() - _failures.get(conversation_id, float("-inf")) < 30:
                raise _RecentFailure("Recent probe failure")
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
        except ContextNotReady:
            # Claude is still starting (or not running): not a failure, so no backoff.
            return JSONResponse(_PENDING)
        except ContextUnsupported as exc:
            return JSONResponse({"available": False, "final": True, "reason": str(exc)})
        except (
            OSError,
            ValueError,
            TimeoutError,
            AttributeError,
            TypeError,
            httpx.HTTPError,
        ) as exc:
            if not isinstance(exc, _RecentFailure):
                logger.info(
                    "Context probe for session %s failed: %s: %s",
                    conversation_id,
                    type(exc).__name__,
                    _log_detail(exc),
                )
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
