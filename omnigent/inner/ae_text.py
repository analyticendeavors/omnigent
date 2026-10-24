"""Text cleaning and one constant shared by the lead-notice modules.

Added 2026-10-24 by omnigent-ae so ``ae_roles`` and ``ae_reviewers`` (which
``ae_roles`` imports) use one sanitizer without importing each other.
"""

from __future__ import annotations

import re

# Control characters, C1 controls and the Unicode line and paragraph separators,
# written as escapes so no invisible character sits in this file.
CONTROL = re.compile("[\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029]+")
# The Helpers rule value that keeps work with the lead's own subagents.
OWN = "own"


def text(value: object, limit: int) -> str:
    """*value* as one clean line of at most *limit* characters."""
    return CONTROL.sub(" ", str(value or "")).strip()[:limit]
