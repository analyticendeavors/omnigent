"""
The prompt-suggestion side call every native harness shares.

After a finished turn a harness forwarder hands this module the turn's last
user prompt and last reply; it makes one small side call
(``claude -p --model haiku``) and posts up to three ranked one-line answers as
a transient ``external_session_suggestion`` event that the web composer shows
as ghost text, best first. The Claude forwarder (``claude_native/ae_prompt_suggest.py``) and the
Codex forwarder (``codex_native/ae_prompt_suggest.py``) each own only how they
see a turn end and read its text; the call, its isolation, its login, the trim
to clean lines, cancel and the event post live here once.

The side call is isolated from everything the session itself uses: no hooks
(a ``Stop`` hook firing from it would start another call, for ever), no
settings files, no MCP servers, no tools, no session transcript, no OmniGent
environment, and a temporary cwd and Claude config dir of its own, so it never
writes the user's ``~/.claude.json``. It runs as a background task so
forwarding never waits on it, at most one per session; a newer turn, a typed
prompt and the forwarder's own exit all cancel a call still in flight and kill
its process group. It runs only on Claude's own login (no gateway, Bedrock or
Vertex): the host's default login, or for a Claude session on a named account,
that account's token, passed in the environment only. Off unless
``AE_PROMPT_SUGGESTIONS=1``.
"""

from __future__ import annotations

import asyncio
import contextlib
import difflib
import json
import logging
import os
import re
import shutil
import signal
import tempfile
import time
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final

import httpx

from omnigent.util.ae_session_suggestion import (
    EXTERNAL_SESSION_SUGGESTION_TYPE,
    MAX_SUGGESTION_CHARS,
    MAX_SUGGESTIONS,
)

_logger = logging.getLogger(__name__)

ENABLE_ENV_VAR: Final = "AE_PROMPT_SUGGESTIONS"
CLAUDE_PATH_ENV_VAR: Final = "OMNIGENT_CLAUDE_PATH"
SIDE_CALL_MODEL: Final = "haiku"
SIDE_CALL_TIMEOUT_S: Final = 15.0
# Characters of conversation the side call sees: the prompt's head, the reply's tail.
MAX_CONTEXT_CHARS: Final = 2000
MAX_PROMPT_CHARS: Final = 600
# A turn end older than this (a forwarder catching up after a restart) is not
# a turn the user is looking at now.
MAX_TURN_AGE_S: Final = 120.0
NONE_REPLY: Final = "NONE"
# A copied login must stay valid this long, so the side call never refreshes
# it (a refresh would rotate the token the user's own sessions hold).
MIN_TOKEN_LIFETIME_S: Final = 600.0

SYSTEM_PROMPT: Final = (
    "You predict the next message a user will type to their coding assistant. "
    "You get the user's last message and the assistant's reply. Answer with up to "
    f"{MAX_SUGGESTIONS} clearly different likely next messages, most likely first, "
    "one per line, each in the user's own voice and style and at most "
    f"{MAX_SUGGESTION_CHARS} characters, with no numbering, no quotes and no "
    "explanation. Give fewer lines rather than weak ones. If no next message is "
    f"clearly likely, answer {NONE_REPLY}."
)
# Two guesses this alike (difflib ratio, case-folded) count as one, unless the
# words they differ in carry a digit or an identifier ("PR 121" vs "PR 122").
DUPLICATE_RATIO: Final = 0.85
_IDENTIFIER_RE: Final = re.compile(r"[\d_./]")
# A list marker the model may add despite the prompt: "1.", "2)", "-", "*", "•".
_LIST_MARKER_RE: Final = re.compile(r"^(?:\d+[.)]|[-*•])\s+")

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
# A raw ANTHROPIC_API_KEY bills the API instead of the login, so it skips too.
_PROVIDER_ENV_KEYS: Final = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
)
# A Claude session's own settings file in its bridge dir (claude_native/bridge.py).
_BRIDGE_SETTINGS_FILE: Final = "claude-settings.json"


@dataclass
class SuggestionState:
    """
    Per-forwarder state for the prompt-suggestion side call.

    :param task: The in-flight side call, or ``None`` when none runs.
    :param is_child: Per session id, whether it is a sub-agent session (cached
        after one lookup; sub-agent sessions get no suggestions).
    :param shown: Session id whose composer may still show a posted
        suggestion, so a typed prompt can clear it.
    :param provider_ok: The cached :func:`uses_default_provider` verdict,
        ``None`` until first checked.
    :param account: The cached account name the call runs on (``None`` for the
        host's active account, ``""`` for the default login).
    :param account_key: What the cached account was read from (a Claude
        session's ``claude_account`` file stamp), so a change re-reads it.
    """

    task: asyncio.Task[None] | None = None
    is_child: dict[str, bool] = field(default_factory=dict)
    shown: str | None = None
    provider_ok: bool | None = None
    account: str | None = None
    account_key: object = None


@dataclass(frozen=True)
class TurnContext:
    """
    What the side call sees of the finished turn.

    :param user_prompt: The user's last message, e.g. ``"fix the failing test"``,
        or ``""`` when the forwarder did not see it.
    :param assistant_text: The assistant's last reply text.
    """

    user_prompt: str
    assistant_text: str


def suggestions_enabled(env: Mapping[str, str] | None = None) -> bool:
    """Whether ``AE_PROMPT_SUGGESTIONS`` switches the feature on (``1``, ``true`` or ``yes``)."""
    value = (os.environ if env is None else env).get(ENABLE_ENV_VAR, "")
    return value.strip().lower() in {"1", "true", "yes"}


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


def _is_none(raw: str) -> bool:
    return raw.strip().strip("\"'`“”‘’").rstrip(".").upper() == NONE_REPLY


def _clean_line(raw: str) -> str | None:
    """One output line without list marker or wrapping quotes, cut at a word to the bound."""
    line = _LIST_MARKER_RE.sub("", raw.strip())
    line = line.strip("\"'`“”‘’").strip()
    # A bracketed aside is the model explaining itself, not a guess.
    if not line or line.startswith(("(", "[")):
        return None
    if len(line) > MAX_SUGGESTION_CHARS:
        cut = line[:MAX_SUGGESTION_CHARS]
        space = cut.rfind(" ")
        line = (cut[:space] if space > MAX_SUGGESTION_CHARS // 2 else cut).rstrip(" ,;:")
    return line or None


def _is_near_duplicate(line: str, kept: list[str]) -> bool:
    folded = line.casefold()
    words = set(folded.rstrip(".!?").split())
    for other in kept:
        other_folded = other.casefold()
        if difflib.SequenceMatcher(None, folded, other_folded).ratio() < DUPLICATE_RATIO:
            continue
        differing = words ^ set(other_folded.rstrip(".!?").split())
        if not any(_IDENTIFIER_RE.search(word) for word in differing):
            return True
    return False


def clean_suggestions(raw: str) -> list[str]:
    """
    The ranked suggestions to show, from the side call's raw output.

    :param raw: Everything the side call printed, one guess per line.
    :returns: Up to :data:`MAX_SUGGESTIONS` lines in the model's order, each
        without list marker or wrapping quotes and cut at a word boundary to
        :data:`MAX_SUGGESTION_CHARS`; near duplicates of an earlier line and
        bracketed asides dropped. Reading stops at a ``NONE`` line, so ``NONE``
        first, or empty output, gives none.
    """
    kept: list[str] = []
    for raw_line in raw.splitlines():
        if _is_none(raw_line):
            break
        line = _clean_line(raw_line)
        if line is None or _is_near_duplicate(line, kept):
            continue
        kept.append(line)
        if len(kept) == MAX_SUGGESTIONS:
            break
    return kept


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


def account_login_env(account: str | None) -> dict[str, str] | None:
    """
    The environment that puts the side call on a Claude account.

    Resolved through :func:`omnigent.onboarding.claude_accounts.account_env_for_launch`,
    the call the terminal launch makes (``claude_native/main.py``), so the side
    call gets what a terminal launched now would get, provider-conflict check
    included: a host account's token from this host's secrets, a shared
    account's (``shared:<name>``) from the server. The token stays in the
    returned mapping, which the caller hands to the side call's environment
    only; it is never logged and never written to a file.

    :param account: The account name, e.g. ``"AE Backup"``; ``""`` for the
        CLI's own default login; ``None`` for the host's active account (what a
        terminal launched without a choice gets).
    :returns: ``{}`` for the default login, the account's environment
        (``CLAUDE_CODE_OAUTH_TOKEN`` with ``ANTHROPIC_API_KEY`` and
        ``ANTHROPIC_AUTH_TOKEN`` blanked) for a named one, or ``None`` when the
        account cannot be resolved.
    """
    try:
        from omnigent.onboarding.claude_accounts import account_env_for_launch

        resolved = account_env_for_launch(dict(os.environ), account_name=account)
    except Exception as exc:  # noqa: BLE001 - an unresolvable account skips the call
        # The type only: an account error never carries the token, but say nothing more.
        _logger.debug(
            "prompt suggestion skipped: Claude account %r is unavailable (%s)",
            account,
            type(exc).__name__,
        )
        return None
    if resolved and not resolved.get(_OAUTH_TOKEN_ENV_VAR, "").strip():
        _logger.debug("prompt suggestion skipped: Claude account %r has no token", account)
        return None
    return resolved


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


async def run_side_call(
    prompt: str,
    *,
    timeout_s: float = SIDE_CALL_TIMEOUT_S,
    login_env: Mapping[str, str] | None = None,
) -> list[str]:
    """
    Run one isolated ``claude -p`` call and return its cleaned answers.

    :param prompt: The side call's user message.
    :param timeout_s: Seconds before the call is killed.
    :param login_env: The account's login environment from
        :func:`account_login_env`, layered over this process's; ``None`` or
        ``{}`` keeps the default login.
    :returns: The ranked suggestions, or ``[]`` on ``NONE``, a failure, a
        timeout or no usable login.
    :raises asyncio.CancelledError: When a newer turn cancels the call; the
        process group is killed first.
    """
    claude_bin = _claude_binary()
    if claude_bin is None:
        _logger.debug("prompt suggestion skipped: no claude binary on PATH")
        return []
    base = {**os.environ, **(login_env or {})}
    with _side_call_dirs() as (cwd, config_dir):
        if not copy_login(config_dir, env=base):
            _logger.debug("prompt suggestion skipped: no login valid for the next 10 minutes")
            return []
        proc = await asyncio.create_subprocess_exec(
            *side_call_argv(claude_bin),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            cwd=cwd,
            env=side_call_env(base, config_dir=config_dir),
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
                return []
            raise
    if proc.returncode != 0:
        _logger.debug("prompt suggestion side call exited %s", proc.returncode)
        return []
    return clean_suggestions(stdout.decode("utf-8", errors="replace"))


def uses_default_provider(bridge_dir: Path | None, env: Mapping[str, str] | None = None) -> bool:
    """
    Whether the side call would run on Claude's own login against Anthropic's API.

    False when this process's environment or a Claude session's settings file
    names a gateway, Bedrock, Vertex or Foundry, or an ``apiKeyHelper``, or
    when the host's claude-native launch config or managed settings resolve
    one; then the side call would bill or reach somewhere else.

    :param bridge_dir: A Claude session's bridge dir, when known (``None`` for
        other harnesses, which have no Claude settings file).
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


async def is_child_session(
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
    client: httpx.AsyncClient, *, session_id: str, suggestions: list[str] | None
) -> None:
    """
    Post one transient ``external_session_suggestion`` event.

    ``data.suggestion`` repeats the top guess, so a page loaded before the
    list existed still shows it.

    :param client: Omnigent HTTP client.
    :param session_id: Omnigent session/conversation id, e.g. ``"conv_abc123"``.
    :param suggestions: The ranked predicted prompts, best first, or ``None``
        to clear them.
    :raises httpx.HTTPError: If the request fails or is rejected.
    """
    data = (
        {"suggestion": suggestions[0], "suggestions": suggestions}
        if suggestions
        else {
            "suggestion": None,
            "suggestions": None,
        }
    )
    resp = await client.post(
        f"/v1/sessions/{session_id}/events",
        json={"type": EXTERNAL_SESSION_SUGGESTION_TYPE, "data": data},
    )
    resp.raise_for_status()


async def suggest_and_post(
    client: httpx.AsyncClient,
    *,
    session_id: str,
    context: TurnContext,
    state: SuggestionState,
    login_env: Mapping[str, str] | None = None,
) -> None:
    """
    Run the side call for one turn and post its answers, if any.

    The caller has applied its own skip rules. Raises only on cancel or a
    failed post; each harness's task wrapper logs the latter.
    """
    suggestions = await run_side_call(build_side_call_prompt(context), login_env=login_env)
    if not suggestions or client.is_closed:
        return
    # Marked first, so a cancel while the POST is in flight still gets its clear.
    state.shown = session_id
    await post_suggestion(client, session_id=session_id, suggestions=suggestions)


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
        await post_suggestion(client, session_id=session_id, suggestions=None)
    except httpx.HTTPError:
        _logger.debug("prompt suggestion clear failed; session=%s", session_id, exc_info=True)
