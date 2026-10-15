"""Host-owned Claude login processes; return authorization links, never tokens."""

from __future__ import annotations

import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from urllib.parse import urlparse

from omnigent.onboarding.claude_accounts import _read, _valid_name, change_account

_TTL = 600
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_URL = re.compile(r"https://[^\s\x1b\x07]+(?=[\s\x1b\x07])")
_TOKEN = re.compile(r"sk-ant-oat[\w-]{20,}(?=[\s\x1b\x07])")
_LOCK = threading.RLock()
_JOBS: dict[str, Login] = {}


@dataclass
class Login:
    name: str
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    status: str = "starting"
    url: str = ""
    error: str = ""
    created: float = field(default_factory=time.monotonic)
    cancel: threading.Event = field(default_factory=threading.Event)
    code: str = ""

    def public(self) -> dict[str, str]:
        return {
            "login_id": self.id,
            "login_status": self.status,
            "login_url": self.url,
            "error": self.error,
        }


def authorization_url(output: str) -> str | None:
    for match in _URL.finditer(output):
        url = match.group()
        parsed = urlparse(url)
        if (
            parsed.scheme == "https"
            and parsed.hostname in {"claude.com", "claude.ai"}
            and parsed.path in {"/oauth/authorize", "/cai/oauth/authorize"}
        ):
            return url
    return None


def _run(job: Login) -> None:
    # Import only on supported hosts; a missing CLI/PTY dependency is a visible failure.
    process = None
    try:
        import pexpect

        binary = shutil.which("claude")
        if binary is None:
            raise RuntimeError("Claude Code is not installed")
        with tempfile.TemporaryDirectory(prefix="omnigent-claude-login-") as directory:
            env = {
                k: v
                for k, v in os.environ.items()
                if k
                not in {
                    "CLAUDE_CODE_OAUTH_TOKEN",
                    "ANTHROPIC_API_KEY",
                    "ANTHROPIC_AUTH_TOKEN",
                    "ANTHROPIC_BASE_URL",
                    "CLAUDECODE",
                    "CLAUDE_CODE_USE_BEDROCK",
                    "CLAUDE_CODE_USE_VERTEX",
                }
            }
            env.update(CLAUDE_CONFIG_DIR=directory, BROWSER="true", NO_COLOR="1", TERM="dumb")
            process = pexpect.spawn(
                binary,
                ["setup-token"],
                env=env,
                encoding="utf-8",
                codec_errors="replace",
                dimensions=(40, 4096),
                echo=False,
            )
            output = ""
            while not job.cancel.is_set() and time.monotonic() - job.created < _TTL:
                with _LOCK:
                    code, job.code = job.code, ""
                if code:
                    process.send(code + "\r")
                ended = False
                try:
                    output = (output + process.read_nonblocking(8192, timeout=0.25))[-131072:]
                except pexpect.TIMEOUT:
                    continue
                except pexpect.EOF:
                    ended = True
                url = authorization_url(output)
                with _LOCK:
                    if url and not job.url:
                        job.url, job.status = url, "waiting"
                clean = _ANSI.sub("", output)
                token = _TOKEN.search(clean)
                if "OAuth error:" in clean:
                    job.status = "failed"
                    job.error = (
                        "Claude rejected the authorization code. "
                        "Start sign-in again and use the new code."
                    )
                    return
                if token:
                    with _LOCK:
                        if job.cancel.is_set():
                            break
                        saved = change_account("claude-oauth-add", job.name, token.group())
                        job.status = "complete" if saved.stored else "failed"
                        job.error = (
                            "" if saved.stored else (saved.reason or "Could not save account.")
                        )
                    output = ""
                    return
                if ended:
                    break
            with _LOCK:
                job.status = "cancelled" if job.cancel.is_set() else "failed"
                job.error = (
                    ""
                    if job.cancel.is_set()
                    else "Claude sign-in ended or expired. Try signing in again."
                )
    except Exception:
        with _LOCK:
            job.status = "failed"
            job.error = (
                "Could not start Claude sign-in. Check that Claude Code is installed on this host."
            )
    finally:
        if process is not None:
            process.close(force=True)
        with _LOCK:
            job.code = ""
            job.url = "" if job.status != "waiting" else job.url


def login_action(kind: str, name_or_id: str, code: str = "") -> dict[str, str]:
    """Start, poll, submit a one-time code, or cancel an owner-authorized login."""
    with _LOCK:
        for key, job in list(_JOBS.items()):
            if time.monotonic() - job.created > _TTL + 60:
                job.cancel.set()
                del _JOBS[key]
        if kind == "claude-login-start":
            if not _valid_name(name_or_id):
                raise ValueError("Enter an account label using letters, numbers, spaces, - or _.")
            if name_or_id in _read()["accounts"]:
                raise ValueError("That account label already exists. Choose another label.")
            if any(
                j.name == name_or_id and j.status in {"starting", "waiting", "exchanging"}
                for j in _JOBS.values()
            ):
                raise ValueError(
                    "Sign-in for that label is already open. Finish or cancel it first."
                )
            if sum(j.status in {"starting", "waiting", "exchanging"} for j in _JOBS.values()) >= 3:
                raise ValueError("Finish or cancel an existing sign-in before starting another.")
            job = Login(name_or_id)
            _JOBS[job.id] = job
            threading.Thread(target=_run, args=(job,), daemon=True).start()
            return job.public()
        job = _JOBS.get(name_or_id)
        if job is None:
            raise ValueError("Sign-in expired or the host restarted. Start sign-in again.")
        if kind == "claude-login-cancel":
            job.cancel.set()
            if job.status in {"starting", "waiting", "exchanging"}:
                job.status = "cancelled"
        elif kind == "claude-login-code":
            if (
                job.status != "waiting"
                or not code
                or len(code) > 2048
                or any(ord(c) < 32 or ord(c) == 127 for c in code)
            ):
                raise ValueError("Paste the one-time authorization code shown by Claude.")
            job.code = code
            job.status = "exchanging"
        elif kind != "claude-login-poll":
            raise ValueError("Unknown sign-in action.")
        return job.public()
