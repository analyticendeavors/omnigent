"""Named Claude subscription tokens, separate from the CLI's primary login."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from omnigent.onboarding import secrets
from omnigent.onboarding.harness_auth import StoreCredentialResult
from omnigent.onboarding.provider_config import _config_path


def _path() -> Path:
    return Path(_config_path()).with_name("claude-accounts.json")


def _read() -> dict:
    try:
        state = json.loads(_path().read_text())
    except FileNotFoundError:
        return {"accounts": [], "active": ""}
    except (OSError, ValueError) as exc:
        raise RuntimeError(
            "Could not read Claude accounts. Repair claude-accounts.json on this host."
        ) from exc
    if (
        not isinstance(state, dict)
        or not isinstance(state.get("accounts"), list)
        or not isinstance(state.get("active"), str)
        or any(not isinstance(name, str) or not _valid_name(name) for name in state["accounts"])
        or len(set(state["accounts"])) != len(state["accounts"])
        or (state["active"] and state["active"] not in state["accounts"])
    ):
        raise RuntimeError("Invalid Claude accounts. Repair claude-accounts.json on this host.")
    return state


def _valid_name(name: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _-]{0,63}", name))


def account_descriptors() -> list[dict[str, str | None]]:
    try:
        state = _read()
    except RuntimeError:
        return []
    return [
        {
            "family": "claude-oauth-active" if name == state["active"] else "claude-oauth",
            "source": name or "Default CLI account",
            "env_var": name,
        }
        for name in ["", *state["accounts"]]
    ]


def change_account(kind: str, name: str, token: str = "") -> StoreCredentialResult:
    if name and not _valid_name(name):
        return StoreCredentialResult(
            False, None, "Use a name of up to 64 letters, digits, spaces, - or _."
        )
    if kind == "claude-oauth-add" and (not name or not token.startswith("sk-ant-oat")):
        return StoreCredentialResult(
            False, None, "Enter a name and the OAuth token from claude setup-token."
        )
    try:
        state = _read()
        if kind == "claude-oauth-add":
            if name in state["accounts"]:
                return StoreCredentialResult(
                    False, None, "That account name already exists. Choose another name."
                )
            secrets.store_secret(f"claude-oauth-{name}", token.strip())
            state["accounts"].append(name)
        elif kind != "claude-oauth-select" or (name and name not in state["accounts"]):
            return StoreCredentialResult(False, None, "Unknown Claude account.")
        state["active"] = name
        path = _path()
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        with temporary.open("w") as handle:
            os.chmod(temporary, 0o600)
            json.dump(state, handle)
        temporary.replace(path)
        return StoreCredentialResult(True, name, None)
    except Exception:
        return StoreCredentialResult(
            False, None, "Could not save the Claude account on this host."
        )


def account_env() -> dict[str, str]:
    name = _read()["active"]
    if not name:
        return {}
    token = secrets.load_secret(f"claude-oauth-{name}")
    if not token:
        raise RuntimeError(
            "The selected Claude account token is unavailable. Select another account."
        )
    return {"CLAUDE_CODE_OAUTH_TOKEN": token, "ANTHROPIC_API_KEY": "", "ANTHROPIC_AUTH_TOKEN": ""}


def account_env_for_launch(env: dict[str, str]) -> dict[str, str]:
    """Apply subscription choice only when no explicit provider owns authentication."""
    provider_keys = (
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
    )
    if any(env.get(key, os.environ.get(key)) for key in provider_keys):
        return {}
    return account_env()
