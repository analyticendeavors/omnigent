"""Context reconstruction preserves deferred semantics and isolates subprocesses."""

import asyncio
import json
import sys
from unittest.mock import AsyncMock

import pytest

from omnigent.runner import ae_context_usage as usage


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
