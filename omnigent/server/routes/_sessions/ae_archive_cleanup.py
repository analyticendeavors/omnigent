"""Ask the runner to clean up an archived session's resources.

Archive stops the pane and the host runner but never told the runner to delete the
session's native bridge dir, attachment cache and bridge token. That did not matter while
the host's next startup sweep removed every dead-owner dir; the sweep now keeps one for 7
days (``claude_native.ae_bridge_retention``), so archive asks for the cleanup itself,
while the runner is still reachable.
"""

from __future__ import annotations

import logging

_logger = logging.getLogger(__name__)

_CLEANUP_TIMEOUT_S = 15.0


async def request_runner_resource_cleanup(session_id: str) -> None:
    """
    Best-effort ``DELETE /v1/sessions/{id}/resources`` on the runner that holds *session_id*.

    An offline, unbound or wedged runner is skipped; the session is archived either way.

    :param session_id: Archived session id, e.g. ``"conv_abc123"``.
    """
    from omnigent.server.routes import sessions as _facade

    try:
        runner_client = await _facade._get_runner_client_for_resource_access(session_id)
        if runner_client is None:
            return
        await runner_client.delete(
            f"/v1/sessions/{session_id}/resources", timeout=_CLEANUP_TIMEOUT_S
        )
    except Exception:  # noqa: BLE001 - archive must not fail on a wedged runner
        _logger.debug(
            "Archive resource cleanup failed for %s",
            session_id,
            exc_info=True,
            extra={"session_id": session_id},
        )
