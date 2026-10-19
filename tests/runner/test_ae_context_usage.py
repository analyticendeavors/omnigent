"""Context reconstruction preserves deferred semantics and isolates subprocesses."""

import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from omnigent.harnesses.claude_native import bridge as claude_bridge
from omnigent.runner import ae_context_usage as usage


@pytest.fixture(autouse=True)
def claude_bridge_root(tmp_path, monkeypatch):
    """Point the claude-native bridge root at a temp tree, the way bridge tests do."""
    trusted = tmp_path / "trusted"
    trusted.mkdir()
    root = trusted / "omnigent-test" / "claude-native"
    monkeypatch.setattr(claude_bridge, "_TRUSTED_PARENT", trusted)
    monkeypatch.setattr(claude_bridge, "_BRIDGE_ROOT_PARENT", root.parent)
    monkeypatch.setattr(claude_bridge, "_BRIDGE_ROOT", root)
    return root


@pytest.mark.parametrize(
    "categories",
    [
        [],
        [None],
        [{"name": "Unknown", "tokens": 1, "kind": "unknown"}],
        [{"name": "Messages", "tokens": -1, "kind": "used"}],
        [{"name": "Messages", "tokens": float("nan"), "kind": "used"}],
    ],
)
def test_normalize_rejects_incomplete_category_data(categories):
    with pytest.raises(ValueError):
        usage.normalize(
            {"categories": categories, "totalTokens": 123, "maxTokens": 200000},
            complete=True,
        )


def test_normalize_excludes_config_and_keeps_deferred():
    result = usage.normalize(
        {
            "categories": [
                {"name": "Messages", "tokens": 123, "kind": "used"},
                {"name": "MCP tools", "tokens": 99, "kind": "deferred"},
            ],
            "maxTokens": 200000,
            "totalTokens": 123,
            "autoCompactThreshold": 167000,
            "isAutoCompactEnabled": True,
            "mcpTools": [{"name": "test", "tokens": 99, "config": "secret"}],
            "memoryFiles": [{"path": "CLAUDE.md", "tokens": 10}],
            "agents": [{"agentType": "reviewer", "tokens": 20}],
            "skills": {"skillFrontmatter": [{"name": "review", "tokens": 30}]},
        },
        complete=False,
    )
    assert result["totalTokens"] == 123
    assert result["categories"][1]["kind"] == "deferred"
    assert result["autoCompactThreshold"] == 167000
    assert result["details"]["Custom agents"] == [{"name": "reviewer", "tokens": 20}]
    assert "secret" not in json.dumps(result)
    assert result["complete"] is False


@pytest.mark.asyncio
async def test_protocol_waits_for_mcp_and_uses_summary(tmp_path):
    script = tmp_path / "cli.py"
    script.write_text("""import json,sys
for line in sys.stdin:
 r=json.loads(line); kind=r['request']['subtype']
 if kind=='mcp_status': body={'mcpServers':[{'status':'connected'}]}
 elif kind=='get_context_usage':
  assert r['request']['detail']=='summary'
  body={'categories':[{'name':'Messages','tokens':50,'kind':'used'}],
        'maxTokens':200000,'totalTokens':50}
 else: body={}
 print(json.dumps({'type':'control_response','response':{'subtype':'success','request_id':r['request_id'],'response':body}}),flush=True)
""")
    result = await usage.probe([sys.executable, str(script)], {}, str(tmp_path))
    assert result["totalTokens"] == 50
    assert result["complete"] is True


@pytest.mark.asyncio
async def test_unsupported_harness_never_probes(monkeypatch):
    probe = AsyncMock()
    monkeypatch.setattr(usage, "probe", probe)
    response = await usage.handle_context_usage("session", harness="codex", server_client=None)
    body = json.loads(response.body)
    assert body["available"] is False
    assert body["final"] is True
    probe.assert_not_called()


@pytest.mark.asyncio
async def test_unknown_harness_is_pending_not_final(monkeypatch):
    """The runner has not loaded the session's spec yet; that is starting, not final."""
    probe = AsyncMock()
    monkeypatch.setattr(usage, "probe", probe)
    response = await usage.handle_context_usage("session", harness=None, server_client=None)
    body = json.loads(response.body)
    assert body["pending"] is True
    assert body["reason"] == "The runner has not loaded this session yet."
    assert "final" not in body
    probe.assert_not_called()


def test_no_proc_interface_is_final(tmp_path):
    bridge = tmp_path / "bridge"
    bridge.mkdir()
    (bridge / "context_raw.json").write_text(json.dumps({"session_id": "live"}))
    with pytest.raises(usage.ContextUnsupported):
        usage.launch_config(bridge, process_root=tmp_path / "missing")


@pytest.mark.asyncio
async def test_concurrent_reads_share_cached_probe(monkeypatch):
    import omnigent.runner.native as native

    monkeypatch.setattr(
        native, "_claude_native_bridge_id_for_session", AsyncMock(return_value="bridge")
    )
    monkeypatch.setattr(usage, "launch_config", lambda _: (["claude"], {}, "/tmp", "claude-id"))
    probe = AsyncMock(return_value={"available": True})
    monkeypatch.setattr(usage, "probe", probe)
    usage._cache.clear()
    await asyncio.gather(
        *(
            usage.handle_context_usage("session", harness="claude-native", server_client=None)
            for _ in range(3)
        )
    )
    assert probe.await_count == 1


def test_launch_isolated_and_uses_current_model(tmp_path):
    bridge = tmp_path / "bridge"
    bridge.mkdir()
    settings = bridge / "claude-settings.json"
    settings.write_text(
        json.dumps({"hooks": {"SessionStart": []}, "statusLine": {"command": "live-writer"}})
    )
    (bridge / "context_raw.json").write_text(
        json.dumps({"session_id": "live-session", "model": {"id": "current-model"}})
    )
    process_root = tmp_path / "proc"
    proc = process_root / "123"
    proc.mkdir(parents=True)
    (proc / "cmdline").write_bytes(
        "\0".join(
            [
                "claude",
                "--settings",
                str(settings),
                "--model",
                "old-model",
                "--strict-mcp-config",
                "--tools=Read",
                "--disallowedTools",
                "Bash",
                "Write",
                "--mcp-config",
                "config",
                "--append-system-prompt",
                "prompt",
            ]
        ).encode()
    )
    (proc / "environ").write_bytes(b"CLAUDECODE=1\0SAFE=value\0")
    (proc / "cwd").symlink_to(tmp_path)
    command, env, cwd, sid = usage.launch_config(bridge, process_root)
    assert command[command.index("--model") + 1] == "current-model"
    assert command[command.index("--resume") + 1] == sid == "live-session"
    assert "--fork-session" in command and "--no-session-persistence" in command
    assert "--strict-mcp-config" in command
    assert command[command.index("--tools") + 1] == "Read"
    assert command[
        command.index("--disallowedTools") + 1 : command.index("--disallowedTools") + 3
    ] == ["Bash", "Write"]
    assert env == {"SAFE": "value"}
    assert cwd == str(tmp_path)
    copied = json.loads(command[command.index("--settings") + 1])
    assert copied["disableAllHooks"] is True and "hooks" not in copied
    assert copied["statusLine"]["command"] == "true"
    assert json.loads(settings.read_text())["statusLine"]["command"] == "live-writer"
    (proc / "cmdline").write_bytes(b"claude\0--settings\0/another/session\0")
    with pytest.raises(ValueError, match="No live Claude"):
        usage.launch_config(bridge, process_root)


@pytest.mark.asyncio
async def test_cancelled_probe_reaps_process(tmp_path):
    import os

    script = tmp_path / "blocked.py"
    pid_file = tmp_path / "pid"
    script.write_text(
        "import os,time,pathlib\n"
        f"pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid()))\n"
        "time.sleep(60)\n"
    )
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(usage.probe([sys.executable, str(script)], {}, str(tmp_path)), 1)
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid_file.read_text()), 0)


def test_probe_redirects_bridge_writes_to_private_directory(tmp_path):
    live = tmp_path / "live"
    live.mkdir()
    (live / "bridge.json").write_text('{"token":"private"}')
    (live / "server.json").write_text('{"pid":123}')
    (live / "tool_relay.json").write_text('{"tools":[]}')
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    config = {
        "mcpServers": {
            "omnigent": {
                "args": [
                    "-m",
                    "omnigent.harnesses.claude_native.bridge",
                    "serve-mcp",
                    "--bridge-dir",
                    str(live),
                ]
            }
        }
    }
    command = usage.isolated_command(
        ["claude", "--mcp-config", json.dumps(config)], str(tmp_path), scratch
    )
    copied = json.loads(command[2])["mcpServers"]["omnigent"]["args"][-1]
    copy = type(live)(copied)
    assert copy != live and copy.parent == scratch
    assert (copy / "bridge.json").read_bytes() == (live / "bridge.json").read_bytes()
    assert (copy / "tool_relay.json").exists()
    assert not (copy / "server.json").exists()
    (copy / "server.json").write_text('{"pid":456}')
    assert (live / "server.json").read_text() == '{"pid":123}'


@pytest.mark.asyncio
async def test_failed_requests_share_cooldown(monkeypatch):
    import omnigent.runner.native as native

    monkeypatch.setattr(
        native, "_claude_native_bridge_id_for_session", AsyncMock(return_value="bridge")
    )
    monkeypatch.setattr(usage, "launch_config", lambda _: (["claude"], {}, "/tmp", "failed-id"))
    probe = AsyncMock(side_effect=ValueError("unsupported"))
    monkeypatch.setattr(usage, "probe", probe)
    usage._failures.clear()
    replies = await asyncio.gather(
        *(
            usage.handle_context_usage("failure", harness="claude-native", server_client=None)
            for _ in range(3)
        )
    )
    assert probe.await_count == 1
    assert all(json.loads(reply.body)["available"] is False for reply in replies)


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", ["null", "[]", '{"type":"control_response","response":null}'])
async def test_malformed_protocol_is_rejected(tmp_path, payload):
    script = tmp_path / "bad.py"
    script.write_text(f"import sys\nsys.stdin.readline()\nprint({payload!r}, flush=True)\n")
    with pytest.raises(ValueError):
        await usage.probe([sys.executable, str(script)], {}, str(tmp_path))


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_nonfinite_totals_rejected(bad):
    with pytest.raises(ValueError):
        usage.normalize({"categories": [], "totalTokens": bad, "maxTokens": 200000}, complete=True)


def test_unknown_bridge_launch_rejected(tmp_path):
    config = {"mcpServers": {"bridge": {"command": "wrapper", "args": ["--bridge-dir", "/live"]}}}
    with pytest.raises(ValueError, match="Unrecognized bridge"):
        usage.isolated_command(
            ["claude", "--mcp-config", json.dumps(config)], str(tmp_path), tmp_path
        )


def test_mcp_rows_keep_only_name_and_known_status():
    rows = usage.mcp_rows(
        [
            {
                "name": "  ae  ",
                "status": "connected",
                "config": {"url": "https://secret.example", "headers": {"Authorization": "x"}},
                "error": "HTTP 403 token=abc",
                "serverInfo": {"name": "ae-server"},
            },
            {"name": "fabric", "status": "failed", "error": "bad header"},
            {"name": "github", "status": "needs-auth"},
            {"name": "slow", "status": "connecting"},
            {"name": "off", "status": "disabled"},
            {"name": "odd", "status": "exploded"},
            {"name": "x" * 300, "status": "pending"},
            {"name": "   ", "status": "connected"},
            {"name": 7, "status": "connected"},
            "not-a-server",
        ]
    )
    assert rows[:6] == [
        {"name": "ae", "status": "connected"},
        {"name": "fabric", "status": "failed"},
        {"name": "github", "status": "needs-auth"},
        {"name": "slow", "status": "pending"},
        {"name": "off", "status": "disabled"},
        {"name": "odd", "status": "unknown"},
    ]
    assert rows[6] == {"name": "x" * 120, "status": "pending"}
    assert len(rows) == 7
    dumped = json.dumps(rows)
    for leaked in ("secret.example", "Authorization", "403", "bad header", "ae-server"):
        assert leaked not in dumped


@pytest.mark.parametrize("servers", [None, {}, "connected", 3])
def test_mcp_rows_ignore_malformed_lists(servers):
    assert usage.mcp_rows(servers) == []


def test_normalize_carries_sanitized_mcp_servers():
    result = usage.normalize(
        {
            "categories": [{"name": "Messages", "tokens": 1, "kind": "used"}],
            "maxTokens": 200000,
            "totalTokens": 1,
        },
        complete=False,
        servers=[{"name": "ae", "status": "failed", "error": "token=abc"}],
    )
    assert result["mcpServers"] == [{"name": "ae", "status": "failed"}]
    assert "token=abc" not in json.dumps(result)


@pytest.mark.asyncio
async def test_probe_reports_mcp_server_status(tmp_path):
    script = tmp_path / "cli.py"
    script.write_text("""import json,sys
for line in sys.stdin:
 r=json.loads(line); kind=r['request']['subtype']
 if kind=='mcp_status': body={'mcpServers':[
  {'name':'ae','status':'connected','config':{'command':'secret-cmd'}},
  {'name':'raymcp','status':'failed','error':'HTTP 403'}]}
 elif kind=='get_context_usage':
  body={'categories':[{'name':'Messages','tokens':50,'kind':'used'}],
        'maxTokens':200000,'totalTokens':50}
 else: body={}
 print(json.dumps({'type':'control_response','response':{'subtype':'success','request_id':r['request_id'],'response':body}}),flush=True)
""")
    result = await usage.probe([sys.executable, str(script)], {}, str(tmp_path))
    assert result["mcpServers"] == [
        {"name": "ae", "status": "connected"},
        {"name": "raymcp", "status": "failed"},
    ]
    assert result["complete"] is False
    assert "secret-cmd" not in json.dumps(result)


def _bridge_config(live):
    return {
        "mcpServers": {
            "omnigent": {
                "args": [
                    "-m",
                    "omnigent.harnesses.claude_native.bridge",
                    "serve-mcp",
                    "--bridge-dir",
                    str(live),
                ]
            }
        }
    }


@pytest.mark.asyncio
async def test_probe_copies_land_under_claude_bridge_root(tmp_path, claude_bridge_root):
    """The bridge rejects a --bridge-dir outside its allowed roots (2026-10-17 regression)."""
    live = tmp_path / "live"
    live.mkdir()
    (live / "bridge.json").write_text('{"token":"private"}')
    seen = tmp_path / "seen.txt"
    script = tmp_path / "cli.py"
    script.write_text(f"""import json,sys
config=json.loads(sys.argv[sys.argv.index('--mcp-config')+1])
args=config['mcpServers']['omnigent']['args']
open({str(seen)!r},'w').write(args[args.index('--bridge-dir')+1])
for line in sys.stdin:
 r=json.loads(line); kind=r['request']['subtype']
 if kind=='get_context_usage':
  body={{'categories':[{{'name':'Messages','tokens':50,'kind':'used'}}],
        'maxTokens':200000,'totalTokens':50}}
 else: body={{}}
 print(json.dumps({{'type':'control_response','response':{{'subtype':'success','request_id':r['request_id'],'response':body}}}}),flush=True)
""")
    command = [sys.executable, str(script), "--mcp-config", json.dumps(_bridge_config(live))]
    await usage.probe(command, {}, str(tmp_path))
    copy = Path(seen.read_text())
    assert copy.parent.parent == claude_bridge_root
    assert copy.parent.name.startswith("ae-context-")
    assert not copy.parent.exists()


def test_isolated_copy_passes_bridge_allowed_root_check(tmp_path, claude_bridge_root):
    live = tmp_path / "live"
    live.mkdir()
    (live / "bridge.json").write_text('{"token":"private"}')
    parent = usage._scratch_parent()
    assert parent == claude_bridge_root
    scratch = parent / "ae-context-check"
    scratch.mkdir(mode=0o700)
    command = usage.isolated_command(
        ["claude", "--mcp-config", json.dumps(_bridge_config(live))], str(tmp_path), scratch
    )
    copy = Path(json.loads(command[2])["mcpServers"]["omnigent"]["args"][-1])
    assert claude_bridge._trusted_parent_for_bridge_dir(copy) == claude_bridge._TRUSTED_PARENT
    claude_bridge.ensure_secure_dir(copy)
    claude_bridge._write_json_file(copy / "server.json", {"pid": 1})
    # The old location is rejected, which is the failure this guards against.
    with pytest.raises(RuntimeError, match="not under an allowed bridge root"):
        claude_bridge.ensure_secure_dir(tmp_path / "ae-context-elsewhere" / "0-0")


def test_unsafe_bridge_root_is_reported_as_unavailable(monkeypatch):
    def refuse(_target):
        raise RuntimeError("group-writable ancestor")

    monkeypatch.setattr(claude_bridge, "ensure_secure_dir", refuse)
    with pytest.raises(ValueError, match="group-writable ancestor"):
        usage._scratch_parent()


def _route_to_bridge(monkeypatch, bridge):
    import omnigent.runner.native as native

    monkeypatch.setattr(
        native, "_claude_native_bridge_id_for_session", AsyncMock(return_value="bridge")
    )
    monkeypatch.setattr(claude_bridge, "bridge_dir_for_bridge_id", lambda _bridge_id: bridge)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "raw,reason",
    [
        (None, "first status reading"),
        ({"model": {"id": "m"}}, "No Claude session reading yet"),
        ({"session_id": "live"}, "No live Claude process"),
    ],
)
async def test_claude_still_starting_answers_pending_without_backoff(
    tmp_path, monkeypatch, raw, reason
):
    """No reading yet, no session id yet, or no live process: pending, never a failure."""
    bridge = tmp_path / "bridge"
    bridge.mkdir()
    if raw is not None:
        (bridge / "context_raw.json").write_text(json.dumps(raw))
    _route_to_bridge(monkeypatch, bridge)
    probe = AsyncMock()
    monkeypatch.setattr(usage, "probe", probe)
    usage._failures.clear()
    response = await usage.handle_context_usage(
        "starting", harness="claude-native", server_client=None
    )
    body = json.loads(response.body)
    assert body["available"] is False
    assert body["pending"] is True
    # The real not-ready reason, shown if the web's quiet retries run out.
    assert reason in body["reason"]
    assert "starting" not in usage._failures
    probe.assert_not_called()


@pytest.mark.asyncio
async def test_real_probe_failure_answers_error_and_starts_backoff(monkeypatch, caplog):
    import omnigent.runner.native as native

    monkeypatch.setattr(
        native, "_claude_native_bridge_id_for_session", AsyncMock(return_value="bridge")
    )
    monkeypatch.setattr(usage, "launch_config", lambda _: (["claude"], {}, "/tmp", "real-id"))
    monkeypatch.setattr(
        usage, "probe", AsyncMock(side_effect=ValueError("broken at /srv/a/b/secret-dir now"))
    )
    usage._failures.clear()
    with caplog.at_level("INFO", logger=usage.__name__):
        response = await usage.handle_context_usage(
            "broken", harness="claude-native", server_client=None
        )
    body = json.loads(response.body)
    assert body["available"] is False
    assert "pending" not in body
    assert "Could not read Claude context" in body["reason"]
    assert "broken" in usage._failures
    assert "ValueError" in caplog.text
    assert "/srv/a/b" not in caplog.text


@pytest.mark.asyncio
async def test_fresh_read_skips_the_snapshot_cache(monkeypatch):
    """A turn end or a refresh must not get the pre-turn snapshot back from the cache."""
    import omnigent.runner.native as native

    monkeypatch.setattr(
        native, "_claude_native_bridge_id_for_session", AsyncMock(return_value="bridge")
    )
    monkeypatch.setattr(usage, "launch_config", lambda _: (["claude"], {}, "/tmp", "fresh-id"))
    probe = AsyncMock(side_effect=[{"available": True, "n": 1}, {"available": True, "n": 2}])
    monkeypatch.setattr(usage, "probe", probe)
    usage._cache.clear()
    usage._failures.clear()

    async def read(**kwargs):
        response = await usage.handle_context_usage(
            "fresh", harness="claude-native", server_client=None, **kwargs
        )
        return json.loads(response.body)["n"]

    assert await read() == 1
    assert await read() == 1
    assert await read(fresh=True) == 2
    # The fresh answer replaces the cached one.
    assert await read() == 2
    assert probe.await_count == 2
