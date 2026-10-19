"""Check the Claude account a fork asks its Claude Code session to sign in with.

The account rides on the forked session as ``omnigent.claude_native.account``,
which the runner reads when it launches Claude. Moving a running session to
another account used to go through the in-place agent switch; with that switch
retired, the account is picked when forking. A fork binds its host after the
fork request, so the checks run against the source session's host, the only
host the web dialog offers the pick for. Binding the fork to another host still
needs the caller to own that host, and a launch there fails with "The selected
Claude account is unavailable on this host." when it lacks the account.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import Request

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.onboarding.claude_accounts import CLAUDE_PROVIDER_ENV_KEYS

_PROVIDER_FAMILIES = frozenset({"claude-provider-env", "claude-provider-config"})
_ACCOUNT_FAMILIES = frozenset({"claude-oauth", "claude-oauth-active"})


def _invalid(message: str, code: ErrorCode = ErrorCode.INVALID_INPUT) -> OmnigentError:
    return OmnigentError(message, code=code)


async def validate_fork_claude_account(
    request: Request,
    *,
    account: str,
    agent: Any,
    source: Any,
    user_id: str | None,
    host_type: str,
) -> None:
    """Raise unless the fork can run its Claude session under *account*.

    The target must be Claude native with no provider credentials bound to the
    agent or the session, and the source's host must be the caller's own
    connected local host, where *account* names a detected Claude subscription
    login (an empty string names the default CLI login).

    :param request: The fork request, for the host store and registry.
    :param account: Account name from the request, e.g. ``"Work"``.
    :param agent: The agent the fork binds.
    :param source: The session being forked.
    :param user_id: The caller, or ``None`` in single-user mode.
    :param host_type: The fork's ``host_type``; only ``"external"`` qualifies.
    :raises OmnigentError: 400, 403 or 409 naming what rules the account out.
    """
    from omnigent.harness_aliases import canonicalize_harness
    from omnigent.server.auth import RESERVED_USER_LOCAL
    from omnigent.server.routes import sessions as sessions_facade
    from omnigent.server.routes.hosts import _proxy_detect_credentials

    if host_type != "external":
        raise _invalid("Claude account selection requires a fork on a local connected host.")
    loaded = await asyncio.to_thread(
        sessions_facade.get_agent_cache().load, agent.id, agent.bundle_location
    )
    executor = loaded.spec.executor
    if canonicalize_harness(executor.harness_kind) != "claude-native":
        raise _invalid("Claude account selection requires a Claude native target.")
    config = getattr(executor, "config", None)
    spec_envs = (
        getattr(loaded.spec, "env", None),
        getattr(executor, "env", None),
        config.get("env") if isinstance(config, dict) else None,
    )
    has_provider_env = any(
        isinstance(env, dict) and any(env.get(key) for key in CLAUDE_PROVIDER_ENV_KEYS)
        for env in spec_envs
    )
    if (
        getattr(source, "inference_snapshot", None) is not None
        or getattr(executor, "auth", None) is not None
        or getattr(executor, "profile", None)
        or has_provider_env
    ):
        raise _invalid("Claude account selection conflicts with bound provider authentication.")
    if source.host_id is None:
        raise _invalid("Claude account selection requires a local connected host.")
    host_store = getattr(request.app.state, "host_store", None)
    host = (
        await asyncio.to_thread(host_store.get_host, source.host_id)
        if host_store is not None
        else None
    )
    if host is None or host.sandbox_provider is not None:
        raise _invalid("Claude account selection requires a local registered host.")
    if host.user_id != (user_id or RESERVED_USER_LOCAL):
        raise _invalid(
            "Claude account selection requires ownership of the session's host.",
            ErrorCode.FORBIDDEN,
        )
    registry = getattr(request.app.state, "host_registry", None)
    host_conn = registry.get(source.host_id) if registry is not None else None
    if host_conn is None:
        raise _invalid("Claude account selection requires a connected host.", ErrorCode.CONFLICT)
    detected = await _proxy_detect_credentials(host_registry=registry, host_conn=host_conn)
    credentials = detected.get("credentials", [])
    if any(item.get("family") in _PROVIDER_FAMILIES for item in credentials):
        raise _invalid("Claude account selection conflicts with host provider authentication.")
    available = {
        item.get("env_var") or ""
        for item in credentials
        if item.get("family") in _ACCOUNT_FAMILIES
    }
    if account not in available:
        raise _invalid("Selected Claude account is unavailable on this host.")
