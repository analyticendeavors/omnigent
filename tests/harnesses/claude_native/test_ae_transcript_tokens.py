"""Token tally over Claude transcripts (omnigent-ae)."""

from __future__ import annotations

import json
from pathlib import Path

from omnigent.harnesses.claude_native.ae_transcript_tokens import TranscriptTokenTally


def _line(request_id: str, inp: int, out: int, *, cr: int = 0, side: bool = False) -> str:
    entry: dict[str, object] = {
        "requestId": request_id,
        "message": {
            "role": "assistant",
            "usage": {
                "input_tokens": inp,
                "output_tokens": out,
                "cache_read_input_tokens": cr,
            },
        },
    }
    if side:
        entry["isSidechain"] = True
    return json.dumps(entry) + "\n"


def test_second_poll_parses_only_new_bytes(tmp_path: Path) -> None:
    parent = tmp_path / "s.jsonl"
    parent.write_text(_line("a", 1, 1) + _line("b", 2, 2), encoding="utf-8")
    tally = TranscriptTokenTally()
    assert tally.update(parent) == (3, 3, 0)
    assert tally.lines_parsed == 2
    tally.update(parent)
    assert tally.lines_parsed == 2
    with parent.open("a", encoding="utf-8") as handle:
        handle.write(_line("c", 4, 4, cr=1))
    assert tally.update(parent) == (8, 7, 1)
    assert tally.lines_parsed == 3


def test_shrunk_or_replaced_file_keeps_totals_without_double_count(tmp_path: Path) -> None:
    parent = tmp_path / "s.jsonl"
    parent.write_text(_line("a", 10, 1) + _line("b", 20, 2), encoding="utf-8")
    tally = TranscriptTokenTally()
    assert tally.update(parent) == (30, 3, 0)
    parent.write_text(_line("a", 10, 1), encoding="utf-8")  # shrank
    assert tally.update(parent) == (30, 3, 0)
    parent.unlink()
    parent.write_text(_line("a", 10, 1) + _line("c", 5, 5) + _line("d", 1, 1), encoding="utf-8")
    assert tally.update(parent) == (36, 9, 0)


def test_resumed_transcript_replaying_request_ids_is_not_counted_twice(tmp_path: Path) -> None:
    old = tmp_path / "old.jsonl"
    old.write_text(_line("a", 10, 1) + _line("b", 20, 2), encoding="utf-8")
    tally = TranscriptTokenTally()
    assert tally.update(old) == (30, 3, 0)
    new = tmp_path / "new.jsonl"
    new.write_text(_line("a", 10, 1) + _line("b", 20, 2) + _line("c", 1, 1), encoding="utf-8")
    assert tally.update(new) == (31, 4, 0)
    # Back to the old path: still the same totals.
    assert tally.update(old) == (31, 4, 0)


def test_subagent_files_count_once_across_files_and_grow_later(tmp_path: Path) -> None:
    parent = tmp_path / "s.jsonl"
    parent.write_text(_line("p", 1, 1) + _line("x", 99, 99, side=True), encoding="utf-8")
    subs = tmp_path / "s" / "subagents"
    subs.mkdir(parents=True)
    first = subs / "agent-a.jsonl"
    first.write_text(_line("s1", 2, 2), encoding="utf-8")
    (subs / "agent-b.jsonl").write_text(_line("s1", 2, 2), encoding="utf-8")  # same request
    tally = TranscriptTokenTally()
    assert tally.update(parent) == (3, 3, 0)
    with first.open("a", encoding="utf-8") as handle:
        handle.write(_line("s2", 4, 4))
    assert tally.update(parent) == (7, 7, 0)


def test_bad_byte_and_half_written_lines_do_not_stop_the_tally(tmp_path: Path) -> None:
    parent = tmp_path / "s.jsonl"
    parent.write_bytes(
        _line("a", 1, 1).encode() + b'{"requestId": "\xff\xfe"}\n' + b'{"requestId": "half"'
    )
    tally = TranscriptTokenTally()
    assert tally.update(parent) == (1, 1, 0)
    with parent.open("ab") as handle:
        handle.write(b', "message": {"role": "assistant", "usage": {"input_tokens": 5}}}\n')
    assert tally.update(parent) == (6, 1, 0)
