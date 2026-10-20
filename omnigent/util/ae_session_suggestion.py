"""
The wire contract for a predicted next prompt (the composer's ghost text).

Shared by the claude-native forwarder (which posts the event) and the
sessions route (which validates and publishes it), so the type string and
the length bound cannot drift apart.
"""

from __future__ import annotations

from typing import Final

EXTERNAL_SESSION_SUGGESTION_TYPE: Final = "external_session_suggestion"
SESSION_SUGGESTION_SSE_TYPE: Final = "session.suggestion"

# One line in the composer; the side call is told to stay inside it.
MAX_SUGGESTION_CHARS: Final = 120
