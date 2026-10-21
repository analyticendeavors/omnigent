"""
Predict the user's next prompt after each finished Claude turn.

Claude Code has its own prompt suggestions, but only in print/SDK mode; the
interactive TUI that OmniGent runs in tmux never draws one on screen or
writes one to the transcript, so there is nothing to relay. Instead, when the
forwarder sees a turn's ``Stop`` hook, this module reads the turn's last user
prompt and last reply and hands them to the shared side call
(:mod:`omnigent.harnesses.ae_prompt_suggest_core`), which posts the one-line
answer as a transient ``external_session_suggestion`` event.

The call runs on the account the session's terminal runs on: the host's
default login, or a named account's token, resolved as the launch resolves it
and passed in the call's environment only. Sessions on a gateway, Bedrock or
Vertex, sub-agent sessions and turns waiting on the user get none. Off unless
``AE_PROMPT_SUGGESTIONS=1``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Final

import httpx

from omnigent.harnesses.ae_prompt_suggest_core import (
    _WORKDIR_PREFIX,
    CLAUDE_PATH_ENV_VAR,
    ENABLE_ENV_VAR,
    MAX_CONTEXT_CHARS,
    MAX_PROMPT_CHARS,
    MAX_TURN_AGE_S,
    SuggestionState,
    TurnContext,
    account_login_env,
    build_side_call_prompt,
    cancel_prompt_suggestion,
    clean_suggestion,
    clear_prompt_suggestion,
    copy_login,
    is_child_session,
    post_suggestion,
    run_side_call,
    side_call_argv,
    side_call_env,
    suggest_and_post,
    suggestions_enabled,
    uses_default_provider,
)
from omnigent.harnesses.claude_native.transcript_filters import is_request_log_record
from omnigent.util.ae_session_suggestion import MAX_SUGGESTION_CHARS

__all__ = [
    "CLAUDE_PATH_ENV_VAR",
    "ENABLE_ENV_VAR",
    "MAX_CONTEXT_CHARS",
    "MAX_PROMPT_CHARS",
    "MAX_SUGGESTION_CHARS",
    "MAX_TURN_AGE_S",
    "_WORKDIR_PREFIX",
    "SuggestionState",
    "TurnContext",
    "build_side_call_prompt",
    "cancel_prompt_suggestion",
    "clean_suggestion",
    "clear_prompt_suggestion",
    "copy_login",
    "post_suggestion",
    "read_turn_context",
    "run_side_call",
    "schedule_prompt_suggestion",
    "session_login_env",
    "side_call_argv",
    "side_call_env",
    "suggestions_enabled",
    "uses_default_provider",
]

_logger = logging.getLogger(__name__)

# Only the transcript's tail is read; one turn's prompt and reply fit in it.
TAIL_BYTES: Final = 512 * 1024
# The account sidecar the session's statusLine shim writes from the terminal's
# own OMNIGENT_CLAUDE_ACCOUNT on every render: empty for the default login, the
# account name for a named one (status.CLAUDE_ACCOUNT_FILE).
_BRIDGE_ACCOUNT_FILE: Final = "claude_account"


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


def session_account(bridge_dir: Path | None) -> str | None:
    """
    The Claude account the session's terminal runs on.

    The terminal's statusLine shim records its own ``OMNIGENT_CLAUDE_ACCOUNT``
    in the bridge dir's ``claude_account`` before every render, so the file
    names the account the running terminal uses. The forwarder's environment
    cannot say: the launch blanks the inherited name and sets the account in
    the terminal's environment only.

    :param bridge_dir: The session's bridge dir, when known.
    :returns: ``""`` for the default login, the account name (e.g.
        ``"AE Backup"`` or ``"shared:Team"``), or ``None`` when the file is
        missing (no render yet) or unreadable.
    """
    if bridge_dir is None:
        return None
    try:
        return (bridge_dir / _BRIDGE_ACCOUNT_FILE).read_text("utf-8").strip()
    except OSError:
        return None


def _account_file_stamp(bridge_dir: Path | None) -> tuple[int, int, int] | None:
    """The ``claude_account`` file's identity and change time, or ``None`` when missing."""
    if bridge_dir is None:
        return None
    try:
        st = (bridge_dir / _BRIDGE_ACCOUNT_FILE).stat()
    except OSError:
        return None
    return (st.st_ino, st.st_mtime_ns, st.st_size)


def session_login_env(
    bridge_dir: Path | None, state: SuggestionState | None = None
) -> dict[str, str] | None:
    """
    The side call's login environment for this session's account.

    The account name and the provider verdict are read once per forwarder and
    again only when the ``claude_account`` file changes (cached on ``state``);
    the token itself is resolved on every call and never cached.

    :param bridge_dir: The session's bridge dir, when known.
    :param state: Per-forwarder suggestion state holding the cache, if any.
    :returns: ``{}`` for the default login, the named account's token
        environment (:func:`account_login_env`), or ``None`` to skip: the
        account is unknown yet or cannot be resolved on this host.
    """
    stamp = _account_file_stamp(bridge_dir)
    if state is not None and stamp is not None and state.account_key == stamp:
        account = state.account
    else:
        account = session_account(bridge_dir)
        if state is not None:
            state.account, state.account_key = account, stamp
            state.provider_ok = None  # the account changed: check the provider again
    if account is None:
        _logger.debug("prompt suggestion skipped: the session's Claude account is not known yet")
        return None
    return account_login_env(account)


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
        if await is_child_session(client, session_id, state) is not False:
            return
        context = await asyncio.to_thread(
            read_turn_context, transcript_path, last_assistant_message
        )
        if context is None:
            return
        # A shared account's token comes from the server, so resolve off the loop.
        login_env = await asyncio.to_thread(session_login_env, bridge_dir, state)
        if login_env is None:
            return
        if state.provider_ok is None:
            state.provider_ok = await asyncio.to_thread(uses_default_provider, bridge_dir)
        if not state.provider_ok:
            _logger.debug(
                "prompt suggestion skipped: session is not on the default Anthropic provider"
            )
            return
        await suggest_and_post(
            client, session_id=session_id, context=context, state=state, login_env=login_env
        )
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 - a suggestion is best effort and must not hurt forwarding
        _logger.debug(
            "prompt suggestion failed; session=%s",
            session_id,
            exc_info=True,
            extra={"session_id": session_id},
        )


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
    :param bridge_dir: The session's bridge dir, for the provider and account checks.
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
