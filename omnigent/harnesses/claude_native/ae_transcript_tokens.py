"""
Session token totals read from a Claude transcript (omnigent-ae, 2026-10-24).

Claude Code's statusLine reports dollars but no session token total, so the
forwarder tallies tokens from the transcript itself: the parent transcript plus
every ``subagents/agent-*.jsonl`` beside it, the same subtree the cost covers.
Each API response is counted once per ``requestId`` (the last record wins), and
files are read incrementally so a long session is not re-parsed every poll.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

# (input incl. cache, output, cache reads), the shape the server's cumulative fields take.
Totals = tuple[int, int, int]
_ZERO: Totals = (0, 0, 0)
_CHUNK = 1 << 20


@dataclass
class _FileTally:
    """Parse position of one transcript file."""

    identity: tuple[int, int]
    offset: int = 0


def _int(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _tokens_of(entry: dict[str, object]) -> Totals | None:
    message = entry.get("message")
    if not isinstance(message, dict) or message.get("role") != "assistant":
        return None
    usage = message.get("usage")
    if not isinstance(usage, dict) or not isinstance(usage.get("input_tokens"), int):
        return None
    cache_read = _int(usage.get("cache_read_input_tokens"))
    total_in = (
        _int(usage.get("input_tokens"))
        + _int(usage.get("cache_creation_input_tokens"))
        + cache_read
    )
    return (total_in, _int(usage.get("output_tokens")), cache_read)


class TranscriptTokenTally:
    """
    Incremental token totals for one forwarded Claude session.

    One map keyed by ``requestId`` spans every file and every parent path, last
    record wins, so a resumed transcript that replays old requests, a request
    written to two files, or a re-read file never counts twice.
    """

    def __init__(self) -> None:
        self._files: dict[Path, _FileTally] = {}
        self._entries: dict[str, Totals] = {}
        self._totals: Totals = _ZERO
        self._high: Totals = _ZERO
        # Lines handed to the JSON parser; lets tests prove old bytes are not re-read.
        self.lines_parsed = 0

    def update(self, parent: Path) -> Totals:
        """
        Read new transcript bytes and return the session's token totals.

        :param parent: Parent transcript, e.g. ``".../projects/x/<session>.jsonl"``.
        :returns: ``(input including cache, output, cache reads)``, never lower
            than a previous return.
        """
        self._read(parent, include_sidechains=False)
        try:
            sub_paths = sorted((parent.with_suffix("") / "subagents").glob("agent-*.jsonl"))
        except OSError:
            sub_paths = []
        for path in sub_paths:
            self._read(path, include_sidechains=True)
        # The clamp is a guard only; the keyed map already never loses a request.
        self._high = (
            max(self._high[0], self._totals[0]),
            max(self._high[1], self._totals[1]),
            max(self._high[2], self._totals[2]),
        )
        return self._high

    def _set(self, key: str, tokens: Totals) -> None:
        old = self._entries.get(key, _ZERO)
        self._entries[key] = tokens
        self._totals = (
            self._totals[0] + tokens[0] - old[0],
            self._totals[1] + tokens[1] - old[1],
            self._totals[2] + tokens[2] - old[2],
        )

    def _read(self, path: Path, *, include_sidechains: bool) -> None:
        try:
            stat = path.stat()
        except OSError:
            return
        identity = (stat.st_dev, stat.st_ino)
        tally = self._files.get(path)
        # A shrunk or replaced file restarts from byte 0; its old entries stay
        # in the map and are overwritten by the same requestIds.
        if tally is None or tally.identity != identity or stat.st_size < tally.offset:
            tally = _FileTally(identity=identity)
            self._files[path] = tally
        if stat.st_size == tally.offset:
            return
        try:
            with path.open("rb") as handle:
                handle.seek(tally.offset)
                carry = b""
                while chunk := handle.read(_CHUNK):
                    data = carry + chunk
                    end = data.rfind(b"\n")
                    if end < 0:
                        carry = data
                        continue
                    carry = data[end + 1 :]
                    self._lines(path, tally, data[: end + 1], include_sidechains)
        except OSError:
            return

    def _lines(
        self, path: Path, tally: _FileTally, block: bytes, include_sidechains: bool
    ) -> None:
        """Count the whole lines in ``block`` (which starts at ``tally.offset``)."""
        position = tally.offset
        for raw in block.split(b"\n")[:-1]:
            line_start = position
            position += len(raw) + 1
            if not raw.strip():
                continue
            self.lines_parsed += 1
            try:
                entry = json.loads(raw)
            except ValueError:
                # Includes a bad byte (UnicodeDecodeError); skip the line.
                continue
            if not isinstance(entry, dict):
                continue
            if not include_sidechains and entry.get("isSidechain") is True:
                continue
            tokens = _tokens_of(entry)
            if tokens is None:
                continue
            request_id = entry.get("requestId")
            key = (
                request_id
                if isinstance(request_id, str) and request_id
                else f"{path}@{line_start}"
            )
            self._set(key, tokens)
        tally.offset = position
