"""Forward a claude-native UserPromptSubmit hook as a turn-open edge.

Claude's status file publishes only on change, so a turn that starts while the
file still reads busy never reaches the server as ``running``. The hook fires on
every prompt, so the forwarder posts it as a ``prompt`` edge. The server hands it
to turn-edge observers and publishes no status.
"""

from __future__ import annotations

import logging

import httpx

_logger = logging.getLogger(__name__)


async def post_prompt_edge(client: httpx.AsyncClient, session_id: str) -> None:
    """Post one prompt edge for *session_id*; best effort, never raises."""
    try:
        resp = await client.post(
            f"/v1/sessions/{session_id}/events",
            json={
                "type": "external_session_status",
                "data": {"status": "running", "ae_prompt_edge": True},
            },
        )
        resp.raise_for_status()
    except Exception as exc:  # noqa: BLE001 (a missed edge must not stall the hook stream)
        _logger.debug("prompt edge post failed: %s", type(exc).__name__)
