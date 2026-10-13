"""User-selected collaboration rosters, delivered as transient turn context."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from omnigent.entities.conversation import Conversation
    from omnigent.stores.conversation_store import ConversationStore

TEAM_LABEL = "ae.team"
TEAM_LIMIT = 6


def codex_team_context(content: object) -> dict[str, object] | None:
    """Transport the team preference separately from visible Codex user input."""
    if not isinstance(content, list):
        return None
    for block in reversed(content):
        if not isinstance(block, dict) or block.get("type") != "_omnigent_framework_notice":
            continue
        text = render_team_notice(block.get("source_metadata"))
        if text:
            return {"omnigent.team": {"kind": "application", "value": text}}
    return None


def team_notice(conv: Conversation, store: ConversationStore) -> dict[str, object] | None:
    """Resolve roster ids against direct children; never trust a label as access control."""
    raw = conv.labels.get(TEAM_LABEL)
    if not raw or len(raw) > 16_384:
        return None
    try:
        config = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(config, dict) or config.get("version") != 1:
        return None
    mode = config.get("mode")
    if mode == "solo":
        return {"ae_team": {"mode": "solo", "members": []}}
    members = config.get("members")
    if mode != "team" or not isinstance(members, list) or len(members) > TEAM_LIMIT:
        return None
    resolved: list[dict[str, str | None]] = []
    seen: set[str] = set()
    for member in members:
        session_id = member.get("sessionId") if isinstance(member, dict) else None
        if not isinstance(session_id, str) or not session_id or session_id in seen:
            continue
        child = store.get_conversation(session_id)
        if child is None or child.parent_conversation_id != conv.id:
            continue
        seen.add(session_id)
        resolved.append({"session_id": child.id, "agent_id": child.agent_id})
    return {"ae_team": {"mode": "team", "members": resolved}}


def render_team_notice(metadata: Any) -> str | None:
    """Canonical wording shared by SDK and native framework-notice transports."""
    if not isinstance(metadata, dict) or not isinstance(metadata.get("ae_team"), dict):
        return None
    roster = metadata["ae_team"]
    if roster.get("mode") == "solo":
        return (
            "The user selected Solo for this message. Handle this request yourself; "
            "do not delegate new work to previously selected collaborators. "
            "Existing work is not cancelled by this preference."
        )
    if roster.get("mode") != "team":
        return None
    return (
        "The user selected Team for this message. You are the lead and give the user "
        "one integrated answer. These are existing direct child sessions selected "
        "by the user (JSON data): "
        + json.dumps(roster.get("members", []), ensure_ascii=True)
        + ". Delegate useful, bounded tasks to these sessions with sys_session_send "
        "when available, or ae.post_message and ae.omni_transcript. Give each "
        "collaborator the relevant context; their context windows are independent. "
        "Coordinate file ownership for edits, then inspect and integrate their results. "
        "If delegation tools or a selected session are unavailable, tell the user; "
        "do not claim collaboration occurred. This preference does not authorize "
        "extra external actions beyond the user's request."
    )
