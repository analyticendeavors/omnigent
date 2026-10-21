"""[ae] Infer a pane's bracketed paste mode where tmux cannot report it.

``#{bracket_paste_flag}`` exists only in tmux >= 3.7; older tmux expands it
empty, so the attach seed never replays ``?2004h``. A shell at its prompt
enabled bracketed paste before the browser attached, the browser xterm never
learns it, and a multi-line paste (the chat's Run button) is refused or runs
line by line. Ubuntu 26.04 ships tmux 3.6, so that is the box's case.
"""

from __future__ import annotations

import os
from typing import Final

try:
    import termios
except ImportError:  # Windows: no ttys, and no tmux either.
    termios = None  # type: ignore[assignment]

# Interactive shells whose line editor turns bracketed paste on by default
# (bash >= 5.1 readline, zsh >= 5.1 zle, fish >= 3.0).
_BRACKET_PASTE_SHELLS: Final[frozenset[str]] = frozenset({"bash", "zsh", "fish"})


def _line_editor_active(tty: str) -> bool:
    """Whether *tty* is out of canonical mode, as a line editor at its prompt leaves it.

    A shell running a script or the ``read`` builtin keeps canonical mode on.
    """
    if termios is None or not tty:
        return False
    try:
        fd = os.open(tty, os.O_RDONLY | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError:
        return False
    try:
        return not termios.tcgetattr(fd)[3] & termios.ICANON
    except termios.error:
        return False
    finally:
        os.close(fd)


def ae_infer_bracket_paste(flag: str, tty: str, current_command: str, alternate_on: bool) -> bool:
    """Return the pane's bracketed paste mode.

    A reported flag (``"0"``/``"1"``) wins. An empty flag means tmux cannot
    tell, so infer it: on when one of the shells above is the foreground
    command on the primary screen and its line editor holds the tty.

    :param flag: ``#{bracket_paste_flag}`` as tmux expanded it.
    :param tty: ``#{pane_tty}``.
    :param current_command: ``#{pane_current_command}``.
    :param alternate_on: Whether the pane is on the alternate screen.
    :returns: Whether the seed should enable bracketed paste.
    """
    if flag:
        return flag == "1"
    name = os.path.basename(current_command.strip()).lstrip("-")
    return not alternate_on and name in _BRACKET_PASTE_SHELLS and _line_editor_active(tty)
