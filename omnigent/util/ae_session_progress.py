"""
The wire contract for a terminal agent's live spinner line.

Shared by the claude-native forwarder (which posts the event) and the
sessions route (which validates and publishes it), so the type string and
field bounds cannot drift apart.
"""

from __future__ import annotations

from typing import Final

EXTERNAL_SESSION_PROGRESS_TYPE: Final = "external_session_progress"
SESSION_PROGRESS_SSE_TYPE: Final = "session.progress"

MAX_LABEL_CHARS: Final = 40
MAX_ELAPSED_CHARS: Final = 20
MAX_TOKENS_CHARS: Final = 30
# A week; anything longer is a parse error, not a turn.
MAX_ELAPSED_S: Final = 7 * 24 * 3600
