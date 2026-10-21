"""The host-wide ``gh auth status`` cache in :mod:`omnigent.runner._ae_gh_auth_cache`."""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import pytest

from omnigent.runner import _ae_gh_auth_cache as cache
from omnigent.runner import github_resource

_OK: tuple[bool, list[dict[str, Any]]] = (
    True,
    [{"login": "octo", "active": True, "state": "success", "host": "github.com"}],
)


@pytest.fixture(autouse=True)
def _cache_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Enable the cache (the root conftest turns it off) in a private cache and gh dir."""
    monkeypatch.setenv("OMNIGENT_GH_AUTH_CACHE_SECONDS", "60")
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    gh_dir = tmp_path / "gh"
    gh_dir.mkdir()
    (gh_dir / "hosts.yml").write_text("github.com:\n    user: octo\n", encoding="utf-8")
    monkeypatch.setenv("GH_CONFIG_DIR", str(gh_dir))
    for name in (*cache._TOKEN_VARS, "IS_SANDBOX", "GH_HOST"):
        monkeypatch.delenv(name, raising=False)
    return gh_dir


class _Counter:
    def __init__(self, *values: tuple[bool, list[dict[str, Any]]]) -> None:
        self.values = list(values)
        self.calls = 0

    def __call__(self) -> tuple[bool, list[dict[str, Any]]]:
        self.calls += 1
        return self.values[min(self.calls, len(self.values)) - 1]


def test_second_read_is_a_hit() -> None:
    compute = _Counter(_OK)
    assert cache.cached_accounts(compute) == _OK
    assert cache.cached_accounts(compute) == _OK
    assert compute.calls == 1


def test_list_accounts_runs_gh_auth_status_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[list[str]] = []

    def fake_gh(argv: list[str], *, cwd: str, token: str | None = None) -> tuple[int, str, str]:
        calls.append(argv)
        hosts = (
            '{"hosts": {"github.com": [{"login": "octo", "active": true, "state": "success"}]}}'
        )
        return 0, hosts, ""

    monkeypatch.setattr(github_resource, "_gh", fake_gh)
    first = github_resource._list_accounts(str(tmp_path))
    second = github_resource._list_accounts(str(tmp_path))
    assert first == second
    assert first[0] is True
    assert first[1][0]["login"] == "octo"
    assert calls == [["auth", "status", "--json", "hosts"]]


def test_entry_expires_after_ttl(monkeypatch: pytest.MonkeyPatch) -> None:
    compute = _Counter(_OK)
    now = time.time()
    monkeypatch.setattr(cache.time, "time", lambda: now)
    cache.cached_accounts(compute)
    monkeypatch.setattr(cache.time, "time", lambda: now + 59)
    cache.cached_accounts(compute)
    assert compute.calls == 1
    monkeypatch.setattr(cache.time, "time", lambda: now + 61)
    cache.cached_accounts(compute)
    assert compute.calls == 2


def test_entry_from_the_future_is_stale(monkeypatch: pytest.MonkeyPatch) -> None:
    compute = _Counter(_OK)
    now = time.time()
    monkeypatch.setattr(cache.time, "time", lambda: now)
    cache.cached_accounts(compute)
    monkeypatch.setattr(cache.time, "time", lambda: now - 30)
    cache.cached_accounts(compute)
    assert compute.calls == 2


@pytest.mark.parametrize(
    "failure",
    [
        (False, []),
        (False, [{"login": "octo", "active": True, "state": "error", "host": "github.com"}]),
    ],
    ids=["gh-failed-or-logged-out", "token-invalid"],
)
def test_failure_is_never_cached(failure: tuple[bool, list[dict[str, Any]]]) -> None:
    compute = _Counter(failure, failure, _OK)
    assert cache.cached_accounts(compute) == failure
    assert cache.cached_accounts(compute) == failure
    assert compute.calls == 2
    assert cache.cached_accounts(compute) == _OK
    assert compute.calls == 3


def test_non_finite_ttl_uses_the_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OMNIGENT_GH_AUTH_CACHE_SECONDS", "nan")
    assert cache.ttl_seconds() == cache._DEFAULT_TTL_SECONDS
    monkeypatch.setenv("OMNIGENT_GH_AUTH_CACHE_SECONDS", "inf")
    assert cache.ttl_seconds() == cache._DEFAULT_TTL_SECONDS


def test_ttl_zero_turns_the_cache_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OMNIGENT_GH_AUTH_CACHE_SECONDS", "0")
    compute = _Counter(_OK)
    cache.cached_accounts(compute)
    cache.cached_accounts(compute)
    assert compute.calls == 2


def test_login_change_misses(_cache_env: Path) -> None:
    compute = _Counter(_OK)
    cache.cached_accounts(compute)
    hosts = _cache_env / "hosts.yml"
    hosts.write_text("github.com:\n    user: someone-else\n", encoding="utf-8")
    cache.cached_accounts(compute)
    assert compute.calls == 2


def test_token_variables_key_the_entry(monkeypatch: pytest.MonkeyPatch) -> None:
    compute = _Counter(_OK)
    cache.cached_accounts(compute)
    monkeypatch.setenv("GH_TOKEN", "token-a")
    cache.cached_accounts(compute)
    monkeypatch.setenv("GH_TOKEN", "token-b")
    cache.cached_accounts(compute)
    assert compute.calls == 3
    monkeypatch.setenv("GH_TOKEN", "token-a")
    cache.cached_accounts(compute)
    assert compute.calls == 3


def test_sandbox_ignores_token_variables(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("IS_SANDBOX", "1")
    compute = _Counter(_OK)
    cache.cached_accounts(compute)
    monkeypatch.setenv("GH_TOKEN", "ambient")
    cache.cached_accounts(compute)
    assert compute.calls == 1


def test_entry_holds_no_token(_cache_env: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GH_TOKEN", "secret-token-value")
    cache.cached_accounts(_Counter(_OK))
    entries = list((Path(cache._cache_dir())).glob("gh-auth-status-*.json"))
    assert len(entries) == 1
    assert "secret-token-value" not in entries[0].read_text(encoding="utf-8")


@pytest.mark.parametrize(
    ("result", "dropped"),
    [
        ((1, "", "HTTP 401: Bad credentials (https://api.github.com/graphql)"), True),
        ((4, "", "To get started with GitHub CLI, please run:  gh auth login"), True),
        ((1, "", "no pull requests found for branch"), False),
        ((None, "", "timed out"), False),
        ((0, "ok", ""), False),
    ],
    ids=["bad-credentials", "logged-out", "other-failure", "timeout", "success"],
)
def test_auth_failure_invalidates(result: tuple[int | None, str, str], dropped: bool) -> None:
    compute = _Counter(_OK)
    cache.cached_accounts(compute)
    cache.note_gh_result(result)
    cache.cached_accounts(compute)
    assert compute.calls == (2 if dropped else 1)


@pytest.mark.posix_only
def test_concurrent_miss_runs_gh_once() -> None:
    started = threading.Event()
    calls = 0

    def slow() -> tuple[bool, list[dict[str, Any]]]:
        nonlocal calls
        calls += 1
        started.set()
        time.sleep(0.3)
        return _OK

    results: list[tuple[bool, list[dict[str, Any]]]] = []
    first = threading.Thread(target=lambda: results.append(cache.cached_accounts(slow)))
    first.start()
    assert started.wait(5)
    # The second reader blocks on the first one's lock and reads its answer.
    results.append(cache.cached_accounts(slow))
    first.join(5)
    assert calls == 1
    assert results == [_OK, _OK]


@pytest.mark.posix_only
def test_lock_wait_is_capped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cache, "_LOCK_WAIT_SECONDS", 0.1)
    release = threading.Event()
    started = threading.Event()

    def stuck() -> tuple[bool, list[dict[str, Any]]]:
        started.set()
        release.wait(5)
        return _OK

    holder = threading.Thread(target=lambda: cache.cached_accounts(stuck))
    holder.start()
    assert started.wait(5)
    fallback = _Counter(_OK)
    try:
        assert cache.cached_accounts(fallback) == _OK
        assert fallback.calls == 1
    finally:
        release.set()
        holder.join(5)


def test_failure_with_an_explicit_token_keeps_the_entry() -> None:
    compute = _Counter(_OK)
    cache.cached_accounts(compute)
    cache.note_gh_result((1, "", "HTTP 401: Bad credentials"), token="selected-account")
    cache.cached_accounts(compute)
    assert compute.calls == 1


def test_invalidation_during_a_fill_wins() -> None:
    def revoked_while_running() -> tuple[bool, list[dict[str, Any]]]:
        cache.note_gh_result((1, "", "HTTP 401: Bad credentials"))
        return _OK

    assert cache.cached_accounts(revoked_while_running) == _OK
    compute = _Counter(_OK)
    cache.cached_accounts(compute)
    assert compute.calls == 1


@pytest.mark.posix_only
def test_caller_deadline_caps_the_lock_wait() -> None:
    release = threading.Event()
    started = threading.Event()

    def stuck() -> tuple[bool, list[dict[str, Any]]]:
        started.set()
        release.wait(5)
        return _OK

    holder = threading.Thread(target=lambda: cache.cached_accounts(stuck))
    holder.start()
    assert started.wait(5)
    try:
        began = time.monotonic()
        cache.cached_accounts(_Counter(_OK), deadline=time.monotonic() + 0.05)
        assert time.monotonic() - began < 1.0
    finally:
        release.set()
        holder.join(5)


@pytest.mark.posix_only
def test_flock_without_support_runs_unlocked(monkeypatch: pytest.MonkeyPatch) -> None:
    def no_locks(fd: int, operation: int) -> None:
        raise OSError(37, "No locks available")

    monkeypatch.setattr(cache.fcntl, "flock", no_locks)
    began = time.monotonic()
    compute = _Counter(_OK)
    assert cache.cached_accounts(compute) == _OK
    assert time.monotonic() - began < 1.0
    cache.cached_accounts(compute)
    assert compute.calls == 1


def test_write_prunes_idle_entries_of_other_keys() -> None:
    import os

    directory = cache._cache_dir()
    directory.mkdir(parents=True)
    old = time.time() - 2 * cache._PRUNE_AFTER_SECONDS
    idle = [directory / "gh-auth-status-idle.json", directory / "gh-auth-status-idle.lock"]
    for path in idle:
        path.write_text("{}", encoding="utf-8")
        os.utime(path, (old, old))
    recent = directory / "gh-auth-status-recent.json"
    recent.write_text("{}", encoding="utf-8")
    cache.cached_accounts(_Counter(_OK))
    assert not any(path.exists() for path in idle)
    assert recent.exists()
    assert cache._entry_path(cache._key()).exists()
