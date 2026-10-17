"""The model the Agents pane shows for a child session."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from omnigent.server.routes._sessions.ae_child_model import child_display_model


def _conv(**overrides: Any) -> Any:
    fields: dict[str, Any] = {"reported_model": None, "session_usage": {}, "model_override": None}
    fields.update(overrides)
    return SimpleNamespace(**fields)


def test_harness_report_wins() -> None:
    conv = _conv(
        reported_model="claude-sonnet-5-5",
        session_usage={"by_model": {"gpt-6-astra": {"total_tokens": 900}}},
        model_override="claude-opus-5-5",
    )
    assert child_display_model(conv) == "claude-sonnet-5-5"


def test_falls_back_to_the_model_with_the_most_tokens() -> None:
    conv = _conv(
        session_usage={
            "by_model": {
                "gpt-5.6-sol": {"total_tokens": 120},
                "gpt-6-astra": {"total_tokens": 4800},
                "bad": "not a dict",
            }
        }
    )
    assert child_display_model(conv) == "gpt-6-astra"


def test_falls_back_to_the_requested_model() -> None:
    assert child_display_model(_conv(model_override="claude-haiku-5-5")) == "claude-haiku-5-5"


def test_none_when_nothing_names_a_model() -> None:
    assert child_display_model(_conv()) is None
    assert child_display_model(_conv(session_usage={"by_model": "garbage"})) is None
    assert child_display_model(_conv(session_usage=None)) is None
