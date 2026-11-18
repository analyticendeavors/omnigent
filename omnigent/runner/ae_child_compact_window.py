"""Give a child Claude session a smaller auto-compact window than its parent.

Parent and standalone sessions use the user's ``autoCompactWindow`` setting in
Claude Code's settings. A child session (made by another session in a family; decided by
:func:`omnigent.inner.ae_roles.is_family_child`, the rule the family view uses)
gets :data:`CHILD_AUTO_COMPACT_WINDOW` through
``CLAUDE_CODE_AUTO_COMPACT_WINDOW`` so it compacts earlier. The variable
outranks the setting, so a parent never gets it.
"""

from __future__ import annotations

from collections.abc import Mapping, MutableMapping

AUTO_COMPACT_WINDOW_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW"
# Tokens; kept under the parent's 400000 user setting.
CHILD_AUTO_COMPACT_WINDOW = "250000"


def apply_child_auto_compact_window(
    env: MutableMapping[str, str],
    *,
    is_family_child: bool,
    inherited_env: Mapping[str, str],
) -> None:
    """
    Set the child auto-compact window in a launch env, in place.

    Does nothing for a lead or standalone session, and never replaces a value the
    launch env or the runner env it inherits already carries.

    :param env: The Claude pane's launch env overrides, changed in place.
    :param is_family_child: Whether the session is a family child, from a parent
        session id or an ``ae.orch`` label (see ``ae_roles.is_family_child``).
    :param inherited_env: The runner environment the pane inherits.
    """
    if not is_family_child:
        return
    if AUTO_COMPACT_WINDOW_ENV in env or AUTO_COMPACT_WINDOW_ENV in inherited_env:
        return
    env[AUTO_COMPACT_WINDOW_ENV] = CHILD_AUTO_COMPACT_WINDOW
