"""Tests for the cost carry that keeps a session total rising across Claude restarts."""

from __future__ import annotations

import ctypes
import fcntl
import json
import os
import subprocess
import threading
from pathlib import Path
from typing import Any

import httpx
import pytest

import omnigent.harnesses.claude_native.forwarder as forwarder
from omnigent.harnesses.claude_native import ae_cost_carry as carry_mod
from omnigent.harnesses.claude_native.ae_cost_carry import (
    CARRY_FILE,
    LOCK_FILE,
    CostCarry,
    carried_cost,
    carry_lock,
    load_carry,
    save_carry,
)
from omnigent.harnesses.claude_native.bridge import build_hook_settings
from omnigent.harnesses.claude_native.status import sync_raw_status_context


def _client(total: float | None, status: int = 200) -> tuple[httpx.AsyncClient, list[str]]:
    gets: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        gets.append(request.url.path)
        if status != 200:
            return httpx.Response(status, request=request)
        body = {} if total is None else {"total_cost_usd": total}
        return httpx.Response(200, json=body, request=request)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://ap"), gets


def _state(proc: str | None, cost: float = 0.0) -> dict[str, Any]:
    return {"total_cost_usd": cost, "ae_proc": f"{proc}-100"} if proc else {"total_cost_usd": cost}


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
    client, gets = _client(460.0)
    async with client:
        carry = load_carry(tmp_path, "conv_a")
        assert await carried_cost(
            client=client,
            carry=carry,
            bridge_dir=tmp_path,
            status_cost=2.0,
            status_state=_state("1"),
        ) == pytest.approx(460.0)
        assert await carried_cost(
            client=client,
            carry=carry,
            bridge_dir=tmp_path,
            status_cost=3.0,
            status_state=_state("1"),
        ) == pytest.approx(461.0)
        assert len(gets) == 2
        reloaded = load_carry(tmp_path, "conv_a")
        assert reloaded.seeded
        assert await carried_cost(
            client=client,
            carry=reloaded,
            bridge_dir=tmp_path,
            status_cost=0.4,
            status_state=_state("2"),
        ) == pytest.approx(461.4)
        assert len(gets) == 2


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
    box: dict[str, Any] = {"cost": 0.0, "pid": "1"}
    monkeypatch.setattr(
        forwarder, "read_claude_context_state", lambda _b: _state(box["pid"], box["cost"])
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
            box["pid"] = pid
            box["cost"] = cost
            await _forward(client, bridge, dedupe, parent)
    assert posted == pytest.approx([100.0, 102.0, 102.5, 103.5, 103.7])


def _tree_client(
    totals: dict[str, float], children: list[str], *, fail: str | None = None
) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/child_sessions"):
            body: dict[str, Any] = {
                "data": [{"id": cid} for cid in children],
                "has_more": False,
            }
        else:
            sid = path.rsplit("/", 1)[-1]
            if sid == fail:
                return httpx.Response(503, request=request)
            body = {"total_cost_usd": totals[sid]}
        return httpx.Response(200, json=body, request=request)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://ap")


@pytest.mark.asyncio
async def test_seed_subtracts_each_priced_child(tmp_path: Path) -> None:
    carry = load_carry(tmp_path, "lead")
    client = _tree_client({"lead": 50.0, "b1": 30.0, "b2": 13.0}, ["b1", "b2"])
    async with client:
        total = await carried_cost(
            client=client, carry=carry, bridge_dir=tmp_path, status_cost=1.0
        )
    assert total == pytest.approx(7.0)
    assert carry.offset == pytest.approx(6.0)


@pytest.mark.asyncio
async def test_seed_floors_own_total_at_zero(tmp_path: Path) -> None:
    carry = load_carry(tmp_path, "lead")
    client = _tree_client({"lead": 10.0, "b1": 30.0}, ["b1"])
    async with client:
        total = await carried_cost(
            client=client, carry=carry, bridge_dir=tmp_path, status_cost=2.0
        )
    assert total == pytest.approx(2.0)


@pytest.mark.asyncio
async def test_child_read_failure_posts_nothing_and_retries(tmp_path: Path) -> None:
    carry = load_carry(tmp_path, "lead")
    totals = {"lead": 50.0, "b1": 30.0, "b2": 13.0}
    async with _tree_client(totals, ["b1", "b2"], fail="b2") as client:
        assert (
            await carried_cost(client=client, carry=carry, bridge_dir=tmp_path, status_cost=1.0)
            is None
        )
    assert not carry.seeded
    assert not (tmp_path / CARRY_FILE).exists()
    carry.seed_retry_not_before = 0.0
    async with _tree_client(totals, ["b1", "b2"]) as client:
        total = await carried_cost(
            client=client, carry=carry, bridge_dir=tmp_path, status_cost=1.0
        )
    assert total == pytest.approx(7.0)


@pytest.mark.asyncio
async def test_lead_without_children_seeds_from_its_own_total(tmp_path: Path) -> None:
    carry = load_carry(tmp_path, "lead")
    async with _tree_client({"lead": 460.0}, []) as client:
        total = await carried_cost(
            client=client, carry=carry, bridge_dir=tmp_path, status_cost=2.0
        )
    assert total == pytest.approx(460.0)


# ---- review round 1 fixes -------------------------------------------------------------


def test_identity_and_cost_come_from_one_capture(tmp_path: Path) -> None:
    proc = tmp_path / "ae_context_proc"
    payload = {"context_window": {"context_window_size": 200000}, "cost": {"total_cost_usd": 4.0}}
    proc.write_text("123-456\n" + json.dumps(payload), encoding="utf-8")
    sync_raw_status_context(tmp_path, None)
    state = json.loads((tmp_path / "context.json").read_text(encoding="utf-8"))
    assert (state["ae_proc"], state["total_cost_usd"]) == ("123-456", 4.0)
    # A poll between two renders sees either the old pair or the new pair, never a mix.
    proc.write_text("999-1\n" + json.dumps(payload | {"cost": {"total_cost_usd": 0.1}}))
    os.utime(proc, ns=(proc.stat().st_mtime_ns + 5_000_000,) * 2)
    sync_raw_status_context(tmp_path, None)
    state = json.loads((tmp_path / "context.json").read_text(encoding="utf-8"))
    assert (state["ae_proc"], state["total_cost_usd"]) == ("999-1", 0.1)


def test_capture_without_identity_still_parses(tmp_path: Path) -> None:
    payload = {"context_window": {"context_window_size": 200000}, "cost": {"total_cost_usd": 4.0}}
    (tmp_path / "context_raw.json").write_text(json.dumps(payload), encoding="utf-8")
    sync_raw_status_context(tmp_path, None)
    state = json.loads((tmp_path / "context.json").read_text(encoding="utf-8"))
    assert "ae_proc" not in state and state["total_cost_usd"] == 4.0


@pytest.mark.skipif(not Path("/proc/self/stat").exists(), reason="needs /proc")
def test_shim_writes_starttime_even_when_the_command_name_has_parens(tmp_path: Path) -> None:
    libc = ctypes.CDLL(None)
    old = ctypes.create_string_buffer(16)
    libc.prctl(16, old)  # PR_GET_NAME
    libc.prctl(15, b"a) (b) c")  # PR_SET_NAME: comm with ") (" in it
    try:
        command = build_hook_settings(tmp_path)["statusLine"]["command"]
        subprocess.run(["sh", "-c", command], input=b'{"x": 1}', check=True, timeout=20)
        stat = Path("/proc/self/stat").read_text(encoding="utf-8")
        starttime = stat.rpartition(")")[2].split()[19]
        first, _, rest = (tmp_path / "ae_context_proc").read_text(encoding="utf-8").partition("\n")
        assert (tmp_path / "context_raw.json").read_text(encoding="utf-8") == '{"x": 1}'
    finally:
        libc.prctl(15, old.value)
    assert first == f"{os.getpid()}-{starttime}"
    assert rest == '{"x": 1}'


def test_unknown_proc_then_a_pid_with_a_fall_folds() -> None:
    carry = CostCarry("c", offset=5.0, last=8.0, seeded=True)
    carry.observe(0.5, "7-70")
    assert (carry.offset, carry.last, carry.proc) == (13.0, 0.5, "7-70")
    same = CostCarry("c", offset=5.0, last=8.0, seeded=True)
    same.observe(9.0, "7-70")
    assert (same.offset, same.last, same.proc) == (5.0, 9.0, "7-70")


@pytest.mark.asyncio
async def test_policy_figure_after_a_restart_is_the_carried_total(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    bridge = tmp_path / "bridge"
    bridge.mkdir()
    parent = tmp_path / "sess.jsonl"
    parent.write_text("parent", encoding="utf-8")
    monkeypatch.setattr(forwarder, "read_claude_context_state", lambda _b: _state("2", 0.5))
    dedupe = forwarder._ForwardDedupeState()
    dedupe.cost_carry = CostCarry(
        "conv_parent", offset=100.0, last=10.0, proc="1-100", seeded=True
    )
    posted: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        posted.append(json.loads(request.content)["data"])
        return httpx.Response(200, json={}, request=request)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://ap"
    ) as client:
        await _forward(client, bridge, dedupe, parent)
    assert posted[0]["cumulative_cost_usd"] == pytest.approx(110.5)
    assert posted[0]["policy_cost_usd"] == pytest.approx(110.5)


def _held(posted: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [p for p in posted if any(k.startswith("cumulative_") for k in p)]


@pytest.mark.asyncio
async def test_failed_seed_holds_tokens_and_backs_off(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    bridge = tmp_path / "bridge"
    bridge.mkdir()
    parent = tmp_path / "sess.jsonl"
    line = {
        "type": "assistant",
        "requestId": "r1",
        "message": {
            "id": "m1",
            "role": "assistant",
            "model": "claude-opus-4-8",
            "usage": {"input_tokens": 10, "output_tokens": 5},
        },
    }
    parent.write_text(json.dumps(line) + "\n", encoding="utf-8")
    monkeypatch.setattr(forwarder, "read_claude_context_state", lambda _b: _state("1", 3.0))
    clock = {"now": 1000.0}
    monkeypatch.setattr(carry_mod.time, "monotonic", lambda: clock["now"])
    dedupe = forwarder._ForwardDedupeState()
    gets: list[str] = []
    posted: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            gets.append(request.url.path)
            return httpx.Response(503, request=request)
        posted.append(json.loads(request.content)["data"])
        return httpx.Response(200, json={}, request=request)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://ap"
    ) as client:
        await _forward(client, bridge, dedupe, parent)
        assert gets and not _held(posted)
        tried = len(gets)
        await _forward(client, bridge, dedupe, parent)  # inside the backoff: no new read
        assert len(gets) == tried
        clock["now"] += 2.0
        await _forward(client, bridge, dedupe, parent)
        assert len(gets) > tried
        assert not _held(posted)  # tokens wait for a known cost


@pytest.mark.asyncio
async def test_tokens_post_with_the_cost_once_the_seed_recovers(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    bridge = tmp_path / "bridge"
    bridge.mkdir()
    parent = tmp_path / "sess.jsonl"
    line = {
        "type": "assistant",
        "requestId": "r1",
        "message": {
            "id": "m1",
            "role": "assistant",
            "model": "claude-opus-4-8",
            "usage": {"input_tokens": 10, "output_tokens": 5},
        },
    }
    parent.write_text(json.dumps(line) + "\n", encoding="utf-8")
    monkeypatch.setattr(forwarder, "read_claude_context_state", lambda _b: _state("1", 3.0))
    monkeypatch.setattr(carry_mod.time, "monotonic", lambda: 1000.0)
    dedupe = forwarder._ForwardDedupeState()
    up = {"ok": False}
    posted: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            if not up["ok"]:
                return httpx.Response(503, request=request)
            if request.url.path.endswith("/child_sessions"):
                body: dict[str, Any] = {"data": [], "has_more": False}
            else:
                body = {"total_cost_usd": 50.0}
            return httpx.Response(200, json=body, request=request)
        posted.append(json.loads(request.content)["data"])
        return httpx.Response(200, json={}, request=request)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://ap"
    ) as client:
        await _forward(client, bridge, dedupe, parent)
        assert not _held(posted)
        up["ok"] = True
        assert dedupe.cost_carry is not None
        dedupe.cost_carry.seed_retry_not_before = 0.0
        await _forward(client, bridge, dedupe, parent)
    final = [p for p in posted if "cumulative_cost_usd" in p]
    assert final[0]["cumulative_input_tokens"] == 10
    assert final[0]["cumulative_cost_usd"] == pytest.approx(50.0)


@pytest.mark.asyncio
async def test_adopt_never_steps_the_carry_back(tmp_path: Path) -> None:
    save_carry(tmp_path, CostCarry("c", offset=1.0, last=2.0, proc="1-1", seeded=True))
    carry = CostCarry("c", offset=10.0, last=5.0, proc="1-1", seeded=True)
    carry_mod._adopt_stored(tmp_path, carry)
    assert (carry.offset, carry.last) == (10.0, 5.0)
    save_carry(tmp_path, CostCarry("c", offset=20.0, last=1.0, proc="2-2", seeded=True))
    carry_mod._adopt_stored(tmp_path, carry)
    assert (carry.offset, carry.last, carry.proc) == (20.0, 1.0, "2-2")


@pytest.mark.asyncio
async def test_seed_reads_children_before_the_parent(tmp_path: Path) -> None:
    order: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        order.append(request.url.path)
        if request.url.path.endswith("/child_sessions"):
            return httpx.Response(200, json={"data": [{"id": "b1"}], "has_more": False})
        return httpx.Response(200, json={"total_cost_usd": 5.0})

    carry = load_carry(tmp_path, "lead")
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://ap"
    ) as client:
        await carried_cost(client=client, carry=carry, bridge_dir=tmp_path, status_cost=0.0)
    assert order == [
        "/v1/sessions/lead/child_sessions",
        "/v1/sessions/b1",
        "/v1/sessions/lead",
    ]


@pytest.mark.asyncio
async def test_seed_fails_when_the_child_list_hits_the_page_cap(tmp_path: Path) -> None:
    pages = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        pages["n"] += 1
        body = {"data": [{"id": f"c{pages['n']}"}], "has_more": True, "last_id": f"c{pages['n']}"}
        return httpx.Response(200, json=body)

    carry = load_carry(tmp_path, "lead")
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://ap"
    ) as client:
        result = await carried_cost(
            client=client, carry=carry, bridge_dir=tmp_path, status_cost=1.0
        )
    assert result is None and not carry.seeded and carry.seed_failures == 1
    assert pages["n"] == 20


@pytest.mark.asyncio
async def test_two_writers_never_lose_an_update(tmp_path: Path) -> None:
    carry_mod.save_carry(tmp_path, CostCarry("s", offset=0.0, last=1.0, proc="1-100", seeded=True))
    a = load_carry(tmp_path, "s")
    b = load_carry(tmp_path, "s")
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})), base_url="http://ap"
    ) as client:
        await carried_cost(
            client=client, carry=a, bridge_dir=tmp_path, status_cost=6.0, status_state=_state("1")
        )
        # b is stale (last=1.0 in memory); it must adopt a's 6.0 rather than overwrite it.
        total = await carried_cost(
            client=client, carry=b, bridge_dir=tmp_path, status_cost=3.0, status_state=_state("1")
        )
    assert total == pytest.approx(6.0)
    assert load_carry(tmp_path, "s").total() == pytest.approx(6.0)


def test_carry_lock_excludes_a_second_holder(tmp_path: Path) -> None:
    got_lock = threading.Event()
    with carry_lock(tmp_path):
        fd = os.open(tmp_path / LOCK_FILE, os.O_RDWR)
        try:
            with pytest.raises(BlockingIOError):
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(fd)

        def other() -> None:
            with carry_lock(tmp_path):
                got_lock.set()

        thread = threading.Thread(target=other)
        thread.start()
        assert not got_lock.wait(0.3)
    thread.join(5)
    assert got_lock.is_set()
