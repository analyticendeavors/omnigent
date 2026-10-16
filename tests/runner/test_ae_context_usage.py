"""Context reconstruction preserves deferred semantics and isolates subprocesses."""

import asyncio
import json
import sys
from unittest.mock import AsyncMock

import pytest

from omnigent.runner import ae_context_usage as usage


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
    assert json.loads(response.body)["available"] is False
    probe.assert_not_called()


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
