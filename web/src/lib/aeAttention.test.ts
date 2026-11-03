import { describe, expect, it } from "vitest";
import { type AeAttentionSummary, aeAttentionView } from "./aeAttention";

const summary = (
  over: Partial<AeAttentionSummary> & { urgent?: number; review?: number } = {},
) => ({
  sources: ["git", "box"],
  counts: {
    urgent: over.urgent ?? 0,
    review: over.review ?? 0,
    by_source: { git: { urgent: over.urgent ?? 0, review: over.review ?? 0 } },
  },
  unknown: over.unknown ?? [],
});

describe("aeAttentionView", () => {
  it("shows nothing at zero, before an answer, and for a viewer who may see no source", () => {
    expect(aeAttentionView(summary()).kind).toBe("none");
    expect(aeAttentionView(undefined).kind).toBe("none");
    expect(
      aeAttentionView({ sources: [], counts: { urgent: 0, review: 0, by_source: {} }, unknown: [] })
        .kind,
    ).toBe("none");
  });

  it("shows the review count in neutral when nothing is urgent", () => {
    const view = aeAttentionView(summary({ review: 17 }));
    expect(view).toMatchObject({ kind: "review", text: "17" });
    expect(view.label).toBe("0 urgent, 17 to review");
  });

  it("shows the urgent count, not the total, when anything is urgent", () => {
    const view = aeAttentionView(summary({ urgent: 6, review: 17 }));
    expect(view).toMatchObject({ kind: "urgent", text: "6" });
    expect(view.tooltip).toBe("6 urgent, 17 to review. Git 23.");
  });

  it("caps the number at 99+", () => {
    expect(aeAttentionView(summary({ urgent: 140 })).text).toBe("99+");
  });

  it("adds a question mark and names the source that could not be read", () => {
    const view = aeAttentionView(
      summary({ urgent: 6, review: 17, unknown: ["Git repos could not be read"] }),
    );
    expect(view.text).toBe("6 ?");
    expect(view.label).toBe("6 urgent, 17 to review, Git repos could not be read");
    expect(view.tooltip).toContain("Git repos could not be read; the count may be low.");
  });

  it("is a lone question mark when nothing is known but something is unreadable, never zero", () => {
    const view = aeAttentionView(summary({ unknown: ["Box health could not be read"] }));
    expect(view).toMatchObject({ kind: "unknown", text: "?", unsure: true });
  });

  it("is a lone question mark when the route itself failed", () => {
    expect(aeAttentionView(null, true)).toMatchObject({
      kind: "unknown",
      text: "?",
      label: "Needs you could not be read",
    });
  });
});
