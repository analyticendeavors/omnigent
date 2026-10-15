import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import { authenticatedFetch } from "@/lib/identity";
import type { AeSessionContext } from "./AePlanLimits";
import {
  AE_MAX_COLLABORATORS,
  aeAgentLabel,
  aeLimitsHarnessFor,
  buildActiveContext,
  buildCollaboratorContext,
  aeModelName,
  fetchAeSessionContexts,
  useAeSessionContexts,
  usesClaudeStatusLine,
} from "./aeSessionContext";

const NOW = Date.parse("2026-10-13T16:00:00Z");

const STATUS_LINE: AeSessionContext = {
  conversation_id: "conv_a",
  observed_at: new Date(NOW - 60_000).toISOString(),
  model: "Fable",
  window_size: 1_000_000,
  used_tokens: 200_000,
  input_tokens: 0,
  cache_write_tokens: 0,
  cache_read_tokens: 200_000,
};

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

function child(id: string) {
  return {
    id,
    title: `claude_code:${id}`,
    task_summary: null,
    tool: null,
    session_name: null,
    current_task_status: null,
    busy: false,
  };
}

function wire(id: string, harness: string, extra: Record<string, unknown> = {}) {
  return { id, agent_id: "agent", status: "idle", created_at: 0, harness, ...extra };
}

describe("provider gating", () => {
  it("lets only Claude Code sessions use the Claude status line", () => {
    expect(usesClaudeStatusLine("claude-native", null)).toBe(true);
    expect(usesClaudeStatusLine("native-claude", null)).toBe(true);
    expect(usesClaudeStatusLine("codex-native", "claude-fable-5-1")).toBe(false);
    expect(usesClaudeStatusLine("claude-sdk", null)).toBe(false);
    // Harness not known yet: the model decides.
    expect(usesClaudeStatusLine(null, "claude-fable-5-1")).toBe(true);
    expect(usesClaudeStatusLine(null, "gpt-5.5")).toBe(false);
    expect(usesClaudeStatusLine(null, null)).toBe(false);
  });

  it("maps harnesses to plan-limit blocks and labels", () => {
    expect(aeLimitsHarnessFor("claude-native")).toBe("claude");
    expect(aeLimitsHarnessFor("codex-native")).toBe("codex");
    expect(aeLimitsHarnessFor("native-codex")).toBe("codex");
    expect(aeLimitsHarnessFor("codex")).toBe("codex");
    expect(aeLimitsHarnessFor("pi")).toBeNull();
    expect(aeAgentLabel("codex-native")).toBe("Codex");
    expect(aeAgentLabel("native-claude")).toBe("Claude Code");
    expect(aeAgentLabel("claude-sdk")).toBe("Claude SDK");
    expect(aeAgentLabel("mystery-harness")).toBe("mystery-harness");
    expect(aeAgentLabel(null)).toBeNull();
  });
});

describe("buildActiveContext", () => {
  const input = {
    conversationId: "conv_a",
    harness: "claude-native",
    model: "claude-fable-5-1",
    contextWindow: null,
    tokensUsed: null,
  };

  it("prefers live figures, then the snapshot, then the status line", () => {
    const live = buildActiveContext(
      { ...input, contextWindow: 1_000_000, tokensUsed: 10 },
      null,
      [STATUS_LINE],
      NOW,
    );
    expect(live.reading).toMatchObject({ source: "live", used: 10 });
    const snap = buildActiveContext(
      input,
      { harness: "claude-native", llmModel: null, contextWindow: 1_000_000, lastTotalTokens: 20 },
      [STATUS_LINE],
      NOW,
    );
    expect(snap.reading).toMatchObject({ source: "snapshot", used: 20 });
    const line = buildActiveContext(input, null, [STATUS_LINE], NOW);
    expect(line.reading).toMatchObject({ source: "statusline", used: 200_000, stale: false });
  });

  it("does not report a zero when the store has a window but no tokens", () => {
    const entry = buildActiveContext(
      { ...input, harness: "codex-native", contextWindow: 400_000 },
      null,
      [STATUS_LINE],
      NOW,
    );
    expect(entry.reading).toBeNull();
    expect(entry.unavailable).toBe("No reading yet; it appears after the session's next reply.");
  });

  it("drops the store's figures when the snapshot shows a different agent", () => {
    const entry = buildActiveContext(
      { ...input, contextWindow: 1_000_000, tokensUsed: 216_800 },
      { harness: "codex-native", llmModel: "gpt-5.5", contextWindow: 400_000, lastTotalTokens: 0 },
      [STATUS_LINE],
      NOW,
    );
    expect(entry).toMatchObject({ harness: "codex-native", agent: "Codex", model: "gpt-5.5" });
    // A fresh Codex session that reports 0 tokens is a real reading, not the old Claude one.
    expect(entry.reading).toMatchObject({ source: "snapshot", used: 0, size: 400_000 });
    expect(entry.breakdown).toBeNull();
  });
});

describe("buildCollaboratorContext", () => {
  it("uses the router's model when the snapshot names none", () => {
    const entry = buildCollaboratorContext(
      {
        id: "conv_x",
        name: "Child",
        routedModel: "databricks-claude-sonnet-5",
        snapshot: {
          harness: "claude-sdk",
          llmModel: null,
          contextWindow: null,
          lastTotalTokens: null,
        },
      },
      [STATUS_LINE],
      NOW,
    );
    expect(entry.model).toBe("databricks-claude-sonnet-5");
    expect(entry.reading).toBeNull();
  });
});

describe("aeModelName", () => {
  it("reads Claude model ids and aliases as names, and leaves others as they are", () => {
    expect(aeModelName("claude-opus-5-5[1m]")).toBe("Opus 5.5");
    expect(aeModelName("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(aeModelName("claude-fable-5")).toBe("Fable 5");
    expect(aeModelName("opus[1m]")).toBe("Opus");
    expect(aeModelName("gpt-5.5")).toBe("gpt-5.5");
    expect(aeModelName(null)).toBeNull();
  });
});

describe("fetchAeSessionContexts", () => {
  beforeEach(() => vi.mocked(authenticatedFetch).mockReset());

  it("leaves Claude Code's own subagents out and never names a row by its raw id", async () => {
    const rows = [
      {
        ...child("conv_helper"),
        title: "general-purpose:a45b4b1759d6fb802",
        labels: { "omnigent.wrapper": "claude-code-native-ui-subagent" },
      },
      { ...child("conv_team"), title: "codex:a45b4b1759d6fb802" },
      { ...child("conv_named"), task_summary: "Review the diff" },
    ];
    vi.mocked(authenticatedFetch).mockImplementation((url) => {
      const path = String(url);
      if (path === "/v1/sessions/conv_root/child_sessions") {
        return json({ object: "list", data: rows });
      }
      const id = path.match(/^\/v1\/sessions\/([^/?]+)\?/)?.[1] ?? "";
      return json(wire(id, "codex-native"));
    });
    const state = await fetchAeSessionContexts("conv_root");
    expect(state.collaborators.map((c) => [c.id, c.name])).toEqual([
      ["conv_team", "Collaborator"],
      ["conv_named", "Review the diff"],
    ]);
    expect(state.hidden).toBe(0);
  });

  it("fetches each child's snapshot, caps the list and keeps a failed child visible", async () => {
    const ids = Array.from({ length: AE_MAX_COLLABORATORS + 2 }, (_, i) => `conv_c${i}`);
    vi.mocked(authenticatedFetch).mockImplementation((url) => {
      const path = String(url);
      if (path === "/v1/sessions/conv_root/child_sessions") {
        return json({ object: "list", data: ids.map(child) });
      }
      if (path.startsWith("/v1/sessions/conv_root?"))
        return json(wire("conv_root", "codex-native"));
      if (path.startsWith("/v1/sessions/conv_c1?")) return json({ detail: "gone" }, 404);
      const id = path.match(/^\/v1\/sessions\/([^/?]+)\?/)?.[1] ?? "";
      return json(wire(id, "claude-native", { context_window: 200_000, last_total_tokens: 1 }));
    });
    const state = await fetchAeSessionContexts("conv_root");
    expect(state.self?.harness).toBe("codex-native");
    expect(state.collaborators.map((c) => c.id)).toEqual(ids.slice(0, AE_MAX_COLLABORATORS));
    expect(state.hidden).toBe(2);
    expect(state.collaborators[1]).toMatchObject({ snapshot: null });
    expect(state.collaborators[0].snapshot).toMatchObject({ contextWindow: 200_000 });
    expect(state.error).toBeNull();
  });

  it("reports a failed child list without failing the whole read", async () => {
    vi.mocked(authenticatedFetch).mockImplementation((url) =>
      String(url).endsWith("/child_sessions")
        ? json({ detail: "boom" }, 500)
        : json(wire("conv_root", "claude-native")),
    );
    const state = await fetchAeSessionContexts("conv_root");
    expect(state.collaborators).toEqual([]);
    expect(state.error).toMatch(/^500/);
    expect(state.self?.harness).toBe("claude-native");
  });
});

describe("useAeSessionContexts", () => {
  beforeEach(() => {
    vi.mocked(authenticatedFetch).mockReset();
    vi.mocked(authenticatedFetch).mockImplementation((url) => {
      const path = String(url);
      if (path.endsWith("/child_sessions")) return json({ object: "list", data: [] });
      const id = path.match(/^\/v1\/sessions\/([^/?]+)\?/)?.[1] ?? "";
      return json(wire(id, id === "conv_b" ? "codex-native" : "claude-native"));
    });
  });

  it("fetches nothing while closed or for a draft session", () => {
    renderHook(() => useAeSessionContexts(false, "conv_a"));
    renderHook(() => useAeSessionContexts(true, null));
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it("drops the previous session's rows when the session changes", async () => {
    const { result, rerender } = renderHook(({ id }) => useAeSessionContexts(true, id), {
      initialProps: { id: "conv_a" },
    });
    await waitFor(() => expect(result.current.self?.harness).toBe("claude-native"));
    rerender({ id: "conv_b" });
    // Never conv_a's snapshot under conv_b, not even for one render.
    expect(result.current.self).toBeUndefined();
    await waitFor(() => expect(result.current.self?.harness).toBe("codex-native"));
  });

  it("discards old snapshots immediately when the model binding changes in place", async () => {
    const { result, rerender } = renderHook(
      ({ binding }) => useAeSessionContexts(true, "conv_a", 60_000, binding),
      { initialProps: { binding: "claude-native:old-model" } },
    );
    await waitFor(() => expect(result.current.self?.harness).toBe("claude-native"));
    vi.mocked(authenticatedFetch).mockImplementation((url) =>
      String(url).endsWith("/child_sessions")
        ? json({ object: "list", data: [] })
        : json(wire("conv_a", "codex-native")),
    );
    rerender({ binding: "codex-native:new-model" });
    expect(result.current.self).toBeUndefined();
    await waitFor(() => expect(result.current.self?.harness).toBe("codex-native"));
  });
});
