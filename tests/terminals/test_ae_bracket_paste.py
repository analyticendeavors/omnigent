"""Tests for :mod:`omnigent.terminals._ae_bracket_paste`."""

from __future__ import annotations

import os
import pty

import pytest

from omnigent.terminals import _ae_bracket_paste
from omnigent.terminals._ae_bracket_paste import ae_infer_bracket_paste


@pytest.mark.parametrize(
    ("flag", "command", "alternate_on", "editor", "expected"),
    [
        ("1", "python3", False, False, True),
        ("0", "bash", False, True, False),
        ("", "bash", False, True, True),
        ("", "-bash", False, True, True),
        ("", "/usr/bin/zsh", False, True, True),
        ("", "fish", False, True, True),
        ("", "bash", False, False, False),
        ("", "bash", True, True, False),
        ("", "vim", False, True, False),
        ("", "sh", False, True, False),
        ("", "", False, True, False),
    ],
)
def test_reported_flag_wins_and_empty_flag_infers_for_a_shell_prompt(
    monkeypatch: pytest.MonkeyPatch,
    flag: str,
    command: str,
    alternate_on: bool,
    editor: bool,
    expected: bool,
) -> None:
    monkeypatch.setattr(_ae_bracket_paste, "_line_editor_active", lambda _tty: editor)
    assert ae_infer_bracket_paste(flag, "/dev/pts/9", command, alternate_on) is expected


def test_line_editor_active_reads_the_tty_canonical_mode() -> None:
    termios = pytest.importorskip("termios")
    leader, follower = pty.openpty()
    try:
        tty = os.ttyname(follower)
        assert _ae_bracket_paste._line_editor_active(tty) is False
        attrs = termios.tcgetattr(follower)
        attrs[3] &= ~termios.ICANON
        termios.tcsetattr(follower, termios.TCSANOW, attrs)
        assert _ae_bracket_paste._line_editor_active(tty) is True
    finally:
        os.close(leader)
        os.close(follower)
    assert _ae_bracket_paste._line_editor_active("") is False
    assert _ae_bracket_paste._line_editor_active("/nonexistent/tty") is False
