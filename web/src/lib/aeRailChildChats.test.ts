import { describe, expect, it } from "vitest";
import type { Conversation } from "@/hooks/useConversations";
import { buildAeChildChats } from "./aeRailChildChats";

function row(id: string, extra: Partial<Conversation> = {}, labels: Record<string, string> = {}) {
  return {
    id,
    object: "conversation",
    title: id,
    created_at: 0,
    updated_at: 100,
    labels: { "ae.orch": "lead", ...labels },
    permission_level: null,
    status: "idle",
    ...extra,
  } as Conversation;
}

describe("buildAeChildChats", () => {
  it("keeps only direct children, never forks, the lead itself or other families", () => {
    const model = buildAeChildChats(
      [
        row("a"),
        row("fork", {}, { "omnigent.fork.source_id": "x" }),
        row("other", {}, { "ae.orch": "elsewhere" }),
        row("lead", {}, { "ae.orch": "lead" }),
        row("grand", {}, { "ae.orch": "a" }),
        row("none", {}, { "ae.orch": "1" }),
      ],
      "lead",
    );
    expect(model.open.map((c) => c.row.id)).toEqual(["a"]);
  });

  it("orders needs-you, then working, then the rest newest first", () => {
    const model = buildAeChildChats(
      [
        row("old-done", { updated_at: 10 }),
        row("new-done", { updated_at: 90 }),
        row("busy", { status: "running", updated_at: 50 }),
        row("asks", { pending_elicitations_count: 1, updated_at: 5 }),
        row("broke", { status: "failed", updated_at: 40 }),
      ],
      "lead",
    );
    expect(model.open.map((c) => [c.row.id, c.status])).toEqual([
      ["asks", "needs"],
      ["busy", "working"],
      ["new-done", "done"],
      ["broke", "error"],
      ["old-done", "done"],
    ]);
    expect(model.needs.map((c) => c.row.id)).toEqual(["asks"]);
    expect(model.working).toBe(1);
  });

  it("folds reference and archived children into closed, newest first", () => {
    const model = buildAeChildChats(
      [
        row("ref", { updated_at: 1 }, { "ae.status": "reference" }),
        row("arch", { updated_at: 2, archived: true }),
        row("live"),
      ],
      "lead",
    );
    expect(model.open.map((c) => c.row.id)).toEqual(["live"]);
    expect(model.closed.map((r) => r.id)).toEqual(["arch", "ref"]);
  });
});
