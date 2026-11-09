"""Tests for the reply-text check behind the pop-up guard (AE patch)."""

from __future__ import annotations

import json
from pathlib import Path

from omnigent.harnesses.claude_native.ae_reply_text import reply_text_since_last_prompt
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
        [_human(), _assistant(_TEXT), _assistant(_TOOL), _RESULT, _assistant(_TOOL)],
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
