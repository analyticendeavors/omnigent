"""
Relay Claude Code's live spinner line to the web chat.

While Claude streams one long tool call (a Write of a 400-line file, say), the
transcript stays silent until the call finishes, so the web chat had nothing to
show but a generic "Working" row. The terminal meanwhile shows a spinner line
such as ``✻ Crunching… (4m 42s · ↓ 24.5k tokens)``. The forwarder already
captures the pane every couple of seconds; this module parses that line from
the capture and posts it as a transient ``external_session_progress`` event.
"""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Literal

import httpx

from omnigent.util.ae_session_progress import (
    EXTERNAL_SESSION_PROGRESS_TYPE,
    MAX_ELAPSED_CHARS,
    MAX_ELAPSED_S,
    MAX_LABEL_CHARS,
    MAX_TOKENS_CHARS,
)

_logger = logging.getLogger(__name__)

# A steady spinner is re-posted this often so the web knows it is still live
# (the web drops a line that has not been refreshed for 30 seconds).
PROGRESS_REFRESH_S: Final = 10.0

# How far above the input box the spinner may sit (todo rows render under it).
_SCAN_LINES_ABOVE_BOX = 25

# Claude Code's spinner, drawn at column 0: one glyph, one capitalized word
# ending in an ellipsis, then a parenthesized group that opens with the elapsed
# time. Transcript text is indented, so an echoed spinner line cannot match.
SPINNER_LINE_RE = re.compile(
    r"^[·✢✳✶✻✽*∗] "
    r"(?P<label>[A-Z][a-z]+(?:-[a-z]+)*'?)(?:…|\.\.\.) "
    r"\((?P<elapsed>(?:(?P<h>\d+)h(?: (?P<hm>\d+)m)?(?: (?P<hs>\d+)s)?)"
    r"|(?:(?P<m>\d+)m(?: (?P<ms>\d+)s)?)|(?:(?P<s>\d+)s))"
    r"(?P<rest>(?: · [^()]*)?)\)"
)
_TOKENS_SEGMENT_RE = re.compile(r"^(?:[↑↓] ?)?(?P<tokens>\d[\d,]*(?:\.\d+)?[kKmM]? tokens)$")


@dataclass(frozen=True)
class PaneProgress:
    """
    The live spinner line Claude Code draws while a turn is generating.

    :param label: The spinner's verb, e.g. ``"Crunching"``.
    :param elapsed: Elapsed text as drawn, e.g. ``"4m 42s"``.
    :param elapsed_s: The same elapsed time in seconds, e.g. ``282``.
    :param tokens: Token text without its arrow, e.g. ``"24.5k tokens"``, or
        ``None`` when the line shows no count.
    """

    label: str
    elapsed: str
    elapsed_s: int
    tokens: str | None = None


# The capture could not tell whether a spinner shows (it failed, no input box
# is on screen, or the /btw overlay covers the region). Never posted or cleared.
PROGRESS_UNKNOWN: Final = "unknown"
PaneProgressRead = PaneProgress | Literal["unknown"] | None


def _group_int(match: re.Match[str], *names: str) -> int:
    """Sum of the named numeric groups that matched, e.g. hours or minutes."""
    return sum(int(match.group(name)) for name in names if match.group(name) is not None)


def progress_from_line(line: str) -> PaneProgress | None:
    """
    Parse one pane line as a Claude Code spinner line.

    :param line: A single captured pane line, e.g.
        ``"✻ Crunching… (4m 42s · ↓ 24.5k tokens)"``.
    :returns: The parsed progress, or ``None`` for any other wording.
    """
    match = SPINNER_LINE_RE.match(line.rstrip())
    if match is None:
        return None
    label = match.group("label")
    elapsed = match.group("elapsed")
    elapsed_s = (
        _group_int(match, "h") * 3600
        + _group_int(match, "hm", "m") * 60
        + _group_int(match, "hs", "ms", "s")
    )
    if len(label) > MAX_LABEL_CHARS or len(elapsed) > MAX_ELAPSED_CHARS:
        return None
    if elapsed_s > MAX_ELAPSED_S:
        return None
    tokens: str | None = None
    for segment in match.group("rest").split(" · "):
        found = _TOKENS_SEGMENT_RE.match(segment.strip())
        if found is not None and len(found.group("tokens")) <= MAX_TOKENS_CHARS:
            tokens = found.group("tokens")
            break
    return PaneProgress(label=label, elapsed=elapsed, elapsed_s=elapsed_s, tokens=tokens)


def progress_from_pane(
    pane: str,
    *,
    find_box_opener: Callable[[list[str]], int | None],
    btw_overlay_shown: Callable[[str], bool],
) -> PaneProgressRead:
    """
    Find the live spinner line in a captured pane.

    The spinner sits just above the input box, so the scan starts at the box's
    opening rule and walks up a bounded window.

    :param pane: Captured pane text; ``""`` when the capture failed.
    :param find_box_opener: The bridge's input-box locator, given the pane's
        non-blank lines.
    :param btw_overlay_shown: The bridge's ``/btw`` overlay test.
    :returns: The newest spinner line's progress, ``None`` when no spinner
        shows, or :data:`PROGRESS_UNKNOWN` when the pane cannot tell.
    """
    if not pane.strip() or btw_overlay_shown(pane):
        return PROGRESS_UNKNOWN
    lines = [line for line in pane.splitlines() if line.strip()]
    end = find_box_opener(lines)
    if end is None:
        return PROGRESS_UNKNOWN
    for line in reversed(lines[max(0, end - _SCAN_LINES_ABOVE_BOX) : end]):
        progress = progress_from_line(line)
        if progress is not None:
            return progress
    return None


@dataclass
class ProgressRelayState:
    """
    What the relay last delivered for one session.

    :param posted: The last progress posted, or ``None`` when nothing is shown
        (never posted, or the clear was delivered).
    :param posted_at: Monotonic time of that post, ``0.0`` before any.
    """

    posted: PaneProgress | None = None
    posted_at: float = 0.0


async def post_external_session_progress(
    client: httpx.AsyncClient,
    *,
    session_id: str,
    progress: PaneProgress | None,
) -> None:
    """
    Post one transient ``external_session_progress`` event.

    :param client: Omnigent HTTP client.
    :param session_id: Omnigent session/conversation id, e.g. ``"conv_abc123"``.
    :param progress: The spinner to show, or ``None`` to clear it.
    :raises httpx.HTTPError: If the Omnigent request fails or is rejected.
    """
    data: dict[str, str | int | None]
    if progress is None:
        data = {"label": None}
    else:
        data = {
            "label": progress.label,
            "elapsed": progress.elapsed,
            "elapsed_s": progress.elapsed_s,
            "tokens": progress.tokens,
        }
    resp = await client.post(
        f"/v1/sessions/{session_id}/events",
        json={"type": EXTERNAL_SESSION_PROGRESS_TYPE, "data": data},
    )
    resp.raise_for_status()


def _is_due(progress: PaneProgress | None, state: ProgressRelayState, now: float) -> bool:
    """Whether this read differs from the last post, or a steady line needs a refresh."""
    posted = state.posted
    if progress is None or posted is None:
        return progress != posted
    if (progress.label, progress.tokens) != (posted.label, posted.tokens):
        return True
    return progress != posted and now - state.posted_at >= PROGRESS_REFRESH_S


async def relay_progress(
    client: httpx.AsyncClient,
    *,
    session_id: str,
    progress: PaneProgressRead,
    state: ProgressRelayState,
) -> None:
    """
    Post the pane's spinner line when it changed, or refresh a steady one.

    A new label or token count posts at once; an elapsed-only change posts at
    most every :data:`PROGRESS_REFRESH_S`, since the web ticks the elapsed time
    itself. A spinner that disappears posts one clear; an unknown read posts
    nothing. Best effort: a failed POST leaves ``state`` untouched so the next
    poll retries, and never raises.

    :param client: Omnigent HTTP client.
    :param session_id: Omnigent session/conversation id.
    :param progress: This poll's read of the pane.
    :param state: Per-session relay state; mutated in place.
    """
    if progress == PROGRESS_UNKNOWN:
        return
    now = time.monotonic()
    if not _is_due(progress, state, now):
        return
    try:
        await post_external_session_progress(client, session_id=session_id, progress=progress)
    except httpx.HTTPError:
        _logger.debug(
            "external_session_progress post failed; session=%s",
            session_id,
            exc_info=True,
            extra={"session_id": session_id},
        )
        return
    state.posted = progress
    state.posted_at = now


async def clear_progress_on_rotation(
    client: httpx.AsyncClient,
    *,
    old_session_id: str,
    state: ProgressRelayState,
) -> None:
    """
    Clear a spinner line left on a session that ``/clear`` or ``/fork`` rotated away.

    The forwarder drops its dedupe state on rotation, so without this the old
    conversation would keep the last line it was sent. Best effort, never raises.

    :param client: Omnigent HTTP client.
    :param old_session_id: The superseded session/conversation id.
    :param state: The old session's relay state.
    """
    if state.posted is None:
        return
    await relay_progress(client, session_id=old_session_id, progress=None, state=state)
