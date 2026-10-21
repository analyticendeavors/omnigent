"""A short-lived, host-wide cache of the ``gh auth status --json hosts`` answer.

Every read of a session's GitHub resource (``GET /v1/sessions/{id}/resources/github``)
reaches :func:`omnigent.runner.github_resource._list_accounts`, in whichever process
serves it: the session's own runner (one process per session) or the host service
when the runner is offline. A server-side watcher reads every recent session on an
interval and browser tabs poll the same route, so the same answer is asked for
many times a minute, often by several processes in the same second.

The answer depends only on the gh login, not on the session, so it is cached in
one small file per user that every process of the host shares:

- **TTL.** ``OMNIGENT_GH_AUTH_CACHE_SECONDS`` (default 60; ``0`` turns the cache
  off). A login that goes bad is reported within the TTL at worst.
- **Only successes are cached.** A logged-out answer, a timeout, a gh that could
  not run or unparseable output runs ``gh`` again on the next read.
- **Key.** The gh config dir, the size and mtime of its ``hosts.yml`` (which
  ``gh auth login``, ``logout`` and ``switch`` rewrite, so a login change misses at
  once), whether the process is in a managed sandbox, and a hash of the ``GH_*``
  token variables gh would read. Tokens are never stored, only that hash.
- **Invalidation.** :func:`note_gh_result` marks the entry invalidated when a
  ``gh`` call on the ambient login fails with an authentication error; a fill that
  started before the mark does not overwrite it.
- **One call per burst.** Concurrent misses take an advisory file lock, so the
  first process runs ``gh`` and the rest read its answer. A waiter gives up after
  a few seconds (or at the caller's deadline) and runs ``gh`` itself, so a stuck
  holder never stalls a read.
- **Pruning.** A write removes entries and locks of other keys idle for an hour.

The cached value is ``(authenticated, accounts)`` exactly as ``_list_accounts``
returns it; ``accounts`` carries login, active, state and host, never a token.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import math
import os
import re
import tempfile
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

try:  # POSIX only; without it concurrent misses each run gh, as before.
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None  # type: ignore[assignment]

_logger = logging.getLogger(__name__)

_DEFAULT_TTL_SECONDS = 60.0
# How long a concurrent miss waits for the process already running gh.
_LOCK_WAIT_SECONDS = 3.0
_LOCK_POLL_SECONDS = 0.05
# Entries and locks of other keys idle this long are removed on a write.
_PRUNE_AFTER_SECONDS = 3600.0
# The token variables gh reads (the same set github_resource._gh scrubs in a
# sandbox); outside a sandbox they decide the identity.
_TOKEN_VARS = ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN")
_AUTH_FAILURE = re.compile(
    r"bad credentials|HTTP 401|gh auth login|not logged in|authentication (failed|required)",
    re.IGNORECASE,
)

Accounts = tuple[bool, list[dict[str, Any]]]


def ttl_seconds() -> float:
    """The cache TTL from ``OMNIGENT_GH_AUTH_CACHE_SECONDS``; ``0`` disables it."""
    raw = os.environ.get("OMNIGENT_GH_AUTH_CACHE_SECONDS")
    if raw is None:
        return _DEFAULT_TTL_SECONDS
    try:
        value = float(raw)
    except ValueError:
        return _DEFAULT_TTL_SECONDS
    if not math.isfinite(value):
        return _DEFAULT_TTL_SECONDS
    return max(value, 0.0)


def _cache_dir() -> Path:
    return Path(os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache")) / "omnigent"


def _gh_config_dir() -> str:
    # gh's own platform-aware order, including %AppData%\GitHub CLI on Windows.
    from omnigent.git_providers.github import _gh_config_dir as resolve

    try:
        return resolve()
    except RuntimeError:
        return ""


def _key() -> str:
    """Hash of everything ``gh auth status`` answers from (see the module docstring)."""
    config_dir = Path(_gh_config_dir())
    try:
        stat = (config_dir / "hosts.yml").stat()
        hosts_file = f"{stat.st_size}:{stat.st_mtime_ns}"
    except OSError:
        hosts_file = "missing"
    sandbox = (os.environ.get("IS_SANDBOX") or "").strip() == "1"
    # github_resource._gh scrubs the token variables inside a sandbox.
    tokens = "" if sandbox else "\0".join(os.environ.get(name, "") for name in _TOKEN_VARS)
    material = "\n".join(
        [str(config_dir), hosts_file, f"sandbox={sandbox}", tokens, os.environ.get("GH_HOST", "")]
    )
    return hashlib.sha256(material.encode("utf-8", errors="replace")).hexdigest()[:24]


def _entry_path(key: str) -> Path:
    return _cache_dir() / f"gh-auth-status-{key}.json"


def _load(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _invalidated_since(path: Path, started: float) -> bool:
    data = _load(path)
    marked = data.get("invalidated_at") if data else None
    return isinstance(marked, (int, float)) and marked >= started


def _read(path: Path, ttl: float) -> Accounts | None:
    data = _load(path)
    if data is None:
        return None
    stored_at = data.get("stored_at")
    accounts = data.get("accounts")
    if not isinstance(stored_at, (int, float)) or not isinstance(accounts, list):
        return None
    age = time.time() - stored_at
    # A negative age means the clock moved back; treat the entry as stale.
    if age < 0 or age >= ttl or data.get("authenticated") is not True:
        return None
    return True, [dict(account) for account in accounts if isinstance(account, dict)]


def _write(path: Path, data: dict[str, Any]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".gh-auth-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle)
            os.replace(tmp, path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise
    except OSError as exc:
        _logger.debug("gh auth cache: could not write %s: %s", path, exc)


def _prune(keep: Path) -> None:
    """Remove other keys' entries and locks that nobody has touched for an hour."""
    cutoff = time.time() - _PRUNE_AFTER_SECONDS
    for stale in keep.parent.glob("gh-auth-status-*"):
        if stale.stem == keep.stem:
            continue
        with contextlib.suppress(OSError):
            if stale.stat().st_mtime < cutoff:
                stale.unlink()


@contextlib.contextmanager
def _locked(path: Path, deadline: float | None) -> Iterator[bool]:
    """Hold an exclusive lock beside *path*; yields whether it was acquired.

    :param deadline: A ``time.monotonic()`` instant after which to stop waiting.
    """
    if fcntl is None:
        yield False
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(path.with_suffix(".lock"), "a+b")  # noqa: SIM115 - held across the yield
    except OSError:
        yield False
        return
    acquired = False
    try:
        give_up = time.monotonic() + _LOCK_WAIT_SECONDS
        if deadline is not None:
            give_up = min(give_up, deadline)
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except BlockingIOError:
                if time.monotonic() >= give_up:
                    break
                time.sleep(_LOCK_POLL_SECONDS)
            except OSError:
                # No flock on this filesystem (ENOLCK, EINVAL): run unlocked.
                break
        yield acquired
    finally:
        if acquired:
            with contextlib.suppress(OSError):
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def cached_accounts(compute: Callable[[], Accounts], *, deadline: float | None = None) -> Accounts:
    """Return the cached ``gh auth status`` answer, or *compute* and cache a success.

    :param compute: Runs ``gh auth status`` and returns ``(authenticated, accounts)``.
    :param deadline: The caller's ``time.monotonic()`` budget, capping the lock wait.
    :returns: The same shape *compute* returns.
    """
    ttl = ttl_seconds()
    if ttl <= 0:
        return compute()
    path = _entry_path(_key())
    hit = _read(path, ttl)
    if hit is not None:
        return hit
    with _locked(path, deadline):
        # Another process may have answered while this one waited for the lock.
        hit = _read(path, ttl)
        if hit is not None:
            return hit
        started = time.time()
        value = compute()
        # An invalidation that landed while gh ran wins over this answer.
        if value[0] is True and not _invalidated_since(path, started):
            _write(path, {"stored_at": time.time(), "authenticated": True, "accounts": value[1]})
            _prune(path)
        return value


def invalidate() -> None:
    """Mark the current key's entry invalidated, so the next read runs ``gh auth status``."""
    if ttl_seconds() <= 0:
        return
    _write(_entry_path(_key()), {"invalidated_at": time.time()})


def note_gh_result(result: tuple[int | None, str, str], *, token: str | None = None) -> None:
    """Invalidate the cache when a ``gh`` call failed with an authentication error.

    :param result: ``(returncode, stdout, stderr)`` from a ``gh`` call.
    :param token: The explicit account token the call ran with, if any. Its failure
        says nothing about the ambient login the cache holds, so it is ignored.
    """
    returncode, _, stderr = result
    if token:
        return
    if returncode not in (None, 0) and _AUTH_FAILURE.search(stderr or ""):
        invalidate()
