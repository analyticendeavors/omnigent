"""Guard the ``ae.claude_account`` label: only the session's bound runner writes it.

The label names the login the terminal last launched on, and a relaunch keeps
it. A client that could set it could point a shared chat at another login
without the switch route's checks, so create rejects it outright and PATCH
wants the runner's tunnel-token proof, as the ``cost_control.*`` labels do.
"""

from __future__ import annotations

from collections.abc import Mapping

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.harnesses.claude_native.ae_launch_account import ACCOUNT_LIVE_LABEL
from omnigent.runner.identity import token_bound_runner_id


def reject_live_account_seed(labels: Mapping[str, str] | None) -> None:
    """
    Reject a session-create body that names the live Claude login.

    :param labels: The client-supplied initial labels.
    :raises OmnigentError: 400 when ``ae.claude_account`` is present.
    """
    if labels and ACCOUNT_LIVE_LABEL in labels:
        raise OmnigentError(
            f"label {ACCOUNT_LIVE_LABEL!r} is server-internal and cannot be set by clients",
            code=ErrorCode.INVALID_INPUT,
        )


def require_live_account_authority(
    labels: Mapping[str, str] | None,
    *,
    tunnel_token: str | None,
    bound_runner_id: str | None,
    allowed_tunnel_tokens: frozenset[str] | None,
    multi_user: bool,
) -> None:
    """
    Authorize a label PATCH that touches ``ae.claude_account``.

    :param labels: The labels the request writes.
    :param tunnel_token: The ``X-Omnigent-Runner-Tunnel-Token`` header, or ``None``.
    :param bound_runner_id: The session's ``runner_id``, or ``None``.
    :param allowed_tunnel_tokens: The server's tunnel-token allow-list, or ``None``.
    :param multi_user: ``True`` when the server enforces per-user permissions.
    :raises OmnigentError: 403 when a multi-user caller gives no runner proof.
    """
    if not labels or ACCOUNT_LIVE_LABEL not in labels or not multi_user:
        return
    token = (tunnel_token or "").strip()
    if token:
        if allowed_tunnel_tokens is not None and token in allowed_tunnel_tokens:
            return
        if bound_runner_id is not None and token_bound_runner_id(token) == bound_runner_id:
            return
    raise OmnigentError(
        f"label {ACCOUNT_LIVE_LABEL!r} is written by the session's bound runner only",
        code=ErrorCode.FORBIDDEN,
    )
