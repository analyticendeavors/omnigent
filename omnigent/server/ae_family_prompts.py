"""Show a family child's prompts in its lead's chat (omnigent-ae, 2026-10-27).

A sub-agent's prompt (AskUserQuestion, a tool permission, plan approval) is already
mirrored into its ancestors' streams and snapshots, so the parent chat can render a card
that resolves in the child. Those mirrors walk only ``parent_conversation_id``. A family
child is a top-level session whose ``ae.orch`` label holds its lead's session id, so
nothing reached the lead. This module is that missing link, and only that: the two
publish helpers and the snapshot function in ``routes/_sessions/helpers.py`` each call one
function here.

Rules:

* One hop. A child's prompts go to its own lead, never up the chain.
* A lead has ``ae.orch = "1"`` and is never a child. A fork carries
  ``omnigent.fork.source_id`` and copies its source's labels, but is a top-level session
  of its own, so it is never a child either.
* A session that has a ``parent_conversation_id`` is a sub-agent, mirrored the old way.
* The owner's setting "child prompts in this chat" (default on) gates all of it.

The mirrored event also carries ``params.ae_family_child`` and ``params.ae_requester_title``
(the child's title) so the web app can keep it out of the lead's transcript and show it in
the action dock instead. Resolving needs no new route: the dock posts to the child's own
resolve route, like the child's card and the Inbox page.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from omnigent.inner import ae_roles
from omnigent.runtime import pending_elicitations, session_stream

if TYPE_CHECKING:
    from omnigent.entities.conversation import Conversation
    from omnigent.stores.conversation_store import ConversationStore

_logger = logging.getLogger(__name__)

FAMILY_CHILD_PARAM = "ae_family_child"
REQUESTER_TITLE_PARAM = "ae_requester_title"


def _enabled(conv: Conversation, store: ConversationStore) -> bool:
    """The session owner's "child prompts in this chat" setting; on when unreadable."""
    module = ae_roles._role_prefs()
    if module is None:
        return True
    try:
        return bool(module.store().family_flags(ae_roles._owner(conv, store))[0])
    except Exception:  # noqa: BLE001 (a broken prefs file must never block a prompt)
        _logger.warning("ae family prompts: could not read the setting", exc_info=True)
        return True


def lead_id_of(conv: Conversation) -> str | None:
    """The lead session id a family child's ``ae.orch`` label names, else ``None``.

    :param conv: A conversation row.
    :returns: The lead's id for a top-level, non-fork session labelled with a session id;
        ``None`` for a lead (``"1"``), an unlabelled session, a fork and a sub-agent.
    """
    if getattr(conv, "parent_conversation_id", None):
        return None
    labels = conv.labels if isinstance(conv.labels, dict) else {}
    if labels.get(ae_roles.FORK_SOURCE_LABEL):
        return None
    orch = labels.get(ae_roles.ORCH_LABEL)
    if not isinstance(orch, str):
        return None
    lead = orch.strip()
    return lead if lead not in ("", "1") and lead != conv.id else None


def _same_owner(child: Conversation, lead: Conversation, store: ConversationStore) -> bool:
    return ae_roles._owner(child, store) == ae_roles._owner(lead, store)


def valid_lead_id(conv: Conversation, store: ConversationStore) -> str | None:
    """The lead *conv*'s label names, only if that session exists and has the same owner.

    ``ae.orch`` is not a reserved label, so any session can name any id; without this check a
    session could push prompt cards into another user's dock.
    """
    lead_id = lead_id_of(conv)
    if lead_id is None:
        return None
    lead = store.get_conversation(lead_id)
    if lead is None or not _same_owner(conv, lead, store):
        return None
    return lead_id


def family_parent_id(conv: Conversation, store: ConversationStore) -> str | None:
    """The lead that should see *conv*'s new prompts, or ``None`` (no valid lead, or off)."""
    lead = valid_lead_id(conv, store)
    if lead is None or not _enabled(conv, store):
        return None
    return lead


def _marked(event: dict[str, Any], conv: Conversation) -> dict[str, Any]:
    """*event* with the family-child marker and the child's title on a copy of its params."""
    params = event.get("params")
    base = params if isinstance(params, dict) else {}
    title = conv.title if isinstance(conv.title, str) else ""
    return {
        **event,
        "params": {**base, FAMILY_CHILD_PARAM: True, REQUESTER_TITLE_PARAM: title or conv.id},
    }


def publish_request(
    store: ConversationStore,
    session_id: str,
    mirrored: dict[str, Any],
) -> None:
    """Mirror a child's elicitation request into its lead's stream.

    :param store: Store used to read the child and its owner's setting.
    :param session_id: The child session that owns the elicitation.
    :param mirrored: The event as already targeted at the child (``target_session_id`` set).
    """
    conv = store.get_conversation(session_id)
    lead = family_parent_id(conv, store) if conv is not None else None
    if conv is not None and lead is not None:
        session_stream.publish(lead, _marked(mirrored, conv))


def publish_resolved(
    store: ConversationStore,
    session_id: str,
    elicitation_id: str,
    action: str | None,
    reason: str | None,
) -> None:
    """Tell a child's lead that the child's prompt is resolved.

    :param store: Store used to read the child and its owner's setting.
    :param session_id: The child session that owned the elicitation.
    :param elicitation_id: The elicitation correlation id.
    :param action: The verdict carried through, as the ancestor mirror does.
    :param reason: The no-verdict reason carried through.
    """
    conv = store.get_conversation(session_id)
    # Not gated on the setting: switching it off must still clear a card already in the dock.
    lead = valid_lead_id(conv, store) if conv is not None else None
    if lead is None:
        return
    # Imported here: helpers imports this module, so a top-level import would be circular.
    from omnigent.server.routes._sessions.helpers import _publish_elicitation_resolved

    _publish_elicitation_resolved(lead, elicitation_id, action=action, reason=reason)


def pending_for(
    store: ConversationStore,
    lead: Conversation,
    events: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Pending prompts of *lead*'s family children that *events* does not hold yet.

    Walks only the sessions that have a prompt pending right now (the in-memory index), so
    it adds no label query.

    :param store: Store used to load each pending session.
    :param lead: The session being snapshotted.
    :param events: Pending events already collected for it (used to skip duplicates).
    :returns: Family-child prompt events, marked and targeted at their child.
    """
    seen = {e.get("elicitation_id") for e in events if isinstance(e.get("elicitation_id"), str)}
    out: list[dict[str, Any]] = []
    for session_id in pending_elicitations.pending_session_ids():
        if session_id == lead.id:
            continue
        child = store.get_conversation(session_id)
        if child is None or lead_id_of(child) != lead.id:
            continue
        if not _same_owner(child, lead, store) or not _enabled(child, store):
            continue
        for event in pending_elicitations.snapshot_for(session_id):
            elicitation_id = event.get("elicitation_id")
            if isinstance(elicitation_id, str):
                if elicitation_id in seen:
                    continue
                seen.add(elicitation_id)
            params = event.get("params")
            targeted = {
                **event,
                "params": {
                    **(params if isinstance(params, dict) else {}),
                    "target_session_id": session_id,
                },
            }
            out.append(_marked(targeted, child))
    return out
