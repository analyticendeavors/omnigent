"""
Predict the user's next prompt after each finished Claude turn.

Claude Code has its own prompt suggestions, but only in print/SDK mode; the
interactive TUI that OmniGent runs in tmux never draws one on screen or
writes one to the transcript, so there is nothing to relay. Instead, when the
forwarder sees a turn's ``Stop`` hook, this module makes one small side call
(``claude -p --model haiku``) with the turn's last user prompt and last reply,
and posts the one-line answer as a transient ``external_session_suggestion``
event that the web composer shows as ghost text.

The side call is isolated from everything the session itself uses: no hooks
(a ``Stop`` hook firing from it would start another call, for ever), no
settings files, no MCP servers, no tools, no session transcript, no OmniGent
environment, and a temporary cwd and Claude config dir of its own, so it never
writes the user's ``~/.claude.json``. It runs as a background task so
transcript forwarding never waits on it, at most one per session; a newer
turn, a prompt typed in the terminal and the forwarder's own exit all cancel a
call still in flight and kill its process group. It runs only for sessions on
Claude's own login (no gateway, Bedrock or Vertex). Off unless
``AE_PROMPT_SUGGESTIONS=1``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import shutil
import signal
import tempfile
import time
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final

import httpx

from omnigent.harnesses.claude_native.transcript_filters import is_request_log_record
from omnigent.util.ae_session_suggestion import (
    EXTERNAL_SESSION_SUGGESTION_TYPE,
    MAX_SUGGESTION_CHARS,
)

_logger = logging.getLogger(__name__)

ENABLE_ENV_VAR: Final = "AE_PROMPT_SUGGESTIONS"
CLAUDE_PATH_ENV_VAR: Final = "OMNIGENT_CLAUDE_PATH"
SIDE_CALL_MODEL: Final = "haiku"
SIDE_CALL_TIMEOUT_S: Final = 15.0
# Characters of conversation the side call sees: the prompt's head, the reply's tail.
MAX_CONTEXT_CHARS: Final = 2000
MAX_PROMPT_CHARS: Final = 600
# A Stop hook older than this (a forwarder catching up after a restart) is not
# a turn the user is looking at now.
MAX_TURN_AGE_S: Final = 120.0
# Only the transcript's tail is read; one turn's prompt and reply fit in it.
TAIL_BYTES: Final = 512 * 1024
NONE_REPLY: Final = "NONE"
# A copied login must stay valid this long, so the side call never refreshes
# it (a refresh would rotate the token the user's own sessions hold).
MIN_TOKEN_LIFETIME_S: Final = 600.0

SYSTEM_PROMPT: Final = (
    "You predict the next message a user will type to their coding assistant. "
    "You get the user's last message and the assistant's reply. Answer with the "
    "user's most likely next message, in the user's own voice and style, as one "
    f"line of at most {MAX_SUGGESTION_CHARS} characters, with no quotes and no "
    f"explanation. If no next message is clearly likely, answer {NONE_REPLY}."
)

# Environment the side call must not inherit: OmniGent's runner wiring and
# tokens, and Claude Code's own session and suggestion switches.
_DROPPED_ENV_PREFIXES: Final = ("OMNIGENT_", "RUNNER_", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")
_DROPPED_ENV_NAMES: Final = frozenset(
    {"CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_SESSION_ID"}
)
_WORKDIR_PREFIX: Final = "omnigent-ae-prompt-suggest-"
_OAUTH_TOKEN_ENV_VAR: Final = "CLAUDE_CODE_OAUTH_TOKEN"
_CREDENTIALS_FILE: Final = ".credentials.json"
# Any of these routes Claude somewhere other than Anthropic's API on the
# user's own login (a gateway, Bedrock, Vertex, Foundry).
_PROVIDER_ENV_KEYS: Final = (
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
)
# The session's own settings file in its bridge dir (bridge.py writes it).
_BRIDGE_SETTINGS_FILE: Final = "claude-settings.json"
# The account sidecar the session's statusLine shim writes from the terminal's
# own OMNIGENT_CLAUDE_ACCOUNT on every render: empty for the default login, the
# account name for a named one (status.CLAUDE_ACCOUNT_FILE).
_BRIDGE_ACCOUNT_FILE: Final = "claude_account"


@dataclass
class SuggestionState:
    """
    Per-forwarder state for the prompt-suggestion side call.

    :param task: The in-flight side call, or ``None`` when none runs.
    :param is_child: Per session id, whether it is a sub-agent session (cached
        after one lookup; sub-agent sessions get no suggestions).
    :param shown: Session id whose composer may still show a posted
        suggestion, so a prompt typed in the terminal can clear it.
    """

    task: asyncio.Task[None] | None = None
    is_child: dict[str, bool] = field(default_factory=dict)
    shown: str | None = None


@dataclass(frozen=True)
class TurnContext:
    """
    What the side call sees of the finished turn.

    :param user_prompt: The user's last message, e.g. ``"fix the failing test"``,
        or ``""`` when the transcript does not hold it yet.
    :param assistant_text: The assistant's last reply text.
    """

    user_prompt: str
    assistant_text: str


def suggestions_enabled(env: Mapping[str, str] | None = None) -> bool:
    """Whether ``AE_PROMPT_SUGGESTIONS`` switches the feature on (``1``, ``true`` or ``yes``)."""
    value = (os.environ if env is None else env).get(ENABLE_ENV_VAR, "")
    return value.strip().lower() in {"1", "true", "yes"}


def _user_prompt_text(content: object) -> str | None:
    """The typed text of a user transcript entry, or ``None`` for tool results and markers."""
    if isinstance(content, str):
        text = content.strip()
    elif isinstance(content, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return None
        text = "\n".join(
            str(b.get("text", ""))
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        ).strip()
    else:
        return None
    # Slash-command echoes, command output and system notices are wrapped in tags.
    if not text or text.startswith("<"):
        return None
    return text


def _tool_result_ids(content: object) -> set[str]:
    """The ``tool_use_id`` of every tool result in a user entry."""
    if not isinstance(content, list):
        return set()
    return {
        str(b.get("tool_use_id"))
        for b in content
        if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("tool_use_id")
    }


def _read_tail_lines(path: Path) -> list[str]:
    """The transcript's last :data:`TAIL_BYTES`, as whole lines."""
    with path.open("rb") as handle:
        size = handle.seek(0, os.SEEK_END)
        start = max(0, size - TAIL_BYTES)
        handle.seek(start)
        data = handle.read()
    lines = data.decode("utf-8", errors="replace").splitlines()
    return lines[1:] if start > 0 and lines else lines


def read_turn_context(
    transcript_path: Path | None, last_assistant_message: str | None = None
) -> TurnContext | None:
    """
    Read the finished turn's last user prompt and last reply.

    The ``Stop`` hook's ``last_assistant_message`` is the reply when present,
    since Claude Code may fire the hook before the transcript holds the turn's
    last lines; the transcript tail then supplies only the prompt. Without it,
    the reply also comes from the tail.

    :param transcript_path: Claude's session transcript (JSONL), when known.
    :param last_assistant_message: The ``Stop`` payload's reply text, when sent.
    :returns: The context, or ``None`` when there is no reply text, or (without
        ``last_assistant_message``) no prompt, an unreadable transcript, or a
        tail that still waits on the user (a tool call such as an
        AskUserQuestion or a permission prompt with no result yet).
    """
    hook_reply = (last_assistant_message or "").strip()
    try:
        lines = _read_tail_lines(transcript_path) if transcript_path is not None else []
    except OSError:
        lines = []
    user_prompt: str | None = None
    assistant_text: str | None = None
    pending_tools: set[str] = set()
    for line in lines:
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(entry, dict) or is_request_log_record(entry):
            continue
        if entry.get("isSidechain") or entry.get("isMeta") or entry.get("isCompactSummary"):
            continue
        message = entry.get("message")
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if entry.get("type") == "user":
            pending_tools -= _tool_result_ids(content)
            prompt = _user_prompt_text(content)
            if prompt is not None:
                user_prompt, assistant_text = prompt, None
                pending_tools = set()
        elif entry.get("type") == "assistant" and isinstance(content, list):
            texts = [
                str(b.get("text", "")).strip()
                for b in content
                if isinstance(b, dict) and b.get("type") == "text"
            ]
            if any(texts):
                assistant_text = "\n".join(t for t in texts if t)
            pending_tools |= {
                str(b.get("id"))
                for b in content
                if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("id")
            }
    if hook_reply:
        return TurnContext(user_prompt=user_prompt or "", assistant_text=hook_reply)
    if user_prompt is None or not assistant_text or pending_tools:
        return None
    return TurnContext(user_prompt=user_prompt, assistant_text=assistant_text)


def build_side_call_prompt(context: TurnContext) -> str:
    """
    The side call's user message: the prompt's head and the reply's tail.

    The whole message stays within :data:`MAX_CONTEXT_CHARS` of conversation.
    """
    prompt = context.user_prompt[:MAX_PROMPT_CHARS]
    reply_budget = MAX_CONTEXT_CHARS - len(prompt)
    reply = context.assistant_text[-reply_budget:]
    return (
        f"<user_message>\n{prompt}\n</user_message>\n\n"
        f"<assistant_reply>\n{reply}\n</assistant_reply>\n\n"
        "The user's next message:"
    )


def clean_suggestion(raw: str) -> str | None:
    """
    The suggestion to show, from the side call's raw output.

    :param raw: Everything the side call printed.
    :returns: The first non-empty line without wrapping quotes, cut at a word
        boundary to :data:`MAX_SUGGESTION_CHARS`; ``None`` for ``NONE`` or
        empty output.
    """
    line = next((ln.strip() for ln in raw.splitlines() if ln.strip()), "")
    line = line.strip("\"'`“”‘’").strip()
    if not line or line.rstrip(".").upper() == NONE_REPLY:
        return None
    if len(line) > MAX_SUGGESTION_CHARS:
        cut = line[:MAX_SUGGESTION_CHARS]
        space = cut.rfind(" ")
        line = (cut[:space] if space > MAX_SUGGESTION_CHARS // 2 else cut).rstrip(" ,;:")
    return line or None


def side_call_argv(claude_bin: str) -> list[str]:
    """
    The side call's command line. Each flag checked against ``claude --help``
    (Claude Code 2.1.305, 2026-10-20).

    ``--safe-mode`` drops hooks, MCP servers, CLAUDE.md, skills, plugins and
    auto-memory while keeping the OAuth login; ``--setting-sources ""`` loads
    no user, project or local settings, and ``disableAllHooks`` stops any hook
    a remaining source could add. ``--no-session-persistence`` writes no
    transcript. The prompt arrives on stdin.
    """
    return [
        claude_bin,
        "-p",
        "--model",
        SIDE_CALL_MODEL,
        "--safe-mode",
        "--setting-sources",
        "",
        "--settings",
        '{"disableAllHooks": true}',
        "--strict-mcp-config",
        "--tools",
        "",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--output-format",
        "text",
        "--system-prompt",
        SYSTEM_PROMPT,
    ]


def side_call_env(
    base: Mapping[str, str] | None = None, *, config_dir: Path | None = None
) -> dict[str, str]:
    """
    The side call's environment: this process's, minus OmniGent and Claude
    session wiring, with ``CLAUDE_CONFIG_DIR`` pointed at ``config_dir``.

    Claude Code rewrites ``.claude.json`` in its config dir on every run (a
    measured run on 2026-10-20 changed ``~/.claude.json`` and left a backup);
    a private dir keeps that write away from the user's live sessions.
    """
    source = os.environ if base is None else base
    env = {
        key: value
        for key, value in source.items()
        if not key.startswith(_DROPPED_ENV_PREFIXES) and key not in _DROPPED_ENV_NAMES
    }
    if config_dir is not None:
        env["CLAUDE_CONFIG_DIR"] = str(config_dir)
    return env


def _login_config_dir(env: Mapping[str, str]) -> Path:
    """The user's Claude config dir: ``CLAUDE_CONFIG_DIR`` when set, else ``~/.claude``."""
    configured = env.get("CLAUDE_CONFIG_DIR", "").strip()
    return Path(configured) if configured else Path.home() / ".claude"


def copy_login(config_dir: Path, env: Mapping[str, str] | None = None) -> bool:
    """
    Give the private config dir the login the side call needs, and only that.

    With ``CLAUDE_CODE_OAUTH_TOKEN`` in the environment the token travels there
    and nothing is copied. Otherwise only the ``claudeAiOauth`` entry of the
    user's credentials file is copied, and only while its access token stays
    valid for :data:`MIN_TOKEN_LIFETIME_S`, so the side call never refreshes it.

    :param config_dir: The private config dir.
    :param env: Environment to read (the process's own by default).
    :returns: Whether the side call has a login to use.
    """
    source = os.environ if env is None else env
    if source.get(_OAUTH_TOKEN_ENV_VAR, "").strip():
        return True
    try:
        data = json.loads((_login_config_dir(source) / _CREDENTIALS_FILE).read_text("utf-8"))
    except (OSError, ValueError):
        return False
    oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
    if not isinstance(oauth, dict) or not oauth.get("accessToken"):
        return False
    expires_at = oauth.get("expiresAt")
    if not isinstance(expires_at, (int, float)):
        return False
    if expires_at / 1000 - time.time() < MIN_TOKEN_LIFETIME_S:
        return False
    target = config_dir / _CREDENTIALS_FILE
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump({"claudeAiOauth": oauth}, handle)
    return True


@contextlib.contextmanager
def _side_call_dirs() -> Iterator[tuple[Path, Path]]:
    """A fresh ``(cwd, config_dir)`` pair for one call, removed afterwards."""
    root = Path(tempfile.mkdtemp(prefix=_WORKDIR_PREFIX))
    try:
        cwd, config_dir = root / "cwd", root / "config"
        cwd.mkdir()
        config_dir.mkdir(mode=0o700)
        yield cwd, config_dir
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _claude_binary() -> str | None:
    """The Claude CLI: ``OMNIGENT_CLAUDE_PATH`` when set, else ``claude`` on PATH."""
    configured = os.environ.get(CLAUDE_PATH_ENV_VAR, "").strip()
    return configured or shutil.which("claude")


def _kill_group(proc: asyncio.subprocess.Process) -> None:
    """SIGKILL the side call's whole process group (it leads its own session)."""
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, signal.SIGKILL)


async def run_side_call(prompt: str, *, timeout_s: float = SIDE_CALL_TIMEOUT_S) -> str | None:
    """
    Run one isolated ``claude -p`` call and return its cleaned answer.

    :param prompt: The side call's user message.
    :param timeout_s: Seconds before the call is killed.
    :returns: The suggestion, or ``None`` on ``NONE``, a failure, a timeout or
        no usable login.
    :raises asyncio.CancelledError: When a newer turn cancels the call; the
        process group is killed first.
    """
    claude_bin = _claude_binary()
    if claude_bin is None:
        _logger.debug("prompt suggestion skipped: no claude binary on PATH")
        return None
    with _side_call_dirs() as (cwd, config_dir):
        if not copy_login(config_dir):
            _logger.debug("prompt suggestion skipped: no login valid for the next 10 minutes")
            return None
        proc = await asyncio.create_subprocess_exec(
            *side_call_argv(claude_bin),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            cwd=cwd,
            env=side_call_env(config_dir=config_dir),
            start_new_session=True,
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(prompt.encode()), timeout_s)
        except BaseException as exc:
            _kill_group(proc)
            with contextlib.suppress(Exception):
                await proc.wait()
            if isinstance(exc, TimeoutError):
                _logger.debug("prompt suggestion side call timed out after %.0fs", timeout_s)
                return None
            raise
    if proc.returncode != 0:
        _logger.debug("prompt suggestion side call exited %s", proc.returncode)
        return None
    return clean_suggestion(stdout.decode("utf-8", errors="replace"))


def uses_default_provider(bridge_dir: Path | None, env: Mapping[str, str] | None = None) -> bool:
    """
    Whether the session runs on Claude's own login against Anthropic's API.

    False when this process's environment or the session's settings file
    names a gateway, Bedrock, Vertex or Foundry, or an ``apiKeyHelper``, or
    when the host's claude-native launch config or managed settings resolve
    one; then the side call would bill or reach somewhere else.

    :param bridge_dir: The session's bridge dir, when known.
    :param env: Environment to read (the process's own by default).
    :returns: ``True`` only when every check finds the default provider.
    """
    source = os.environ if env is None else env
    if any(source.get(key, "").strip() for key in _PROVIDER_ENV_KEYS):
        return False
    if bridge_dir is not None:
        try:
            settings = json.loads((bridge_dir / _BRIDGE_SETTINGS_FILE).read_text("utf-8"))
        except FileNotFoundError:
            settings = {}
        except (OSError, ValueError):
            return False
        if not isinstance(settings, dict) or settings.get("apiKeyHelper"):
            return False
        settings_env = settings.get("env")
        if isinstance(settings_env, dict) and any(settings_env.get(k) for k in _PROVIDER_ENV_KEYS):
            return False
    try:
        from omnigent.harnesses.claude_native.main import (
            managed_claude_gateway_signal,
            resolve_native_claude_config,
        )

        if resolve_native_claude_config(spec=None, refresh_models=False) is not None:
            return False
        managed_base_url, _ = managed_claude_gateway_signal()
    except Exception:  # noqa: BLE001 - an unreadable config is not the default provider
        return False
    return managed_base_url is None


def uses_default_account(bridge_dir: Path | None) -> bool:
    """
    Whether the session's terminal runs on the host's default Claude login.

    A named account reaches only the terminal (its token in the terminal's
    environment), so a side call from the forwarder would bill the default
    login instead; such sessions get no call, and no account token is ever
    copied into one. The terminal's statusLine shim records its own
    ``OMNIGENT_CLAUDE_ACCOUNT`` in the bridge dir's ``claude_account`` before
    every render, so the file names the account the running terminal uses.
    The forwarder's environment cannot say: the launch blanks the inherited
    name and sets the account in the terminal's environment only.

    :param bridge_dir: The session's bridge dir, when known.
    :returns: ``True`` only when the file exists and is empty; a missing file
        (no render yet) or any name reads as not the default.
    """
    if bridge_dir is None:
        return False
    try:
        return not (bridge_dir / _BRIDGE_ACCOUNT_FILE).read_text("utf-8").strip()
    except OSError:
        return False


async def _is_child_session(
    client: httpx.AsyncClient, session_id: str, state: SuggestionState
) -> bool | None:
    """Whether the session is a sub-agent session; ``None`` when the lookup failed."""
    if session_id in state.is_child:
        return state.is_child[session_id]
    try:
        resp = await client.get(
            f"/v1/sessions/{session_id}",
            params={"include_items": "false", "include_usage": "false"},
        )
        resp.raise_for_status()
        is_child = resp.json().get("parent_session_id") is not None
    except (httpx.HTTPError, ValueError, AttributeError):
        return None
    state.is_child[session_id] = is_child
    return is_child


async def post_suggestion(
    client: httpx.AsyncClient, *, session_id: str, suggestion: str | None
) -> None:
    """
    Post one transient ``external_session_suggestion`` event.

    :param client: Omnigent HTTP client.
    :param session_id: Omnigent session/conversation id, e.g. ``"conv_abc123"``.
    :param suggestion: The predicted prompt, or ``None`` to clear it.
    :raises httpx.HTTPError: If the request fails or is rejected.
    """
    resp = await client.post(
        f"/v1/sessions/{session_id}/events",
        json={"type": EXTERNAL_SESSION_SUGGESTION_TYPE, "data": {"suggestion": suggestion}},
    )
    resp.raise_for_status()


async def _suggest(
    client: httpx.AsyncClient,
    *,
    session_id: str,
    transcript_path: Path | None,
    last_assistant_message: str | None,
    bridge_dir: Path | None,
    state: SuggestionState,
) -> None:
    """The background task: skip rules, side call, post. Never raises but on cancel."""
    try:
        if await _is_child_session(client, session_id, state) is not False:
            return
        if not await asyncio.to_thread(uses_default_account, bridge_dir):
            _logger.debug("prompt suggestion skipped: session runs on a named Claude account")
            return
        if not await asyncio.to_thread(uses_default_provider, bridge_dir):
            _logger.debug(
                "prompt suggestion skipped: session is not on the default Anthropic provider"
            )
            return
        context = await asyncio.to_thread(
            read_turn_context, transcript_path, last_assistant_message
        )
        if context is None:
            return
        suggestion = await run_side_call(build_side_call_prompt(context))
        if suggestion is None or client.is_closed:
            return
        await post_suggestion(client, session_id=session_id, suggestion=suggestion)
        state.shown = session_id
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 - a suggestion is best effort and must not hurt forwarding
        _logger.debug(
            "prompt suggestion failed; session=%s",
            session_id,
            exc_info=True,
            extra={"session_id": session_id},
        )


def cancel_prompt_suggestion(state: SuggestionState) -> None:
    """Cancel the in-flight side call, if any (a newer turn, a rotation, the forwarder's exit)."""
    task, state.task = state.task, None
    if task is not None and not task.done():
        task.cancel()


async def clear_prompt_suggestion(client: httpx.AsyncClient, *, state: SuggestionState) -> None:
    """
    A prompt was typed: cancel any call in flight and clear a posted suggestion.

    The web also clears on the turn's ``running`` edge; this covers a prompt
    typed in the terminal before that edge lands. Best effort, never raises.
    """
    cancel_prompt_suggestion(state)
    session_id, state.shown = state.shown, None
    if session_id is None or client.is_closed:
        return
    try:
        await post_suggestion(client, session_id=session_id, suggestion=None)
    except httpx.HTTPError:
        _logger.debug("prompt suggestion clear failed; session=%s", session_id, exc_info=True)


def schedule_prompt_suggestion(
    client: httpx.AsyncClient,
    *,
    session_id: str,
    transcript_path: Path | None,
    recorded_at: float | None,
    state: SuggestionState,
    last_assistant_message: str | None = None,
    bridge_dir: Path | None = None,
    env: Mapping[str, str] | None = None,
) -> None:
    """
    Start the side call for a turn that just ended, in the background.

    Called on the forwarder's hot path for the parent session's ``Stop`` hook,
    so it only checks the switch and the turn's age and creates a task; any
    older call still running is cancelled first.

    :param client: Omnigent HTTP client the forwarder posts with.
    :param session_id: Omnigent session/conversation id.
    :param transcript_path: Claude transcript path from the hook payload.
    :param recorded_at: Unix time the hook was recorded, when known.
    :param state: Per-forwarder suggestion state; mutated in place.
    :param last_assistant_message: The ``Stop`` payload's reply text, when sent.
    :param bridge_dir: The session's bridge dir, for the provider check.
    :param env: Environment to read the switch from (the process's own by default).
    """
    if not suggestions_enabled(env):
        return
    cancel_prompt_suggestion(state)
    if transcript_path is None and not last_assistant_message:
        return
    if recorded_at is not None and time.time() - recorded_at > MAX_TURN_AGE_S:
        return
    state.task = asyncio.create_task(
        _suggest(
            client,
            session_id=session_id,
            transcript_path=transcript_path,
            last_assistant_message=last_assistant_message,
            bridge_dir=bridge_dir,
            state=state,
        ),
        name=f"ae-prompt-suggest-{session_id}",
    )
