"""Responsive collaboration controls and separate context meters in a browser.

Run against a built Storybook, or set AE_UI_STORYBOOK_URL to its local dev URL.
"""

import os
import threading
from collections.abc import Iterator
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from playwright.sync_api import Page, expect

pytestmark = pytest.mark.visual


@pytest.fixture(scope="module")
def collaboration_storybook() -> Iterator[str]:
    external = os.environ.get("AE_UI_STORYBOOK_URL")
    if external:
        yield external.rstrip("/")
        return
    root = Path(__file__).resolve().parents[3] / "web" / "storybook-static"
    if not (root / "index.html").is_file():
        pytest.skip("Build Storybook or set AE_UI_STORYBOOK_URL to run browser checks.")
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=root)
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.parametrize("width", [390, 1280])
def test_team_selection_and_model_choices(
    page: Page, collaboration_storybook: str, width: int
) -> None:
    page.set_viewport_size({"width": width, "height": 844})
    page.goto(f"{collaboration_storybook}/iframe.html?id=components-aeteamcontrol--mixed-team")
    expect(page.get_by_role("checkbox", name="Codex")).to_be_checked()
    expect(page.get_by_role("checkbox", name="Claude")).to_be_checked()
    page.get_by_role("combobox", name="Model for Codex").select_option("example-model")
    expect(page.get_by_role("combobox", name="Model for Codex")).to_have_value("example-model")
    expect(
        page.get_by_role("checkbox", name="Another agent Authentication required")
    ).to_be_disabled()
    page.get_by_role("button", name="Solo One agent handles the work").click()
    expect(page.get_by_role("checkbox")).to_have_count(0)
    page.get_by_role("button", name="Team A lead with collaborators").click()
    expect(page.get_by_role("checkbox", name="Claude")).to_be_checked()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")


def test_codex_and_claude_have_separate_context_rows(
    page: Page, collaboration_storybook: str
) -> None:
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(
        f"{collaboration_storybook}/iframe.html?id=components-aeplanlimitspanel--with-collaborators"
    )
    expect(page.get_by_test_id("ae-context-active")).to_contain_text("Codex")
    expect(page.get_by_test_id("ae-context-collaborators")).to_contain_text("Claude")
    expect(page.get_by_test_id("ae-context-active").get_by_role("progressbar")).to_have_attribute(
        "aria-valuenow", "30"
    )
    expect(page.get_by_test_id("ae-limits-plans")).to_contain_text("Weekly limit")
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")


def test_unknown_context_is_not_zero_usage(page: Page, collaboration_storybook: str) -> None:
    page.goto(
        f"{collaboration_storybook}/iframe.html?id=components-aeplanlimitspanel--missing-telemetry"
    )
    expect(page.get_by_test_id("ae-context-active").get_by_role("progressbar")).to_have_count(0)
    expect(page.get_by_test_id("ae-context-unavailable")).to_contain_text("not reported")
