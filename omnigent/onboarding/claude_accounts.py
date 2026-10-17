"""Named Claude subscription tokens, separate from the CLI's primary login."""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path

from omnigent.onboarding import secrets
from omnigent.onboarding.harness_auth import StoreCredentialResult
from omnigent.onboarding.provider_config import _config_path

CLAUDE_ACCOUNT_LABEL_KEY = "omnigent.claude_native.account"
CLAUDE_PROVIDER_ENV_KEYS = (
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
)


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
    labels = state.get("labels", {})
    if not isinstance(labels, dict) or any(
        key not in ["", *state["accounts"]] or not isinstance(label, str) or not _valid_name(label)
        for key, label in labels.items()
    ):
        raise RuntimeError("Invalid Claude account labels on this host.")
    return state


def _valid_name(name: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _-]{0,63}", name))


def account_descriptors() -> list[dict[str, str | None]]:
    try:
        state = _read()
    except RuntimeError:
        return []
    available = []
    for name in state["accounts"]:
        try:
            if secrets.load_secret(f"claude-oauth-{name}"):
                available.append(name)
        except Exception:
            continue
    return [
        {
            "family": "claude-oauth-active" if name == state["active"] else "claude-oauth",
            "source": state.get("labels", {}).get(name, name or "Default CLI account"),
            "env_var": name,
        }
        for name in ["", *available]
    ]


_ACCOUNT_LOCK = threading.RLock()


def change_account(
    kind: str, name: str, token: str = "", *, label: str | None = None
) -> StoreCredentialResult:
    with _ACCOUNT_LOCK:
        return _change_account(kind, name, token, label=label)


def _change_account(
    kind: str, name: str, token: str = "", *, label: str | None = None
) -> StoreCredentialResult:
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
        if kind == "claude-oauth-rename":
            if name and name not in state["accounts"]:
                return StoreCredentialResult(False, None, "Unknown Claude account.")
            label = (label or "").strip()
            if not _valid_name(label):
                return StoreCredentialResult(
                    False, None, "Use a label of up to 64 letters, digits, spaces, - or _."
                )
            labels = state.setdefault("labels", {})
            if any(
                other != name and labels.get(other, other or "Default CLI account") == label
                for other in ["", *state["accounts"]]
            ):
                return StoreCredentialResult(False, None, "That account label already exists.")
            labels[name] = label
        elif kind == "claude-oauth-add":
            if name in state["accounts"]:
                return StoreCredentialResult(
                    False, None, "That account name already exists. Choose another name."
                )
            secrets.store_secret(f"claude-oauth-{name}", token.strip())
            state["accounts"].append(name)
        elif kind != "claude-oauth-select" or (name and name not in state["accounts"]):
            return StoreCredentialResult(False, None, "Unknown Claude account.")
        if kind != "claude-oauth-rename":
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


def account_env(name: str | None = None) -> dict[str, str]:
    state = _read()
    if name is None:
        name = state["active"]
    if not name:
        return {}
    if name not in state["accounts"]:
        raise RuntimeError("The selected Claude account is unavailable on this host.")
    token = secrets.load_secret(f"claude-oauth-{name}")
    if not token:
        raise RuntimeError(
            "The selected Claude account token is unavailable. Select another account."
        )
    # ``OMNIGENT_CLAUDE_ACCOUNT`` names the account to the statusLine shim, so
    # usage readers can tell a backup account's windows from the default login's.
    return {
        "CLAUDE_CODE_OAUTH_TOKEN": token,
        "ANTHROPIC_API_KEY": "",
        "ANTHROPIC_AUTH_TOKEN": "",
        "OMNIGENT_CLAUDE_ACCOUNT": name,
    }


def account_label(name: str) -> str:
    """Return the editable label for *name*, or *name* itself; never loads secrets."""
    try:
        label = _read().get("labels", {}).get(name)
    except Exception:
        return name
    return label if isinstance(label, str) and label else name


def account_env_for_launch(
    env: dict[str, str], *, account_name: str | None = None
) -> dict[str, str]:
    """Apply subscription choice only when no explicit provider owns authentication."""
    if any(env.get(key, os.environ.get(key)) for key in CLAUDE_PROVIDER_ENV_KEYS):
        if account_name is not None:
            raise RuntimeError("Claude account selection conflicts with provider authentication.")
        return {}
    return account_env(account_name)
