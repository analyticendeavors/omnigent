"""Apply live permission presets through Codex's typed settings protocol."""

from __future__ import annotations

import asyncio
import contextlib

from omnigent.harnesses.codex_native.app_server import client_for_transport


def permission_settings(mode: str) -> dict[str, str]:
    """Return the explicit policy, reviewer and profile for a built-in preset."""
    profiles = {
        "ask-for-approval": ":workspace",
        "approve-for-me": ":workspace",
        "full-access": ":danger-full-access",
        "read-only": ":read-only",
    }
    if mode not in profiles:
        raise ValueError(f"Unknown Codex approval mode {mode!r}")
    return {
        "approvalPolicy": "never" if mode == "full-access" else "on-request",
        "approvalsReviewer": "auto_review" if mode == "approve-for-me" else "user",
        "permissions": profiles[mode],
    }


def _matches(settings: object, mode: str) -> bool:
    if not isinstance(settings, dict):
        return False
    expected = permission_settings(mode)
    if any(settings.get(key) != expected[key] for key in ("approvalPolicy", "approvalsReviewer")):
        return False
    profile = settings.get("activePermissionProfile")
    if isinstance(profile, dict):
        return profile.get("id") == expected["permissions"]
    sandbox = settings.get("sandboxPolicy")
    expected_type = {
        "ask-for-approval": "workspaceWrite",
        "approve-for-me": "workspaceWrite",
        "full-access": "dangerFullAccess",
        "read-only": "readOnly",
    }[mode]
    return isinstance(sandbox, dict) and sandbox.get("type") == expected_type


async def apply_permission_mode(
    transport: str,
    thread_id: str,
    mode: str,
    *,
    timeout_s: float = 10.0,
) -> bool:
    """Apply and verify a preset; return false when an older server silently ignores it.

    Resume subscribes this connection to settings notifications without supplying
    overrides. An RPC acknowledgement alone is insufficient on older Codex builds.
    """
    settings = permission_settings(mode)
    client = client_for_transport(transport, client_name="omnigent-codex-permissions")
    try:
        async with asyncio.timeout(timeout_s):
            await client.connect()
            response = await client.request(
                "thread/resume", {"threadId": thread_id, "excludeTurns": True}
            )
            result = response.get("result")
            if isinstance(result, dict):
                current = {**result, "sandboxPolicy": result.get("sandbox")}
                if _matches(current, mode):
                    return True
            await client.request("thread/settings/update", {"threadId": thread_id, **settings})
            async for event in client.iter_events():
                if event.get("method") != "thread/settings/updated":
                    continue
                params = event.get("params")
                if not isinstance(params, dict) or params.get("threadId") != thread_id:
                    continue
                if _matches(params.get("threadSettings"), mode):
                    return True
    except TimeoutError:
        return False
    finally:
        with contextlib.suppress(Exception):
            await client.close()
    return False
