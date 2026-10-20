"""Shared Claude accounts: subscription logins the server's admin keeps for every user.

Added 2026-10-20 by omnigent-ae, so a second user's host can use company-paid
Claude accounts that the admin manages, without copying tokens between hosts.
A host account lives in ``claude-accounts.json`` and its token in this host's
secrets (``claude_accounts.py``). A shared account lives on the server (the
omnigent-ae package ``ae_omni_policies.shared_accounts``), and a host knows it
only by its id, ``shared:<name>``. Host names cannot hold a colon, so a shared
id never collides with a host account of the same name.

Selecting one stores only the id as the host's active account. At launch,
:func:`shared_account_env` asks the server for the token with the runner's own
server credential (the bearer the host gave it, the session owner's identity),
and the token goes into the launch environment and nowhere else: never this
host's disk, never a cache.

The server half registers :func:`set_server_resolver` so a fork may pick a
shared account its source host does not list itself.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from urllib.parse import quote

PREFIX = "shared:"
_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _-]{0,63}")
_TIMEOUT_S = 10.0
_server_resolver: Callable[[str], bool] | None = None


def is_shared(account: str | None) -> bool:
    """Whether *account* is a shared account id (``shared:<name>``) with a valid name."""
    return (
        isinstance(account, str)
        and account.startswith(PREFIX)
        and bool(_NAME.fullmatch(account[len(PREFIX) :]))
    )


def shared_label(account: str) -> str:
    """What this host calls a shared account without asking the server: ``Team (shared)``."""
    return f"{account[len(PREFIX) :]} (shared)"


def descriptor(account: str, active: bool) -> dict[str, str | None]:
    """The non-secret descriptor ``host.detect_credentials`` reports for a selected shared id."""
    return {
        "family": "claude-oauth-active" if active else "claude-oauth",
        "source": shared_label(account),
        "env_var": account,
    }


def _server_url() -> str:
    url = (
        os.environ.get("RUNNER_SERVER_URL") or os.environ.get("OMNIGENT_SERVER_URL") or ""
    ).strip()
    if not url:
        raise RuntimeError(
            "The shared Claude account needs the OmniGent server, and this launch does not "
            "know it. Start the chat from a host connected to the server, or select a host "
            "account."
        )
    return url.rstrip("/")


def fetch_shared_token(account: str) -> tuple[str, str]:
    """Ask the server for shared *account*'s token, for one launch.

    :returns: ``(token, label)``.
    :raises RuntimeError: Saying what failed and what to do, never with the token.
    """
    import httpx

    from omnigent.cli_auth import databricks_request_headers
    from omnigent.runner._entry import _make_auth_token_factory

    if not is_shared(account):
        raise RuntimeError("The selected Claude account is not a shared account.")
    name = account[len(PREFIX) :]
    server = _server_url()
    factory = _make_auth_token_factory(server)
    bearer = factory() if factory is not None else None
    headers = databricks_request_headers(server, bearer_token=bearer)
    url = f"{server}/v1/ae/claude-accounts/shared/{quote(name, safe='')}/token"
    try:
        response = httpx.get(url, headers=headers, timeout=_TIMEOUT_S, follow_redirects=False)
    except httpx.HTTPError as exc:
        raise RuntimeError(
            f"Could not reach the server for shared Claude account {name!r} "
            f"({type(exc).__name__}). Check the host's connection and start the chat again."
        ) from None
    if response.status_code != 200:
        try:
            detail = response.json()["error"]["message"]
        except (ValueError, KeyError, TypeError):
            detail = f"HTTP {response.status_code}"
        raise RuntimeError(
            f"The server did not hand over shared Claude account {name!r}: {detail} "
            "Select another account, or ask the admin to check it in Admin Center."
        )
    try:
        body = response.json()
        token, label = body["token"], body["label"]
    except (ValueError, KeyError, TypeError):
        raise RuntimeError(
            f"The server's answer for shared Claude account {name!r} was not understood."
        ) from None
    if not isinstance(token, str) or not token.startswith("sk-ant-oat"):
        raise RuntimeError(f"The server holds no usable token for shared Claude account {name!r}.")
    return token, label if isinstance(label, str) else name


def shared_account_env(account: str) -> dict[str, str]:
    """The launch environment for shared *account*, fetched now and held only in it."""
    token, _label = fetch_shared_token(account)
    return {
        "CLAUDE_CODE_OAUTH_TOKEN": token,
        "ANTHROPIC_API_KEY": "",
        "ANTHROPIC_AUTH_TOKEN": "",
        "OMNIGENT_CLAUDE_ACCOUNT": account,
    }


def set_server_resolver(resolver: Callable[[str], bool] | None) -> None:
    """Install the server's "is this a shared account id" check (``None`` removes it)."""
    global _server_resolver
    _server_resolver = resolver


def known_on_server(account: str) -> bool:
    """Whether the server in this process holds shared *account*; ``False`` without one."""
    if _server_resolver is None or not is_shared(account):
        return False
    try:
        return bool(_server_resolver(account))
    except Exception:  # An unreadable store answers "not known", never a 500.
        return False
