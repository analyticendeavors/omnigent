"""A family child's prompt, mirrored to its lead, resolves in the child (omnigent-ae, 2026-10-27).

The lead's action dock posts to the child's own resolve route, so the ownership check inside
``_resolve_elicitation`` has to pass for the child id and keep refusing the lead id.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any

import pytest

from omnigent.runtime import pending_elicitations
from omnigent.server import _elicitation_registry as registry
from omnigent.server.routes._sessions.orchestration import _resolve_elicitation

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _clean() -> Iterator[None]:
    registry.reset_for_tests()
    pending_elicitations.reset_for_tests()
    yield
    registry.reset_for_tests()
    pending_elicitations.reset_for_tests()


async def test_the_childs_id_resolves_its_prompt_and_the_leads_id_does_not() -> None:
    future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
    registry._harness_elicitation_registry["elicit_1"] = future
    registry._harness_elicitation_owners["elicit_1"] = "child_session"

    # The dock never posts to the lead, but a wrong id must not release the child's Future.
    await _resolve_elicitation(
        "lead_session", {"elicitation_id": "elicit_1", "action": "accept"}, None
    )
    assert not future.done()

    # The child's id is the owner: the dock's verdict releases it.
    await _resolve_elicitation(
        "child_session", {"elicitation_id": "elicit_1", "action": "accept"}, None
    )
    assert future.done()
    assert future.result().action == "accept"
