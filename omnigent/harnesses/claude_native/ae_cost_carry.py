"""
Carry a Claude-native session's cost across Claude restarts.

Claude Code's statusLine ``total_cost_usd`` (``S``) is per process: it restarts near
zero after every ``--resume``. The server keeps ``max(old, posted)``, so each new
process's spend vanished until its own ``S`` passed the old peak. This module turns the
per-process ``S`` into a session total: ``offset + last``, persisted in the bridge
directory as ``ae_cost_carry.json``.

Fold rule, keyed on process identity and never on a bare fall in ``S``:

* ``proc`` is the pid of the Claude process that rendered the statusLine. The statusLine
  shim writes ``<pid>-<start time>`` to ``ae_claude_pid`` before each capture, so the pid a reader
  sees is never older than the capture it pairs with. A relaunch is a new process and
  always a new pid; a ``/clear``, ``/compact`` or sub-agent run stays in one process.
* Same process: ``last = max(last, S)``. A lower read is stale or out of order and is
  ignored, never folded.
* New process: ``offset += last``, ``last = S``, ``proc = new``.
* The figure to post is ``offset + last``. It never decreases.
* No pid yet (Claude launched before the shim wrote it): nothing folds. The first pid
  seen is adopted without a fold.

Seeding, when no carry file exists for the session (first run after a deploy, a lost
bridge directory, a session moved host): ``offset = max(0, server_total - S)`` where
``server_total`` is the session's OWN total: its ``total_cost_usd`` from
``GET /v1/sessions/{id}`` (a subtree sum) minus the same figure for each direct child from
``GET /v1/sessions/{id}/child_sessions`` (a child's total already covers its descendants),
floored at zero. The ``max`` keeps the running process's ``S``, which the server may
already hold, from counting twice. A failed read, of any child too, posts nothing and is
retried on the next poll.

Rotation (``/clear`` or ``/fork`` to a new session id): a carry file written for another
session id starts a fresh carry for the new id, and the cost post is held until the
statusLine capture changes, so the old session's last ``S`` is never posted to the new one.
A first ``S`` of zero after the capture changes is a real value.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

_logger = logging.getLogger(__name__)

CARRY_FILE = "ae_cost_carry.json"
# Written by the statusLine shim: the pid of the Claude process that rendered the bar.
CLAUDE_PID_FILE = "ae_claude_pid"
_CONTEXT_FILE = "context.json"

_Sig = tuple[int, int]
# ``<pid>-<start time>``; the start time is empty when /proc is unreadable.
_PID_RE = re.compile(r"[0-9]+-[0-9]*")


@dataclass
class CostCarry:
    """
    One session's carried cost.

    :param session_id: Omnigent session the figures belong to, e.g. ``"conv_abc123"``.
    :param offset: Cost of every earlier Claude process, in USD.
    :param last: Highest ``S`` seen from the current process, in USD.
    :param proc: Identity of the current process, e.g. ``"48211-1763900000"``; ``None`` unknown.
    :param seeded: ``False`` until the offset has been set from the server.
    :param hold_sig: ``context.json`` signature to wait out after a rotation; ``None`` when
        nothing is held.
    """

    session_id: str
    offset: float = 0.0
    last: float = 0.0
    proc: str | None = None
    seeded: bool = False
    hold_sig: _Sig | None = None

    def total(self) -> float:
        """
        Return the session total to post.

        :returns: ``offset + last`` in USD.
        """
        return self.offset + self.last

    def seed(self, server_total: float | None, status_cost: float, proc: str | None) -> None:
        """
        Set the offset from the server's total and start tracking this process.

        :param server_total: ``total_cost_usd`` the server holds, or ``None`` when unpriced.
        :param status_cost: The running process's ``S``, e.g. ``2.5``.
        :param proc: Current process identity, or ``None``.
        """
        self.offset = max(0.0, (server_total or 0.0) - status_cost)
        self.last = status_cost
        self.proc = proc
        self.seeded = True

    def observe(self, status_cost: float, proc: str | None) -> None:
        """
        Fold one statusLine reading into the carry.

        :param status_cost: ``S`` from the capture, e.g. ``0.4``.
        :param proc: Pid of the process that rendered it, or ``None`` when unknown.
        """
        if proc is None or proc == self.proc:
            self.last = max(self.last, status_cost)
            return
        if self.proc is not None:
            self.offset += self.last
            self.last = status_cost
        else:
            self.last = max(self.last, status_cost)
        self.proc = proc

    def to_json(self) -> dict[str, Any]:
        """
        Serialize for the carry file.

        :returns: A JSON-ready dict.
        """
        return {
            "session_id": self.session_id,
            "offset": self.offset,
            "last": self.last,
            "proc": self.proc,
            "hold_sig": list(self.hold_sig) if self.hold_sig else None,
        }


def context_signature(bridge_dir: Path) -> _Sig | None:
    """
    Return ``(mtime_ns, size)`` of the statusLine capture.

    :param bridge_dir: Native Claude bridge directory.
    :returns: The signature, or ``None`` when no capture exists.
    """
    try:
        stat = (bridge_dir / _CONTEXT_FILE).stat()
    except OSError:
        return None
    return (stat.st_mtime_ns, stat.st_size)


def read_claude_pid(bridge_dir: Path) -> str | None:
    """
    Read the pid the statusLine shim recorded.

    :param bridge_dir: Native Claude bridge directory.
    :returns: The identity text, e.g. ``"48211-1763900000"``, or ``None`` when absent or malformed.
    """
    try:
        text = (bridge_dir / CLAUDE_PID_FILE).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text if _PID_RE.fullmatch(text) else None


def load_carry(bridge_dir: Path, session_id: str) -> CostCarry:
    """
    Load the carry for a session, or start an unseeded one.

    :param bridge_dir: Native Claude bridge directory.
    :param session_id: Omnigent session id, e.g. ``"conv_abc123"``.
    :returns: The stored carry when it belongs to *session_id*. A file for another session
        id means a rotation: an unseeded carry holding the cost post until the capture
        changes. A missing or corrupt file gives an unseeded carry with no hold.
    """
    try:
        raw = json.loads((bridge_dir / CARRY_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return CostCarry(session_id=session_id)
    if not isinstance(raw, dict):
        return CostCarry(session_id=session_id)
    if raw.get("session_id") != session_id:
        return CostCarry(session_id=session_id, hold_sig=context_signature(bridge_dir))
    offset, last = raw.get("offset"), raw.get("last")
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (offset, last)):
        return CostCarry(session_id=session_id)
    if offset < 0 or last < 0:
        return CostCarry(session_id=session_id)
    proc = raw.get("proc")
    hold = raw.get("hold_sig")
    hold_sig: _Sig | None = None
    if isinstance(hold, list) and len(hold) == 2 and all(isinstance(v, int) for v in hold):
        hold_sig = (hold[0], hold[1])
    return CostCarry(
        session_id=session_id,
        offset=float(offset),
        last=float(last),
        proc=proc if isinstance(proc, str) else None,
        seeded=True,
        hold_sig=hold_sig,
    )


def save_carry(bridge_dir: Path, carry: CostCarry) -> None:
    """
    Write the carry file atomically (temp file, then replace).

    :param bridge_dir: Native Claude bridge directory.
    :param carry: The carry to persist.
    """
    bridge_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=bridge_dir, prefix=f".{CARRY_FILE}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(carry.to_json(), handle)
        os.replace(tmp, bridge_dir / CARRY_FILE)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


async def _session_total(client: httpx.AsyncClient, session_id: str) -> float:
    """
    Read a session's ``total_cost_usd`` (its subtree total) from the server.

    :param client: Omnigent HTTP client.
    :param session_id: Omnigent session id, e.g. ``"conv_abc123"``.
    :returns: The total in USD; ``0.0`` when the session is unpriced.
    :raises httpx.HTTPError: When the read fails.
    """
    resp = await client.get(f"/v1/sessions/{session_id}")
    resp.raise_for_status()
    body = resp.json()
    value = body.get("total_cost_usd") if isinstance(body, dict) else None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return 0.0
    return float(value)


async def _child_ids(client: httpx.AsyncClient, session_id: str) -> list[str]:
    """
    List the ids of a session's direct child sessions.

    :param client: Omnigent HTTP client.
    :param session_id: Parent session id, e.g. ``"conv_abc123"``.
    :returns: Child ids, e.g. ``["conv_child1"]``.
    :raises httpx.HTTPError: When a read fails.
    """
    ids: list[str] = []
    after: str | None = None
    for _ in range(50):
        params: dict[str, str | int] = {"limit": 1000, "order": "asc"}
        if after:
            params["after"] = after
        resp = await client.get(f"/v1/sessions/{session_id}/child_sessions", params=params)
        resp.raise_for_status()
        body = resp.json()
        data = body.get("data") if isinstance(body, dict) else None
        ids.extend(
            c["id"] for c in data or [] if isinstance(c, dict) and isinstance(c.get("id"), str)
        )
        last = body.get("last_id") if isinstance(body, dict) else None
        if not (isinstance(body, dict) and body.get("has_more") and isinstance(last, str)):
            break
        after = last
    return ids


async def _own_total(client: httpx.AsyncClient, session_id: str) -> float:
    """
    Read the session's OWN cost: its subtree total minus its direct children's.

    Each child's total already covers its own descendants, so one level is enough.

    :param client: Omnigent HTTP client.
    :param session_id: Omnigent session id, e.g. ``"conv_abc123"``.
    :returns: The own total in USD, floored at ``0.0``.
    :raises httpx.HTTPError: When any read fails, so nothing is seeded from a partial sum.
    """
    subtree = await _session_total(client, session_id)
    children = sum(
        [await _session_total(client, cid) for cid in await _child_ids(client, session_id)]
    )
    return max(0.0, subtree - children)


async def carried_cost(
    *,
    client: httpx.AsyncClient,
    carry: CostCarry,
    bridge_dir: Path,
    status_cost: float | None,
) -> float | None:
    """
    Turn this poll's ``S`` into the session total to post, persisting the carry.

    :param client: Omnigent HTTP client, used once to seed.
    :param carry: The session's carry, mutated in place.
    :param bridge_dir: Native Claude bridge directory.
    :param status_cost: ``S`` from the statusLine capture, or ``None`` when absent.
    :returns: ``offset + last`` in USD, or ``None`` when there is nothing to post yet: no
        ``S``, a rotation hold still waiting for a fresh capture, or a failed seed read
        (retried next poll).
    """
    if status_cost is None:
        return None
    before = carry.to_json()
    if carry.hold_sig is not None:
        if context_signature(bridge_dir) == carry.hold_sig:
            return None
        carry.hold_sig = None
    proc = read_claude_pid(bridge_dir)
    if carry.seeded:
        carry.observe(status_cost, proc)
    else:
        try:
            total = await _own_total(client, carry.session_id)
        except (httpx.HTTPError, ValueError):
            _logger.warning(
                "Could not read the session total to seed the cost carry; session=%s",
                carry.session_id,
                exc_info=True,
            )
            return None
        carry.seed(total, status_cost, proc)
    if carry.to_json() != before or not (bridge_dir / CARRY_FILE).exists():
        try:
            save_carry(bridge_dir, carry)
        except OSError:
            _logger.warning(
                "Could not save the cost carry; session=%s", carry.session_id, exc_info=True
            )
    return carry.total()
