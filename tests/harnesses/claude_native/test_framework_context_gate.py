"""The framework-context hook sends the team and roles notice once, then a marker."""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest

from omnigent.harnesses.claude_native import hook as claude_native_hook
from omnigent.harnesses.claude_native.bridge import (
    CLAUDE_FRAMEWORK_CONTEXT_FILE,
    CLAUDE_FRAMEWORK_LAST_FILE,
    CLAUDE_FRAMEWORK_STATE_FILE,
    FRAMEWORK_REFRESH_EVERY,
)
from omnigent.inner.ae_roles import NOTICE_PREFIX

BODY = (
    f"{NOTICE_PREFIX} Auto collaboration is enabled for this chat. Be the lead.\n\n"
    "Roles preset: Balanced. Name a role for each helper you start.\n"
    "- Lead: you, on opus, high.\n"
    "- Builder: sonnet, medium.\n"
    "Model changes: tell."
)


def _prompt(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    bridge: Path,
    text: str | None = BODY,
    session_id: str = "claude-1",
) -> str:
    """Run one UserPromptSubmit through the hook; return the context it added ('' for none)."""
    if text is not None:
        (bridge / CLAUDE_FRAMEWORK_CONTEXT_FILE).write_text(text, encoding="utf-8")
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"session_id": session_id})))
    assert claude_native_hook.main(["framework-context", "--bridge-dir", str(bridge)]) == 0
    out = capsys.readouterr().out
    return json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""


def _start(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    bridge: Path,
    source: str,
    session_id: str = "claude-1",
) -> str:
    payload = {"hook_event_name": "SessionStart", "source": source, "session_id": session_id}
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
    argv = ["framework-context-session-start", "--bridge-dir", str(bridge)]
    assert claude_native_hook.main(argv) == 0
    out = capsys.readouterr().out
    return json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""


def _stop(monkeypatch: pytest.MonkeyPatch, bridge: Path) -> None:
    payload = {"hook_event_name": "Stop", "session_id": "claude-1"}
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
    assert claude_native_hook.main(["--bridge-dir", str(bridge)]) == 0


def _is_marker(text: str) -> bool:
    return text.startswith("Omnigent notice v") and "\n" not in text


def test_first_prompt_is_full_and_the_next_is_a_marker(monkeypatch, capsys, tmp_path) -> None:
    first = _prompt(monkeypatch, capsys, tmp_path)
    assert first == BODY
    assert (tmp_path / CLAUDE_FRAMEWORK_LAST_FILE).read_text() == BODY
    second = _prompt(monkeypatch, capsys, tmp_path)
    assert _is_marker(second)
    assert second.endswith("still in force; preset Balanced; Lead: you, on opus, high.")
    assert len(second) < len(BODY) // 2


def test_every_twentieth_prompt_is_full_again(monkeypatch, capsys, tmp_path) -> None:
    kinds = []
    for _ in range(FRAMEWORK_REFRESH_EVERY * 2 + 1):
        out = _prompt(monkeypatch, capsys, tmp_path)
        kinds.append("marker" if _is_marker(out) else "full")
        _stop(monkeypatch, tmp_path)
    full_at = [i + 1 for i, kind in enumerate(kinds) if kind == "full"]
    assert full_at == [1, 21, 41]


def test_a_refresh_waits_for_the_turn_to_end(monkeypatch, capsys, tmp_path) -> None:
    assert _prompt(monkeypatch, capsys, tmp_path) == BODY
    for _ in range(FRAMEWORK_REFRESH_EVERY - 1):
        assert _is_marker(_prompt(monkeypatch, capsys, tmp_path))
    # The 20th prompt is due a refresh, but the full block went out earlier in this same
    # turn (no Stop yet): marker only.
    assert _is_marker(_prompt(monkeypatch, capsys, tmp_path))
    _stop(monkeypatch, tmp_path)
    assert _prompt(monkeypatch, capsys, tmp_path) == BODY


def test_a_mid_turn_queued_prompt_gets_the_marker_only(monkeypatch, capsys, tmp_path) -> None:
    assert _prompt(monkeypatch, capsys, tmp_path) == BODY  # the turn's own prompt
    # Steering typed while the turn runs: the server attaches the notice again.
    assert _is_marker(_prompt(monkeypatch, capsys, tmp_path))
    assert _is_marker(_prompt(monkeypatch, capsys, tmp_path))


def test_a_changed_notice_goes_out_in_full(monkeypatch, capsys, tmp_path) -> None:
    _prompt(monkeypatch, capsys, tmp_path)
    changed = BODY.replace("Roles preset: Balanced.", "Roles preset: YOLO.")
    assert _prompt(monkeypatch, capsys, tmp_path, changed) == changed
    assert _is_marker(_prompt(monkeypatch, capsys, tmp_path, changed))


@pytest.mark.parametrize(
    "edit",
    [
        ("Auto collaboration is enabled", "Solo collaboration is enabled"),
        ("Be the lead.", "Be the lead. Team: [child_1]"),
        ("- Builder: sonnet, medium.", "- Builder: opus, high."),
        ("Model changes: tell.", "Model changes: ask first."),
    ],
)
def test_any_rule_change_is_a_full_send(monkeypatch, capsys, tmp_path, edit) -> None:
    _prompt(monkeypatch, capsys, tmp_path)
    changed = BODY.replace(*edit)
    assert changed != BODY
    assert _prompt(monkeypatch, capsys, tmp_path, changed) == changed


def test_a_new_lead_line_alone_stays_a_marker(monkeypatch, capsys, tmp_path) -> None:
    _prompt(monkeypatch, capsys, tmp_path)
    routed = BODY.replace("- Lead: you, on opus, high.", "- Lead: you, on haiku, low.")
    out = _prompt(monkeypatch, capsys, tmp_path, routed)
    assert _is_marker(out)
    assert out.endswith("Lead: you, on haiku, low.")


def test_a_new_claude_session_id_is_a_full_send(monkeypatch, capsys, tmp_path) -> None:
    _prompt(monkeypatch, capsys, tmp_path)
    assert _prompt(monkeypatch, capsys, tmp_path, session_id="claude-2") == BODY


@pytest.mark.parametrize("source", ["compact", "resume"])
def test_session_start_resends_the_last_full_block(monkeypatch, capsys, tmp_path, source) -> None:
    _prompt(monkeypatch, capsys, tmp_path)
    assert _start(monkeypatch, capsys, tmp_path, source) == BODY
    # The block just went out, so the next prompt is a marker, not a second full send.
    assert _is_marker(_prompt(monkeypatch, capsys, tmp_path))


@pytest.mark.parametrize("source", ["startup", "clear"])
def test_session_start_resets_the_gate(monkeypatch, capsys, tmp_path, source) -> None:
    _prompt(monkeypatch, capsys, tmp_path)
    assert _start(monkeypatch, capsys, tmp_path, source) == ""
    assert not (tmp_path / CLAUDE_FRAMEWORK_STATE_FILE).exists()
    assert _prompt(monkeypatch, capsys, tmp_path) == BODY


def test_compact_without_a_prior_full_block_emits_nothing(monkeypatch, capsys, tmp_path) -> None:
    assert _start(monkeypatch, capsys, tmp_path, "compact") == ""


def test_other_notices_pass_through_whole(monkeypatch, capsys, tmp_path) -> None:
    resize = "Note: the attached image was downscaled."
    both = f"{resize}\n\n{BODY}"
    assert _prompt(monkeypatch, capsys, tmp_path, both) == both
    second = _prompt(monkeypatch, capsys, tmp_path, both)
    assert second.startswith(resize + "\n\n")
    assert _is_marker(second.split("\n\n", 1)[1])
    assert _prompt(monkeypatch, capsys, tmp_path, resize) == resize


def test_a_prompt_with_no_notice_adds_nothing(monkeypatch, capsys, tmp_path) -> None:
    assert _prompt(monkeypatch, capsys, tmp_path, None) == ""


def test_the_helper_notice_marks_itself_a_helper(monkeypatch, capsys, tmp_path) -> None:
    from omnigent.inner.ae_roles import HELPER_NOTICE

    helper = f"{NOTICE_PREFIX} {HELPER_NOTICE}"
    assert _prompt(monkeypatch, capsys, tmp_path, helper) == helper
    out = _prompt(monkeypatch, capsys, tmp_path, helper)
    assert _is_marker(out)
    assert "preset helper" in out
