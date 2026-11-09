"""Tests for the reply-text check behind the pop-up guard (AE patch)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from omnigent.harnesses.claude_native import ae_reply_text
from omnigent.harnesses.claude_native.ae_reply_text import reply_text_since_last_prompt
from omnigent.native import native_policy_hook
from omnigent.native.native_policy_hook import hook_payload_to_evaluation_request


def _write(path: Path, entries: list[object]) -> str:
    path.write_text("\n".join(e if isinstance(e, str) else json.dumps(e) for e in entries) + "\n")
    return str(path)


def _human(text: str = "go") -> dict:
    return {"type": "user", "message": {"role": "user", "content": text}}


def _assistant(*blocks: dict) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "content": list(blocks)}}


_THINK = {"type": "thinking", "thinking": ""}
_TEXT = {"type": "text", "text": "Here is my proposal."}
_TOOL = {"type": "tool_use", "id": "t1", "name": "AskUserQuestion", "input": {}}
_BASH = {"type": "tool_use", "id": "b1", "name": "Bash", "input": {}}
_RESULT = {"type": "user", "message": {"content": [{"type": "tool_result", "content": "ok"}]}}


def test_thinking_and_tool_use_only_is_false(tmp_path: Path) -> None:
    p = _write(tmp_path / "t.jsonl", [_human(), _assistant(_THINK), _assistant(_TOOL)])
    assert reply_text_since_last_prompt(p) is False


def test_text_then_tool_use_is_true(tmp_path: Path) -> None:
    p = _write(tmp_path / "t.jsonl", [_human(), _assistant(_TEXT), _assistant(_TOOL)])
    assert reply_text_since_last_prompt(p) is True


def test_tool_results_do_not_end_the_walk(tmp_path: Path) -> None:
    p = _write(
        tmp_path / "t.jsonl",
        [_human(), _assistant(_TEXT), _assistant(_BASH), _RESULT, _assistant(_TOOL)],
    )
    assert reply_text_since_last_prompt(p) is True


def test_text_before_last_human_prompt_is_false(tmp_path: Path) -> None:
    p = _write(
        tmp_path / "t.jsonl", [_human(), _assistant(_TEXT), _human("next"), _assistant(_TOOL)]
    )
    assert reply_text_since_last_prompt(p) is False


def test_text_block_human_prompt_counts(tmp_path: Path) -> None:
    prompt = {"type": "user", "message": {"content": [{"type": "text", "text": "hi"}]}}
    p = _write(tmp_path / "t.jsonl", [_assistant(_TEXT), prompt, _assistant(_TOOL)])
    assert reply_text_since_last_prompt(p) is False


def test_whitespace_text_is_not_visible(tmp_path: Path) -> None:
    blank = {"type": "text", "text": "  \n"}
    p = _write(tmp_path / "t.jsonl", [_human(), _assistant(blank), _assistant(_TOOL)])
    assert reply_text_since_last_prompt(p) is False


def test_missing_file_and_no_prompt_are_unknown(tmp_path: Path) -> None:
    assert reply_text_since_last_prompt(str(tmp_path / "nope.jsonl")) is None
    p = _write(tmp_path / "t.jsonl", ["garbage", _assistant(_THINK)])
    assert reply_text_since_last_prompt(p) is None


def test_garbage_lines_are_ignored(tmp_path: Path) -> None:
    p = _write(
        tmp_path / "t.jsonl", [_human(), _assistant(_TEXT), "{not json", "[1]", _assistant(_TOOL)]
    )
    assert reply_text_since_last_prompt(p) is True


def test_meta_and_sidechain_lines_are_ignored(tmp_path: Path) -> None:
    side = {**_assistant(_TEXT), "isSidechain": True}
    meta_human = {**_human("meta"), "isMeta": True}
    summary = {**_assistant(_TEXT), "isCompactSummary": True}
    p = _write(tmp_path / "t.jsonl", [_human(), side, summary, _assistant(_TOOL), meta_human])
    assert reply_text_since_last_prompt(p) is False


def _popup(tool_id: str, name: str = "AskUserQuestion") -> dict:
    return _assistant({"type": "tool_use", "id": tool_id, "name": name, "input": {}})


def test_raw_line_separators_do_not_cut_a_line(tmp_path: Path) -> None:
    text = {"type": "text", "text": "one\u2028two\u2029three\u0085four"}
    p = tmp_path / "t.jsonl"
    lines = [
        json.dumps(e, ensure_ascii=False) for e in (_human(), _assistant(text), _assistant(_TOOL))
    ]
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert "\u2028" in lines[1]
    assert reply_text_since_last_prompt(str(p)) is True


def test_user_line_with_tool_result_and_text_is_not_a_prompt(tmp_path: Path) -> None:
    mixed = {
        "type": "user",
        "message": {
            "content": [{"type": "tool_result", "content": "ok"}, {"type": "text", "text": "x"}]
        },
    }
    p = _write(tmp_path / "t.jsonl", [_human(), _assistant(_TEXT), mixed, _assistant(_TOOL)])
    assert reply_text_since_last_prompt(p) is True


def test_assistant_string_content_counts_as_text(tmp_path: Path) -> None:
    string_reply = {
        "type": "assistant",
        "message": {"role": "assistant", "content": "Plain reply."},
    }
    p = _write(tmp_path / "t.jsonl", [_human(), string_reply, _assistant(_TOOL)])
    assert reply_text_since_last_prompt(p) is True


def test_an_earlier_popup_is_a_boundary(tmp_path: Path) -> None:
    p = _write(
        tmp_path / "t.jsonl",
        [_human(), _assistant(_TEXT), _popup("a"), _RESULT, _popup("b")],
    )
    assert reply_text_since_last_prompt(p, "b") is False
    assert reply_text_since_last_prompt(p) is False


def test_new_text_after_an_earlier_popup_counts(tmp_path: Path) -> None:
    p = _write(
        tmp_path / "t.jsonl",
        [_human(), _assistant(_TEXT), _popup("a"), _RESULT, _assistant(_TEXT), _popup("b")],
    )
    assert reply_text_since_last_prompt(p, "b") is True
    assert reply_text_since_last_prompt(p) is True


def test_the_current_popup_already_on_disk_is_skipped(tmp_path: Path) -> None:
    both = _assistant(
        _TEXT, {"type": "tool_use", "id": "cur", "name": "AskUserQuestion", "input": {}}
    )
    p = _write(tmp_path / "t.jsonl", [_human(), both])
    assert reply_text_since_last_prompt(p, "cur") is True
    assert reply_text_since_last_prompt(p) is True
    # With the id known, a different pop-up in the same message is a boundary.
    assert reply_text_since_last_prompt(p, "other") is False


def _big_result(size: int) -> dict:
    return {
        "type": "user",
        "message": {"content": [{"type": "tool_result", "content": "x" * size}]},
    }


def test_a_large_tool_result_between_prompt_and_popup(tmp_path: Path) -> None:
    big = 3 * 1024 * 1024
    p = _write(tmp_path / "t.jsonl", [_human(), _big_result(big), _assistant(_TOOL)])
    assert reply_text_since_last_prompt(p) is False
    q = _write(
        tmp_path / "u.jsonl", [_human(), _assistant(_TEXT), _big_result(big), _assistant(_TOOL)]
    )
    assert reply_text_since_last_prompt(q) is True


def test_past_the_read_cap_is_unknown(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ae_reply_text, "_MAX_BYTES", 2 * 1024 * 1024)
    p = _write(tmp_path / "t.jsonl", [_human(), _big_result(3 * 1024 * 1024), _assistant(_TOOL)])
    assert reply_text_since_last_prompt(p) is None


def test_a_deeply_nested_line_never_raises(tmp_path: Path) -> None:
    deep = "[" * 100000 + "]" * 100000
    p = _write(tmp_path / "t.jsonl", [_human(), _assistant(_TEXT), deep, _assistant(_TOOL)])
    assert reply_text_since_last_prompt(p) in (True, None)


def test_a_failed_read_is_dropped_not_raised(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*_a: object, **_k: object) -> bool:
        raise RuntimeError("broken")

    monkeypatch.setattr(ae_reply_text, "reply_text_since_last_prompt", boom)
    out = native_policy_hook._with_reply_text_flag(
        "AskUserQuestion", {"q": 1, "ae_reply_text_before": True}, {"transcript_path": "x"}
    )
    assert out == {"q": 1}


def test_a_model_supplied_flag_is_dropped(tmp_path: Path) -> None:
    p = _write(tmp_path / "t.jsonl", [_human(), _assistant(_THINK)])
    forged = hook_payload_to_evaluation_request(
        "PreToolUse",
        {
            "tool_name": "AskUserQuestion",
            "tool_input": {"ae_reply_text_before": True},
            "transcript_path": p,
        },
    )
    assert forged is not None
    assert forged["event"]["data"]["arguments"] == {"ae_reply_text_before": False}
    unreadable = hook_payload_to_evaluation_request(
        "PreToolUse",
        {
            "tool_name": "AskUserQuestion",
            "tool_input": {"ae_reply_text_before": True},
            "transcript_path": str(tmp_path / "missing.jsonl"),
        },
    )
    assert unreadable is not None
    assert unreadable["event"]["data"]["arguments"] == {}


def test_ask_user_tool_is_stamped(tmp_path: Path) -> None:
    p = _write(tmp_path / "t.jsonl", [_human(), _assistant(_TEXT)])
    result = hook_payload_to_evaluation_request(
        "PreToolUse",
        {"tool_name": "mcp__ae__ask_user", "tool_input": {"q": 1}, "transcript_path": p},
    )
    assert result is not None
    assert result["event"]["data"]["arguments"] == {"q": 1, "ae_reply_text_before": True}


def test_a_late_flush_is_read_again(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / "t.jsonl"
    _write(p, [_human(), _assistant(_THINK)])
    slept: list[float] = []

    def late_flush(seconds: float) -> None:
        slept.append(seconds)
        _write(p, [_human(), _assistant(_TEXT)])

    monkeypatch.setattr(native_policy_hook.time, "sleep", late_flush)
    out = native_policy_hook._with_reply_text_flag(
        "AskUserQuestion", {}, {"transcript_path": str(p)}
    )
    assert slept == [native_policy_hook._REPLY_TEXT_RETRY_S]
    assert out == {"ae_reply_text_before": True}


def test_hook_payload_stamps_flag_for_popup_tools_only(tmp_path: Path) -> None:
    p = _write(tmp_path / "t.jsonl", [_human(), _assistant(_THINK)])
    popup = hook_payload_to_evaluation_request(
        "PreToolUse",
        {"tool_name": "AskUserQuestion", "tool_input": {"questions": []}, "transcript_path": p},
    )
    assert popup is not None
    assert popup["event"]["data"]["arguments"] == {
        "questions": [],
        "ae_reply_text_before": False,
    }
    other = hook_payload_to_evaluation_request(
        "PreToolUse", {"tool_name": "Bash", "tool_input": {"command": "ls"}, "transcript_path": p}
    )
    assert other is not None
    assert other["event"]["data"]["arguments"] == {"command": "ls"}
    unknown = hook_payload_to_evaluation_request(
        "PreToolUse", {"tool_name": "AskUserQuestion", "tool_input": {}}
    )
    assert unknown is not None
    assert unknown["event"]["data"]["arguments"] == {}
