"""Selected team context reaches native and SDK runners without polluting history."""

import json

import httpx
import pytest

from omnigent.inner.ae_team import TEAM_LABEL
from omnigent.inner.native_attachments import framework_notices
from omnigent.server.routes._sessions import orchestration
from omnigent.server.schemas import SessionEventInput
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from tests.server.helpers import create_test_agent


@pytest.mark.parametrize("native", [False, True])
async def test_team_forward_preserves_authored_message(
    client: httpx.AsyncClient, db_uri: str, native: bool
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
                "mode": "team",
                "members": [
                    {"sessionId": child.id},
                ],
            }
        )
    }
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
    assert child.id in framework_notices(forwarded)[0]
    items = store.list_items(parent_id).data
    if native:
        assert not items  # Native transcript forwarder remains the single writer.
    else:
        assert items[0].data.content == content
