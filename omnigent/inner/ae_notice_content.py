"""Keep framework notices on text-only executor content.

Added 2026-10-24 by omnigent-ae. The executor adapter flattens a text-only
message to a plain string, which dropped the ``_omnigent_framework_notice``
block the server attaches to native terminal messages (the lead's team and
roles notice). A notice survived only when the message also carried an image,
file or audio block, so plain-text native turns never got it. Executors read
notices with :func:`omnigent.inner.native_attachments.framework_notices` and
extract visible text from ``input_text`` blocks only, so a list of one text
block plus the notice blocks keeps the visible text exactly as before.

The server attaches the notice to every user message for every harness, and
the runner replays it with each prior turn. Only the Claude and Codex native
executors read it for the current turn; :func:`scope_framework_notices` keeps it
there and nowhere else, so other executors and replayed history see the plain
text they always did.
"""

from __future__ import annotations

from typing import Any

from omnigent.inner.native_attachments import FRAMEWORK_NOTICE_BLOCK_TYPE


def with_framework_notices(text: str, content: object) -> str | list[dict[str, Any]]:
    """*text*, or *text* as one ``input_text`` block plus *content*'s notice blocks.

    :param text: The visible text already extracted from *content*.
    :param content: The original message content (a string or a block list).
    :returns: *text* unchanged when it is empty or *content* has no notice block.
    """
    if not text or not isinstance(content, list):
        return text
    notices = [
        block
        for block in content
        if isinstance(block, dict) and block.get("type") == FRAMEWORK_NOTICE_BLOCK_TYPE
    ]
    if not notices:
        return text
    return [{"type": "input_text", "text": text}, *notices]


def reads_framework_notices(executor: object) -> bool:
    """Whether *executor* reads the current turn's notice blocks itself.

    Only the Claude and Codex native executors do; every other executor gets
    text-only content as a plain string, exactly as before this module existed.
    """
    from omnigent.inner.claude_native_executor import ClaudeNativeExecutor
    from omnigent.inner.codex_native_executor import CodexNativeExecutor

    return isinstance(executor, (ClaudeNativeExecutor, CodexNativeExecutor))


def scope_framework_notices(
    messages: list[dict[str, Any]], *, keep_current: bool
) -> list[dict[str, Any]]:
    """Keep notice blocks only on the latest user message, and only when wanted.

    The runner replays every prior user message with the notice it was sent
    with, so a prior turn's notice would repeat (and an old preset's text with
    it) on every later turn. Prior turns lose their notice blocks; a text-only
    message goes back to its plain string. The latest user message keeps its
    notice when *keep_current* is true; otherwise a text-only one goes back to
    its plain string and a multimodal one stays as it was.

    :param messages: Role-keyed messages from the executor adapter.
    :param keep_current: Whether the executor reads the current turn's notice.
    :returns: *messages*, with contents rewritten in place.
    """
    current = max(
        (i for i, message in enumerate(messages) if message.get("role") == "user"), default=-1
    )
    for index, message in enumerate(messages):
        content = message.get("content")
        if not isinstance(content, list) or not any(_is_notice(b) for b in content):
            continue
        if index == current and keep_current:
            continue
        visible = [block for block in content if not _is_notice(block)]
        text_only = all(
            isinstance(block, dict) and block.get("type") == "input_text" for block in visible
        )
        if text_only:
            message["content"] = "\n".join(
                str(block.get("text", "")) for block in visible if isinstance(block, dict)
            )
        elif index != current:
            message["content"] = visible
    return messages


def _is_notice(block: object) -> bool:
    return isinstance(block, dict) and block.get("type") == FRAMEWORK_NOTICE_BLOCK_TYPE
