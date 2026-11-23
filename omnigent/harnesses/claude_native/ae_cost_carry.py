"""
Carry a Claude-native session's cost across Claude restarts.

Claude Code's statusLine ``total_cost_usd`` (``S``) is per process: it restarts near
zero after every ``--resume``. The server keeps ``max(old, posted)``, so each new
process's spend vanished until its own ``S`` passed the old peak. This module turns the
per-process ``S`` into a session total: ``offset + last``, persisted in the bridge
directory as ``ae_cost_carry.json``.

Fold rule, keyed on process identity and never on a bare fall in ``S``:

* ``proc`` is ``<pid>-<starttime>`` of the Claude process that rendered the statusLine
  (field 22 of ``/proc/<pid>/stat``, read after the last ``)`` because the command name may
  hold spaces). The statusLine shim writes it as the first line of the same atomically
  written capture as ``S`` (``context_raw.json``); ``sync_raw_status_context`` copies it to
  ``context.json`` as ``ae_proc``. Identity and cost therefore come from one read and can
  never be paired across two renders. A relaunch is a new process; a ``/clear``,
  ``/compact`` or sub-agent run stays in one.
* Same process: ``last = max(last, S)``. A lower read is stale or out of order and is
  ignored, never folded.
* New process: ``offset += last``, ``last = S``, ``proc = new``.
* The figure to post is ``offset + last``. It never decreases.
* The carry has no ``proc`` yet (state from before the shim wrote one): the first
  identity seen is a restart when ``S`` is below ``last`` (folded) and is adopted without
  a fold otherwise. A capture with no identity never folds.

Seeding, when no carry file exists for the session (first run after a deploy, a lost
bridge directory, a session moved host): ``offset = max(0, own - S)``. ``own`` is the
session's own total: the direct children's ``total_cost_usd`` values are read first (from
``GET /v1/sessions/{id}/child_sessions``, then one ``GET /v1/sessions/{id}`` each; a
child's total already covers its descendants), then the session's own subtree total, and
the sum of the children is subtracted, floored at zero. Reading children first means a
child that grows in between can only make ``own`` slightly high, never low. Only
``sub_agent`` sessions have a parent, so the child list is every direct child; native
sub-agents have no usage and read as zero. The ``max`` keeps the running process's ``S``,
which the server may already hold, from counting twice. A failed or timed-out read, a child's
included, or a child list past the page cap, posts no cost and backs the seed off
(1 s, doubling to 30 s); tokens still post without a cost meanwhile.

Rotation (``/clear`` or ``/fork`` to a new session id): a carry file written for another
session id starts a fresh carry for the new id, and the cost post is held until the
statusLine capture changes, so the old session's last ``S`` is never posted to the new one.
A first ``S`` of zero after the capture changes is a real value.

Writers: load, modify and save happen under an ``flock`` on ``ae_cost_carry.lock``, and a
writer adopts what another one stored before it folds, so two forwarders on one bridge
directory cannot lose an update.

Known limits: macOS has no ``/proc``, so identity there is the pid alone (a reused pid
would hide a relaunch); a stale render right after ``/clear`` can end the rotation hold
early.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import tempfile
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from omnigent.harnesses.claude_native.status import PROC_ID_RE

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows has no flock
    fcntl = None  # type: ignore[assignment]

_logger = logging.getLogger(__name__)

CARRY_FILE = "ae_cost_carry.json"
LOCK_FILE = "ae_cost_carry.lock"
_CONTEXT_FILE = "context.json"
# Each seed read is bounded, and so is the whole seed, so a slow server cannot stall a poll.
_READ_TIMEOUT_S = 5.0
_SEED_TIMEOUT_S = 15.0
_CHILD_PAGE_LIMIT = 1000
_CHILD_PAGE_CAP = 20

_Sig = tuple[int, int]


class _SeedError(Exception):
    """The session's own total could not be read in full."""


@dataclass
class CostCarry:
    """
    One session's carried cost.

    :param session_id: Omnigent session the figures belong to, e.g. ``"conv_abc123"``.
    :param offset: Cost of every earlier Claude process, in USD.
    :param last: Highest ``S`` seen from the current process, in USD.
    :param proc: Identity of the current process, e.g. ``"48211-1763900000"``; ``None``
        unknown.
    :param seeded: ``False`` until the offset has been set from the server.
    :param hold_sig: ``context.json`` signature to wait out after a rotation; ``None`` when
        nothing is held.
    :param seed_failures: Consecutive failed seed reads (memory only).
    :param seed_retry_not_before: ``time.monotonic()`` before which no seed read is made.
    """

    session_id: str
    offset: float = 0.0
    last: float = 0.0
    proc: str | None = None
    seeded: bool = False
    hold_sig: _Sig | None = None
    seed_failures: int = 0
    seed_retry_not_before: float = 0.0

    def total(self) -> float:
        """
        Return the session total to post.

        :returns: ``offset + last`` in USD.
        """
        return self.offset + self.last

    def seed(self, server_total: float | None, status_cost: float, proc: str | None) -> None:
        """
        Set the offset from the session's own total and start tracking this process.

        :param server_total: The session's own total in USD, or ``None`` when unpriced.
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
        :param proc: Identity of the process that rendered it, or ``None`` when unknown.
        """
        if proc is None or proc == self.proc:
            self.last = max(self.last, status_cost)
            return
        if self.proc is not None or status_cost < self.last:
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


def proc_from_state(status_state: dict[str, Any] | None) -> str | None:
    """
    Read the process identity from a ``context.json`` record.

    :param status_state: Parsed ``context.json``, or ``None``.
    :returns: The identity, e.g. ``"48211-1763900000"``, or ``None`` when absent or malformed.
    """
    value = status_state.get("ae_proc") if isinstance(status_state, dict) else None
    return value if isinstance(value, str) and PROC_ID_RE.fullmatch(value) else None


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


@contextlib.contextmanager
def carry_lock(bridge_dir: Path) -> Iterator[None]:
    """
    Hold the exclusive carry lock for one load-modify-save.

    :param bridge_dir: Native Claude bridge directory.
    :yields: Nothing, while the lock is held. Without ``fcntl`` (Windows) nothing is held.
    """
    if fcntl is None:
        yield
        return
    bridge_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(bridge_dir / LOCK_FILE, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


async def _session_total(client: httpx.AsyncClient, session_id: str) -> float:
    """
    Read a session's ``total_cost_usd`` (its subtree total) from the server.

    :param client: Omnigent HTTP client.
    :param session_id: Omnigent session id, e.g. ``"conv_abc123"``.
    :returns: The total in USD; ``0.0`` when the session is unpriced.
    :raises httpx.HTTPError: When the read fails.
    """
    resp = await client.get(f"/v1/sessions/{session_id}", timeout=_READ_TIMEOUT_S)
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
    :raises _SeedError: When the list runs past the page cap, so it would be partial.
    """
    ids: list[str] = []
    after: str | None = None
    for _ in range(_CHILD_PAGE_CAP):
        params: dict[str, str | int] = {"limit": _CHILD_PAGE_LIMIT, "order": "asc"}
        if after:
            params["after"] = after
        resp = await client.get(
            f"/v1/sessions/{session_id}/child_sessions", params=params, timeout=_READ_TIMEOUT_S
        )
        resp.raise_for_status()
        body = resp.json()
        if not isinstance(body, dict):
            raise _SeedError("child list was not an object")
        for child in body.get("data") or []:
            if isinstance(child, dict) and isinstance(child.get("id"), str):
                ids.append(child["id"])
        last = body.get("last_id")
        if not body.get("has_more"):
            return ids
        if not isinstance(last, str):
            raise _SeedError("child list has more pages but no cursor")
        after = last
    raise _SeedError("child list passed the page cap")


async def _own_total(client: httpx.AsyncClient, session_id: str) -> float:
    """
    Read the session's OWN cost: its subtree total minus its direct children's.

    Children are read first, so a child that grows during the read can only make the
    result slightly high. Each child's total already covers its own descendants.

    :param client: Omnigent HTTP client.
    :param session_id: Omnigent session id, e.g. ``"conv_abc123"``.
    :returns: The own total in USD, floored at ``0.0``.
    :raises httpx.HTTPError: When any read fails, so nothing is seeded from a partial sum.
    :raises _SeedError: When the child list is partial.
    """
    children = 0.0
    for child_id in await _child_ids(client, session_id):
        children += await _session_total(client, child_id)
    return max(0.0, await _session_total(client, session_id) - children)


def _adopt_stored(bridge_dir: Path, carry: CostCarry) -> None:
    """
    Take over figures another writer saved for this session.

    :param bridge_dir: Native Claude bridge directory.
    :param carry: The in-memory carry, updated in place when a seeded one is on disk.
    """
    stored = load_carry(bridge_dir, carry.session_id)
    if stored.seeded:
        carry.offset, carry.last, carry.proc, carry.seeded = (
            stored.offset,
            stored.last,
            stored.proc,
            True,
        )


async def carried_cost(
    *,
    client: httpx.AsyncClient,
    carry: CostCarry,
    bridge_dir: Path,
    status_cost: float | None,
    status_state: dict[str, Any] | None = None,
) -> float | None:
    """
    Turn this poll's ``S`` into the session total to post, persisting the carry.

    :param client: Omnigent HTTP client, used to seed.
    :param carry: The session's carry, mutated in place.
    :param bridge_dir: Native Claude bridge directory.
    :param status_cost: ``S`` from the statusLine capture, or ``None`` when absent.
    :param status_state: The ``context.json`` record ``S`` came from; its ``ae_proc`` is the
        identity read together with ``S``.
    :returns: ``offset + last`` in USD, or ``None`` when there is nothing to post yet: no
        ``S``, a rotation hold still waiting for a fresh capture, or a seed that is backing
        off or failed (retried with a growing delay).
    """
    if status_cost is None:
        return None
    if carry.hold_sig is not None:
        if context_signature(bridge_dir) == carry.hold_sig:
            return None
        carry.hold_sig = None
    proc = proc_from_state(status_state)
    own: float | None = None
    if not carry.seeded:
        if time.monotonic() < carry.seed_retry_not_before:
            return None
        try:
            own = await asyncio.wait_for(_own_total(client, carry.session_id), _SEED_TIMEOUT_S)
        except (httpx.HTTPError, ValueError, TimeoutError, _SeedError):
            carry.seed_failures += 1
            delay = min(30.0, float(2 ** min(carry.seed_failures - 1, 5)))
            carry.seed_retry_not_before = time.monotonic() + delay
            _logger.warning(
                "Could not read the session's own total to seed the cost carry; session=%s "
                "retry_in=%.0fs",
                carry.session_id,
                delay,
                exc_info=True,
            )
            return None
        carry.seed_failures = 0
        carry.seed_retry_not_before = 0.0
    try:
        with carry_lock(bridge_dir):
            _adopt_stored(bridge_dir, carry)
            before, was_seeded = carry.to_json(), carry.seeded
            if carry.seeded:
                carry.observe(status_cost, proc)
            else:
                carry.seed(own, status_cost, proc)
            if (
                carry.seeded != was_seeded
                or carry.to_json() != before
                or not (bridge_dir / CARRY_FILE).exists()
            ):
                save_carry(bridge_dir, carry)
    except OSError:
        _logger.warning(
            "Could not save the cost carry; session=%s", carry.session_id, exc_info=True
        )
    return carry.total()
