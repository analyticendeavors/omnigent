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
from collections.abc import Callable
from dataclasses import dataclass

import httpx

_logger = logging.getLogger(__name__)

EXTERNAL_SESSION_PROGRESS_TYPE = "external_session_progress"

# Same bounds the server enforces, so a parse the server would reject is dropped here.
MAX_LABEL_CHARS = 40
MAX_ELAPSED_CHARS = 20
MAX_TOKENS_CHARS = 30

# How far above the input box the spinner may sit (todo rows render under it).
_SCAN_LINES_ABOVE_BOX = 25

# Claude Code's spinner, drawn at column 0: one glyph, one capitalized word
# ending in an ellipsis, then a parenthesized group that opens with the elapsed
# time. Transcript text is indented, so an echoed spinner line cannot match.
SPINNER_LINE_RE = re.compile(
    r"^[·✢✳✶✻✽*∗] "
    r"(?P<label>[A-Z][a-z]+(?:-[a-z]+)*'?)(?:…|\.\.\.) "
    r"\((?P<elapsed>\d+h(?: \d+m)?(?: \d+s)?|\d+m(?: \d+s)?|\d+s)"
    r"(?P<rest>(?: · [^()]*)?)\)"
)
_TOKENS_SEGMENT_RE = re.compile(r"^(?:[↑↓] ?)?(?P<tokens>\d[\d,]*(?:\.\d+)?[kKmM]? tokens)$")


@dataclass(frozen=True)
class PaneProgress:
    """
    The live spinner line Claude Code draws while a turn is generating.

    :param label: The spinner's verb, e.g. ``"Crunching"``.
    :param elapsed: Elapsed text as drawn, e.g. ``"4m 42s"``.
    :param tokens: Token text without its arrow, e.g. ``"24.5k tokens"``, or
        ``None`` when the line shows no count.
    """

    label: str
    elapsed: str
    tokens: str | None = None


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
    if len(label) > MAX_LABEL_CHARS or len(elapsed) > MAX_ELAPSED_CHARS:
        return None
    tokens: str | None = None
    for segment in match.group("rest").split(" · "):
        found = _TOKENS_SEGMENT_RE.match(segment.strip())
        if found is not None and len(found.group("tokens")) <= MAX_TOKENS_CHARS:
            tokens = found.group("tokens")
            break
    return PaneProgress(label=label, elapsed=elapsed, tokens=tokens)


def progress_from_pane(pane: str, is_box_rule: Callable[[str], bool]) -> PaneProgress | None:
    """
    Find the live spinner line in a captured pane.

    The spinner sits just above the input box, so the scan starts at the box's
    opening rule and walks up a bounded window. With no box on screen the
    pane's tail is scanned instead.

    :param pane: Captured pane text.
    :param is_box_rule: The bridge's input-box rule test.
    :returns: The newest spinner line's progress, or ``None`` when none shows.
    """
    lines = [line for line in pane.splitlines() if line.strip()]
    rules = [i for i, line in enumerate(lines) if is_box_rule(line)]
    end = rules[-2] if len(rules) >= 2 else (rules[-1] if rules else len(lines))
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
    """

    posted: PaneProgress | None = None


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
    data: dict[str, str | None]
    if progress is None:
        data = {"label": None}
    else:
        data = {"label": progress.label, "elapsed": progress.elapsed, "tokens": progress.tokens}
    resp = await client.post(
        f"/v1/sessions/{session_id}/events",
        json={"type": EXTERNAL_SESSION_PROGRESS_TYPE, "data": data},
    )
    resp.raise_for_status()


async def relay_progress(
    client: httpx.AsyncClient,
    *,
    session_id: str,
    progress: PaneProgress | None,
    state: ProgressRelayState,
) -> None:
    """
    Post the pane's spinner line when it changed since the last delivery.

    A spinner that disappears posts one clear. Best effort: a failed POST
    leaves ``state`` untouched so the next poll retries, and never raises.

    :param client: Omnigent HTTP client.
    :param session_id: Omnigent session/conversation id.
    :param progress: The spinner parsed from this poll's capture, or ``None``.
    :param state: Per-session relay state; mutated in place.
    """
    if progress == state.posted:
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
