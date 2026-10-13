"""Team selection is bounded, parent-scoped and invisible in authored messages."""

import json
from unittest.mock import Mock

import pytest

from omnigent.entities.conversation import Conversation, MessageData
from omnigent.inner.ae_team import TEAM_LABEL, render_team_notice, team_notice
from omnigent.inner.native_attachments import expand_framework_notices, framework_notice_block


def conversation(id: str, **kwargs: object) -> Conversation:
    return Conversation(id=id, root_conversation_id=id, created_at=0, updated_at=0, **kwargs)


def test_roster_only_resolves_existing_direct_children() -> None:
    parent = conversation(
        "parent",
        labels={
            TEAM_LABEL: json.dumps(
                {
                    "version": 1,
                    "mode": "team",
                    "members": [
                        {"sessionId": "child"},
                        {"sessionId": "unrelated"},
                        {"sessionId": "missing"},
                        {"sessionId": "child"},
                        {"sessionId": 42},
                    ],
                }
            )
        },
    )
    child = conversation("child", parent_conversation_id="parent", agent_id="codex")
    store = Mock()
    store.get_conversation.side_effect = lambda id: {
        "child": child,
        "unrelated": conversation("unrelated"),
    }.get(id)
    notice = team_notice(parent, store)
    assert notice == {
        "ae_team": {"mode": "team", "members": [{"session_id": "child", "agent_id": "codex"}]}
    }


@pytest.mark.parametrize("raw", ["null", "{", '{"version":2}', "x" * 20_000])
def test_malformed_rosters_do_not_break_messages(raw: str) -> None:
    store = Mock()
    assert team_notice(conversation("parent", labels={TEAM_LABEL: raw}), store) is None
    store.get_conversation.assert_not_called()


def test_unset_preference_delivers_auto_without_resolving_children() -> None:
    store = Mock()
    notice = team_notice(conversation("parent"), store)
    assert notice == {"ae_team": {"mode": "auto", "members": []}}
    assert "Auto collaboration" in (render_team_notice(notice) or "")
    store.get_conversation.assert_not_called()


def test_solo_preserves_native_helpers_without_resolving_old_team_sessions() -> None:
    store = Mock()
    notice = team_notice(
        conversation("parent", labels={TEAM_LABEL: '{"version":1,"mode":"solo"}'}), store
    )
    text = render_team_notice(notice) or ""
    assert "native in-harness subagents" in text
    assert "Native helpers remain available" in text
    assert "Do not start additional cross-agent collaborations" in text
    store.get_conversation.assert_not_called()


def test_auto_discards_old_roster_and_uses_available_agents_as_needed() -> None:
    store = Mock()
    notice = team_notice(
        conversation(
            "parent",
            labels={TEAM_LABEL: '{"version":1,"mode":"auto","members":[{"sessionId":"old"}]}'},
        ),
        store,
    )
    assert notice == {"ae_team": {"mode": "auto", "members": []}}
    text = render_team_notice(notice) or ""
    assert "configured, reachable agents" in text
    assert "native in-harness subagents" in text
    assert "old" not in text
    store.get_conversation.assert_not_called()


def test_notice_is_transient_and_cannot_be_authored_by_clients() -> None:
    block = framework_notice_block({"ae_team": {"mode": "team", "members": []}})
    content = [{"type": "input_text", "text": "Help with my demo"}, block]
    expanded = expand_framework_notices([{"role": "user", "content": content}])
    assert expanded[0]["role"] == "system"
    assert "sys_session_send" in expanded[0]["content"][0]["text"]
    assert expanded[1] == {"role": "user", "content": content[:1]}
    with pytest.raises(ValueError, match="reserved"):
        MessageData(role="user", content=content)
