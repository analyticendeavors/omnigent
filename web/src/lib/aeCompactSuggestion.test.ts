import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import { AE_DOCK_KINDS, aeDockBadgeLabel, aeDockSummary } from "@/lib/aeActionDock";
import { authenticatedFetch } from "@/lib/identity";
import {
  aeCompactSuggestion,
  aeCompactText,
  aeCompactTokens,
  postAeHandoffSnooze,
} from "./aeCompactSuggestion";

const LEAD = {
  "ae.handoff": "suggest",
  "ae.handoff_at": "370400",
  "ae.status": "working",
  "omnigent.wrapper": "claude-code-native-ui",
};

describe("aeCompactSuggestion", () => {
  it("suggests on the suggest label while the chat is working or blocked", () => {
    expect(aeCompactSuggestion({ labels: LEAD })).toEqual({ tokens: 370400 });
    expect(aeCompactSuggestion({ labels: { ...LEAD, "ae.status": "blocked" } })).toEqual({
      tokens: 370400,
    });
    expect(aeCompactSuggestion({ labels: { ...LEAD, "ae.status": "review" } })).toBeNull();
    expect(aeCompactSuggestion({ labels: { ...LEAD, "ae.status": "" } })).toBeNull();
  });

  it("stays quiet for any other label value, snoozed included", () => {
    for (const value of ["snoozed", "nudged", ""]) {
      expect(aeCompactSuggestion({ labels: { ...LEAD, "ae.handoff": value } })).toBeNull();
    }
    expect(aeCompactSuggestion(null)).toBeNull();
  });

  it("accepts a lead role, and an unknown-parent marker on ae.orch", () => {
    expect(aeCompactSuggestion({ labels: { ...LEAD, "ae.role": "lead" } })).not.toBeNull();
    expect(aeCompactSuggestion({ labels: { ...LEAD, "ae.orch": "1" } })).not.toBeNull();
    expect(aeCompactSuggestion({ labels: LEAD, kind: "default", parentId: null })).not.toBeNull();
  });

  it.each([
    ["a family child", { labels: { ...LEAD, "ae.orch": "conv_lead" } }],
    ["a reviewer", { labels: { ...LEAD, "ae.role": "reviewer" } }],
    ["a builder", { labels: { ...LEAD, "ae.role": "builder" } }],
    ["a fork", { labels: { ...LEAD, "omnigent.fork.source_id": "conv_x" } }],
    ["a side chat", { labels: { ...LEAD, "omnigent.side_chat": "1" } }],
    ["a Codex chat", { labels: { ...LEAD, "omnigent.wrapper": "codex-native-ui" } }],
    ["a chat with no wrapper", { labels: { ...LEAD, "omnigent.wrapper": "" } }],
    ["a native child", { labels: LEAD, parentId: "conv_parent" }],
    ["a sub-agent row", { labels: LEAD, kind: "sub_agent" }],
    ["an archived chat", { labels: LEAD, archived: true }],
  ])("shows nothing for %s with a stale suggest label", (_name, row) => {
    expect(aeCompactSuggestion(row)).toBeNull();
  });

  it("falls back to the context label when the size is missing", () => {
    const labels = { ...LEAD, "omnigent.last_context_tokens": "310000" } as Record<string, string>;
    delete labels["ae.handoff_at"];
    expect(aeCompactSuggestion({ labels })).toEqual({ tokens: 310000 });
  });

  it("words the line in thousands", () => {
    expect(aeCompactTokens(370_400)).toBe("370k");
    expect(aeCompactText(370_000)).toBe(
      "This chat is at 370k tokens. Every reply re-reads all of it.",
    );
  });
});

describe("the dock kinds", () => {
  it("ranks the context card right after the limit", () => {
    const at = AE_DOCK_KINDS.indexOf("context");
    expect(at).toBe(AE_DOCK_KINDS.indexOf("limit") + 1);
    expect(AE_DOCK_KINDS[at + 1]).toBe("merge");
  });

  it("badges it with its size", () => {
    const item = {
      kind: "context" as const,
      key: "context",
      anchor: "context",
      order: 0,
      sessionId: "s1",
      tokens: 370_000,
    };
    expect(aeDockBadgeLabel([item])).toBe("370k tokens");
    expect(aeDockSummary([item])?.lead.kind).toBe("context");
  });
});

describe("postAeHandoffSnooze", () => {
  beforeEach(() => vi.mocked(authenticatedFetch).mockReset());

  it("posts an empty body to the session's snooze route", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response("{}", { status: 200 }));
    await postAeHandoffSnooze("conv a");
    const [url, init] = vi.mocked(authenticatedFetch).mock.calls[0]!;
    expect(url).toBe("/v1/ae/sessions/conv%20a/handoff/snooze");
    expect(init).toMatchObject({ method: "POST", body: "{}" });
  });

  it("throws on a 403", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "only the owner" } }), { status: 403 }),
    );
    await expect(postAeHandoffSnooze("s1")).rejects.toThrow();
  });
});
