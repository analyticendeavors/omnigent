"""A family child's prompts reach its lead's stream and snapshot (omnigent-ae, 2026-10-27)."""

from __future__ import annotations

from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

import pytest

from omnigent.inner import ae_roles
from omnigent.runtime import pending_elicitations
from omnigent.server import ae_family_prompts
from omnigent.server.routes._sessions.helpers import (
    _pending_elicitation_snapshot_for_session,
    _publish_elicitation_request_to_ancestors,
    _publish_elicitation_resolved_to_ancestors,
    _targeted_elicitation_event,
)
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore

_EVENT = {
    "type": "response.elicitation_request",
    "elicitation_id": "elicit_1",
    "params": {"message": "Keep it?", "ask_user_question": {"questions": []}},
}


@pytest.fixture
def prefs(monkeypatch: pytest.MonkeyPatch) -> dict[str, bool]:
    """The owner's family settings, both on; a test flips ``child_prompts``."""
    flags = {"child_prompts": True, "child_relay": True}
    module = SimpleNamespace(
        store=lambda: SimpleNamespace(
            family_flags=lambda _user: (flags["child_prompts"], flags["child_relay"])
        )
    )
    monkeypatch.setattr(ae_roles, "_role_prefs", lambda: module)
    return flags


@pytest.fixture
def published(monkeypatch: pytest.MonkeyPatch) -> Mock:
    mock = Mock()
    monkeypatch.setattr("omnigent.server.ae_family_prompts.session_stream.publish", mock)
    monkeypatch.setattr("omnigent.server.routes._sessions.helpers.session_stream.publish", mock)
    return mock


@pytest.fixture(autouse=True)
def _clean_index() -> Iterator[None]:
    pending_elicitations.reset_for_tests()
    yield
    pending_elicitations.reset_for_tests()


def _family(db_uri: str) -> tuple[SqlAlchemyConversationStore, Any, Any]:
    store = SqlAlchemyConversationStore(db_uri)
    lead = store.create_conversation(labels={"ae.orch": "1"})
    child = store.create_conversation(title="Halcyon Orbital", labels={"ae.orch": lead.id})
    return store, lead, child


def test_a_family_childs_request_reaches_its_lead(
    db_uri: str, prefs: dict[str, bool], published: Mock
) -> None:
    store, lead, child = _family(db_uri)
    _publish_elicitation_request_to_ancestors(store, child.id, _EVENT)
    published.assert_called_once()
    stream_id, event = published.call_args.args
    assert stream_id == lead.id
    assert event["elicitation_id"] == "elicit_1"
    assert event["params"]["target_session_id"] == child.id
    assert event["params"]["ae_family_child"] is True
    assert event["params"]["ae_requester_title"] == "Halcyon Orbital"
    # The original event is untouched.
    assert "ae_family_child" not in _EVENT["params"]


def test_the_resolved_signal_reaches_the_lead(
    db_uri: str, prefs: dict[str, bool], published: Mock
) -> None:
    store, lead, child = _family(db_uri)
    _publish_elicitation_resolved_to_ancestors(store, child.id, "elicit_1", "accept")
    stream_id, event = published.call_args.args
    assert stream_id == lead.id
    assert event["type"] == "response.elicitation_resolved"
    assert event["elicitation_id"] == "elicit_1"


def test_nothing_is_published_when_the_setting_is_off(
    db_uri: str, prefs: dict[str, bool], published: Mock
) -> None:
    prefs["child_prompts"] = False
    store, _lead, child = _family(db_uri)
    _publish_elicitation_request_to_ancestors(store, child.id, _EVENT)
    published.assert_not_called()


@pytest.mark.parametrize("label", ["1", "", "   "])
def test_a_lead_or_unlabelled_session_has_no_family_parent(
    db_uri: str, prefs: dict[str, bool], published: Mock, label: str
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    conv = store.create_conversation(labels={"ae.orch": label} if label else {})
    _publish_elicitation_request_to_ancestors(store, conv.id, _EVENT)
    published.assert_not_called()


def test_a_fork_is_never_a_child(db_uri: str, prefs: dict[str, bool], published: Mock) -> None:
    store, lead, _child = _family(db_uri)
    fork = store.create_conversation(
        labels={"ae.orch": lead.id, "omnigent.fork.source_id": "conv_source"}
    )
    _publish_elicitation_request_to_ancestors(store, fork.id, _EVENT)
    published.assert_not_called()


def test_a_sub_agent_still_mirrors_to_its_parent_only(
    db_uri: str, prefs: dict[str, bool], published: Mock
) -> None:
    store, lead, _child = _family(db_uri)
    parent = store.create_conversation()
    sub = store.create_conversation(
        kind="sub_agent",
        parent_conversation_id=parent.id,
        title="Explore:agent-1",
        labels={"ae.orch": lead.id},
    )
    _publish_elicitation_request_to_ancestors(store, sub.id, _EVENT)
    published.assert_called_once()
    stream_id, event = published.call_args.args
    assert stream_id == parent.id
    assert "ae_family_child" not in event["params"]


def test_one_hop_only(db_uri: str, prefs: dict[str, bool], published: Mock) -> None:
    """A child's child goes to its own lead (the child), never the grandparent."""
    store, lead, child = _family(db_uri)
    grandchild = store.create_conversation(title="Deep", labels={"ae.orch": child.id})
    _publish_elicitation_request_to_ancestors(store, grandchild.id, _EVENT)
    assert [call.args[0] for call in published.call_args_list] == [child.id]
    assert lead.id not in [call.args[0] for call in published.call_args_list]


def test_the_snapshot_lists_a_family_childs_pending_prompt(
    db_uri: str, prefs: dict[str, bool]
) -> None:
    store, lead, child = _family(db_uri)
    pending_elicitations.record_publish(child.id, _EVENT)
    events = _pending_elicitation_snapshot_for_session(store, store.get_conversation(lead.id))
    assert [e["elicitation_id"] for e in events] == ["elicit_1"]
    assert events[0]["params"]["target_session_id"] == child.id
    assert events[0]["params"]["ae_family_child"] is True
    assert events[0]["params"]["ae_requester_title"] == "Halcyon Orbital"


def test_the_snapshot_does_not_repeat_a_live_mirror(db_uri: str, prefs: dict[str, bool]) -> None:
    store, lead, child = _family(db_uri)
    pending_elicitations.record_publish(child.id, _EVENT)
    live = ae_family_prompts._marked(
        _targeted_elicitation_event(_EVENT, target_session_id=child.id), child
    )
    pending_elicitations.record_publish(lead.id, live)
    events = _pending_elicitation_snapshot_for_session(store, store.get_conversation(lead.id))
    assert [e["elicitation_id"] for e in events] == ["elicit_1"]


def test_the_snapshot_skips_other_leads_and_the_setting_off(
    db_uri: str, prefs: dict[str, bool]
) -> None:
    store, lead, child = _family(db_uri)
    other = store.create_conversation(labels={"ae.orch": "1"})
    stranger = store.create_conversation(labels={"ae.orch": other.id})
    pending_elicitations.record_publish(stranger.id, {**_EVENT, "elicitation_id": "elicit_2"})
    assert _pending_elicitation_snapshot_for_session(store, store.get_conversation(lead.id)) == []
    pending_elicitations.record_publish(child.id, _EVENT)
    prefs["child_prompts"] = False
    assert _pending_elicitation_snapshot_for_session(store, store.get_conversation(lead.id)) == []


def _owners(monkeypatch: pytest.MonkeyPatch, owners: dict[str, str]) -> None:
    monkeypatch.setattr(ae_roles, "_owner", lambda conv, _store: owners.get(conv.id, "local"))


def test_a_lead_owned_by_someone_else_gets_nothing(
    db_uri: str, prefs: dict[str, bool], published: Mock, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, lead, child = _family(db_uri)
    _owners(monkeypatch, {lead.id: "alice", child.id: "mallory"})
    _publish_elicitation_request_to_ancestors(store, child.id, _EVENT)
    _publish_elicitation_resolved_to_ancestors(store, child.id, "elicit_1", "accept")
    published.assert_not_called()
    pending_elicitations.record_publish(child.id, _EVENT)
    assert _pending_elicitation_snapshot_for_session(store, store.get_conversation(lead.id)) == []


def test_a_missing_lead_gets_nothing(db_uri: str, prefs: dict[str, bool], published: Mock) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    orphan = store.create_conversation(labels={"ae.orch": "0" * 32})
    _publish_elicitation_request_to_ancestors(store, orphan.id, _EVENT)
    _publish_elicitation_resolved_to_ancestors(store, orphan.id, "elicit_1", "accept")
    published.assert_not_called()


def test_the_resolved_signal_still_clears_the_dock_when_the_setting_goes_off(
    db_uri: str, prefs: dict[str, bool], published: Mock
) -> None:
    store, lead, child = _family(db_uri)
    prefs["child_prompts"] = False
    _publish_elicitation_resolved_to_ancestors(store, child.id, "elicit_1", "accept")
    stream_id, event = published.call_args.args
    assert stream_id == lead.id and event["type"] == "response.elicitation_resolved"
    # New requests stay gated by the setting.
    published.reset_mock()
    _publish_elicitation_request_to_ancestors(store, child.id, _EVENT)
    published.assert_not_called()
