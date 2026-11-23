"""Tests for the cost carry that keeps a session total rising across Claude restarts."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx
import pytest

import omnigent.harnesses.claude_native.forwarder as forwarder
from omnigent.harnesses.claude_native import ae_cost_carry as carry_mod
from omnigent.harnesses.claude_native.ae_cost_carry import (
    CARRY_FILE,
    CLAUDE_PID_FILE,
    CostCarry,
    carried_cost,
    load_carry,
)


def _client(total: float | None, status: int = 200) -> tuple[httpx.AsyncClient, list[str]]:
    gets: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        gets.append(request.url.path)
        if status != 200:
            return httpx.Response(status, request=request)
        body = {} if total is None else {"total_cost_usd": total}
        return httpx.Response(200, json=body, request=request)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://ap"), gets


def _set_pid(bridge: Path, pid: str) -> None:
    (bridge / CLAUDE_PID_FILE).write_text(f"{pid}-100", encoding="utf-8")


def _touch_context(bridge: Path, text: str) -> None:
    path = bridge / "context.json"
    path.write_text(text, encoding="utf-8")
    stamp = path.stat().st_mtime_ns + 1_000_000
    os.utime(path, ns=(stamp, stamp))


def test_same_process_lower_read_is_ignored() -> None:
    carry = CostCarry("c", seeded=True, proc="1-100")
    carry.observe(3.0, "1-100")
    carry.observe(1.0, "1-100")
    assert (carry.offset, carry.last, carry.total()) == (0.0, 3.0, 3.0)


def test_new_process_folds_once_and_restarts_sum() -> None:
    carry = CostCarry("c", seeded=True, proc="1-100")
    carry.observe(5.0, "1-100")
    carry.observe(0.5, "2-200")
    assert carry.total() == pytest.approx(5.5)
    carry.observe(2.0, "2-200")
    carry.observe(0.1, "3-300")
    assert carry.offset == pytest.approx(7.0)
    assert carry.total() == pytest.approx(7.1)


def test_alternating_readers_with_one_process_never_grow_the_offset() -> None:
    carry = CostCarry("c", seeded=True, proc="1-100")
    for value in (4.0, 1.0, 4.5, 0.0, 4.5):
        carry.observe(value, "1-100")
    assert carry.offset == 0.0
    assert carry.total() == pytest.approx(4.5)


def test_unknown_process_never_folds_and_first_pid_is_adopted() -> None:
    carry = CostCarry("c", seeded=True)
    carry.observe(2.0, None)
    carry.observe(0.5, None)
    carry.observe(2.5, "9-900")
    assert (carry.offset, carry.proc, carry.total()) == (0.0, "9-900", 2.5)
    carry.observe(0.2, None)
    assert carry.proc == "9-900"
    assert carry.total() == pytest.approx(2.5)


def test_seed_never_double_counts_the_running_process() -> None:
    low = CostCarry("c")
    low.seed(460.0, 2.0, "1-1")
    assert low.total() == pytest.approx(460.0)
    high = CostCarry("c")
    high.seed(1.0, 2.0, "1-1")
    assert high.total() == pytest.approx(2.0)
    unpriced = CostCarry("c")
    unpriced.seed(None, 2.0, "1-1")
    assert unpriced.total() == pytest.approx(2.0)


@pytest.mark.asyncio
async def test_missing_file_seeds_from_server_then_survives_reload(tmp_path: Path) -> None:
    _set_pid(tmp_path, "1")
    client, gets = _client(460.0)
    async with client:
        carry = load_carry(tmp_path, "conv_a")
        assert await carried_cost(
            client=client, carry=carry, bridge_dir=tmp_path, status_cost=2.0
        ) == pytest.approx(460.0)
        assert await carried_cost(
            client=client, carry=carry, bridge_dir=tmp_path, status_cost=3.0
        ) == pytest.approx(461.0)
        assert len(gets) == 1
        reloaded = load_carry(tmp_path, "conv_a")
        assert reloaded.seeded
        _set_pid(tmp_path, "2")
        assert await carried_cost(
            client=client, carry=reloaded, bridge_dir=tmp_path, status_cost=0.4
        ) == pytest.approx(461.4)
        assert len(gets) == 1


@pytest.mark.asyncio
async def test_failed_seed_posts_nothing_and_retries(tmp_path: Path) -> None:
    carry = load_carry(tmp_path, "conv_a")
    client, _ = _client(None, status=503)
    async with client:
        assert (
            await carried_cost(client=client, carry=carry, bridge_dir=tmp_path, status_cost=1.0)
            is None
        )
    assert not carry.seeded
    assert not (tmp_path / CARRY_FILE).exists()


def test_corrupt_file_starts_unseeded(tmp_path: Path) -> None:
    (tmp_path / CARRY_FILE).write_text("{not json", encoding="utf-8")
    assert not load_carry(tmp_path, "conv_a").seeded
    (tmp_path / CARRY_FILE).write_text(
        json.dumps({"session_id": "conv_a", "offset": -1, "last": 2}), encoding="utf-8"
    )
    assert not load_carry(tmp_path, "conv_a").seeded


@pytest.mark.asyncio
async def test_rotation_holds_cost_until_the_capture_changes(tmp_path: Path) -> None:
    _touch_context(tmp_path, '{"total_cost_usd": 9}')
    carry_mod.save_carry(tmp_path, CostCarry("conv_old", offset=1.0, last=8.0, seeded=True))
    carry = load_carry(tmp_path, "conv_new")
    assert carry.hold_sig is not None and not carry.seeded
    client, gets = _client(0.0)
    async with client:
        held = await carried_cost(client=client, carry=carry, bridge_dir=tmp_path, status_cost=9.0)
        assert held is None and gets == []
        _touch_context(tmp_path, '{"total_cost_usd": 0}')
        fresh = await carried_cost(
            client=client, carry=carry, bridge_dir=tmp_path, status_cost=0.0
        )
    assert fresh == 0.0
    assert load_carry(tmp_path, "conv_new").seeded


def _forward(client: httpx.AsyncClient, bridge: Path, dedupe: Any, parent: Path) -> Any:
    return forwarder._forward_session_cost(
        client=client,
        session_id="conv_parent",
        bridge_dir=bridge,
        parent_transcript_path=parent,
        subagent_state=forwarder.SubagentForwardState(subagents={}),
        dedupe=dedupe,
        cost_cache={},
    )


@pytest.mark.asyncio
async def test_forwarder_restart_sequence_posts_a_rising_total(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    bridge = tmp_path / "bridge"
    bridge.mkdir()
    parent = tmp_path / "sess.jsonl"
    parent.write_text("parent", encoding="utf-8")
    box = {"cost": 0.0}
    monkeypatch.setattr(
        forwarder, "read_claude_context_state", lambda _b: {"total_cost_usd": box["cost"]}
    )
    dedupe = forwarder._ForwardDedupeState()
    posted: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json={"total_cost_usd": 100.0}, request=request)
        data = json.loads(request.content)["data"]
        if "cumulative_cost_usd" in data:
            posted.append(data["cumulative_cost_usd"])
        return httpx.Response(200, json={}, request=request)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://ap"
    ) as client:
        for pid, cost in (("1", 10.0), ("1", 12.0), ("2", 0.5), ("2", 1.5), ("3", 0.2)):
            _set_pid(bridge, pid)
            box["cost"] = cost
            await _forward(client, bridge, dedupe, parent)
    assert posted == pytest.approx([100.0, 102.0, 102.5, 103.5, 103.7])
