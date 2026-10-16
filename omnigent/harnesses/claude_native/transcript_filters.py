"""Claude transcript records that must never reach the Omnigent chat.

Claude Code writes bookkeeping into the session transcript next to the
conversation itself. Two kinds look enough like chat to slip through the
bridge's role-based dispatch:

* Request-log records (``type`` starting with ``api-request``, such as
  ``api-request-blob``, added in Claude Code 2.1.300). They copy the raw
  request text the model saw, ``<system-reminder>`` wrappers, skill
  bodies and repeated prompts included, under a ``message.role`` of
  ``user``, ``assistant`` or ``system`` and with no ``uuid``.
* Prompt-mode ``queued_command`` attachments that Claude Code queued on
  its own: messages from another agent (``origin.kind == "peer"``, with
  ``origin.handback`` set for a subagent's final report), background
  task notifications, and anything marked ``isMeta``. None of them is
  user input.

The bridge calls these predicates before it turns a record into items.
"""

from __future__ import annotations

from collections.abc import Mapping

_REQUEST_LOG_TYPE_PREFIX = "api-request"
_SYSTEM_ORIGIN_KINDS = frozenset({"peer", "task-notification"})


def is_request_log_record(entry: Mapping[str, object]) -> bool:
    """
    Return whether a transcript record is one of Claude's request logs.

    :param entry: Decoded JSON object from one transcript line.
    :returns: ``True`` when ``entry["type"]`` starts with
        ``api-request``.
    """
    record_type = entry.get("type")
    return isinstance(record_type, str) and record_type.startswith(_REQUEST_LOG_TYPE_PREFIX)


def is_system_queued_command(attachment: Mapping[str, object]) -> bool:
    """
    Return whether a ``queued_command`` attachment was queued by Claude.

    Claude Code stores the markers on the attachment itself:
    ``isMeta`` at its top level, and ``kind`` and ``handback`` inside its
    ``origin`` object.

    :param attachment: The ``attachment`` object of a transcript record.
    :returns: ``True`` when the attachment is marked ``isMeta``, its
        origin kind is ``peer`` or ``task-notification``, or its origin
        carries ``handback: true``.
    """
    if attachment.get("isMeta") is True:
        return True
    origin = attachment.get("origin")
    if not isinstance(origin, Mapping):
        return False
    if origin.get("kind") in _SYSTEM_ORIGIN_KINDS:
        return True
    return origin.get("handback") is True
