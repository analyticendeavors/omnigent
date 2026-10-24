"""Selected team context reaches native and SDK runners without polluting history."""

import json

import httpx
import pytest

from omnigent.inner.ae_roles import HELPER_NOTICE
from omnigent.inner.ae_team import TEAM_LABEL
from omnigent.inner.native_attachments import framework_notices
from omnigent.server.routes._sessions import orchestration
from omnigent.server.schemas import SessionEventInput
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from tests.server.helpers import create_test_agent


@pytest.mark.parametrize("native", [False, True])
@pytest.mark.parametrize("mode", [None, "auto", "solo", "team"])
async def test_team_forward_preserves_authored_message(
    client: httpx.AsyncClient, db_uri: str, native: bool, mode: str | None
) -> None:
    agent = await create_test_agent(client, name="team-lead")
    created = await client.post("/v1/sessions", json={"agent_id": agent["id"]})
    assert created.status_code == 201
    parent_id = created.json()["id"]
    store = SqlAlchemyConversationStore(db_uri)
    child = store.create_conversation(
        kind="sub_agent",
        parent_conversation_id=parent_id,
        agent_id=agent["id"],
    )
    labels = {
        TEAM_LABEL: json.dumps(
            {
                "version": 1,
                "mode": mode,
                "members": [
                    {"sessionId": child.id},
                ],
            }
        )
    }
    if mode is None:
        labels = {}
    if native:
        labels.update({"omnigent.ui": "terminal", "omnigent.wrapper": "codex-native-ui"})
    store.set_labels(parent_id, labels)
    parent = store.get_conversation(parent_id)
    assert parent is not None
    content = [{"type": "input_text", "text": "Build the demo"}]
    event = SessionEventInput(type="message", data={"role": "user", "content": content})
    sent: list[dict] = []

    def capture(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(202, json={"queued": True})

    async with httpx.AsyncClient(
        base_url="http://runner.test", transport=httpx.MockTransport(capture)
    ) as runner:
        if native:
            await orchestration._forward_native_terminal_message(
                runner,
                parent_id,
                parent,
                event,
                conversation_store=store,
            )
        else:
            await orchestration._forward_event_to_runner(parent_id, parent, event, store, runner)
    assert event.data["content"] == content
    forwarded = sent[-1]["content"]
    assert forwarded[0] == content[0]
    notice = framework_notices(forwarded)[0]
    if mode == "team":
        assert child.id in notice
    else:
        assert child.id not in notice
        assert "native in-harness subagents" in notice
    items = store.list_items(parent_id).data
    if native:
        assert not items  # Native transcript forwarder remains the single writer.
    else:
        assert items[0].data.content == content


async def test_native_child_session_gets_the_helper_notice(
    client: httpx.AsyncClient, db_uri: str
) -> None:
    agent = await create_test_agent(client, name="team-helper")
    created = await client.post("/v1/sessions", json={"agent_id": agent["id"]})
    assert created.status_code == 201
    store = SqlAlchemyConversationStore(db_uri)
    child = store.create_conversation(
        kind="sub_agent", parent_conversation_id=created.json()["id"], agent_id=agent["id"]
    )
    store.set_labels(child.id, {"omnigent.ui": "terminal", "omnigent.wrapper": "codex-native-ui"})
    conv = store.get_conversation(child.id)
    assert conv is not None
    content = [{"type": "input_text", "text": "Check the build"}]
    event = SessionEventInput(type="message", data={"role": "user", "content": content})
    sent: list[dict] = []

    def capture(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(202, json={"queued": True})

    async with httpx.AsyncClient(
        base_url="http://runner.test", transport=httpx.MockTransport(capture)
    ) as runner:
        await orchestration._forward_native_terminal_message(
            runner, child.id, conv, event, conversation_store=store
        )
    assert framework_notices(sent[-1]["content"]) == [HELPER_NOTICE]
