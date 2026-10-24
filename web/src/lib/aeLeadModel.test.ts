import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  aeAnnounceLead,
  aeFindLeadOption,
  aeFixedLead,
  aeLeadSentence,
  aePatchLeadWriter,
  aeSwitchLead,
  aeUndoLead,
} from "./aeLeadModel";
import type { NativeModelOption, Session } from "./types";

const mocks = vi.hoisted(() => ({
  getSessionSlim: vi.fn(),
  updateSession: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/sessionsApi", () => ({
  getSessionSlim: mocks.getSessionSlim,
  updateSession: mocks.updateSession,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

const MODELS: NativeModelOption[] = [
  { id: "opus", model: "claude-opus-5-5", displayName: "Opus 5.5" },
  { id: "fable[1m]", model: "claude-fable-5-1[1m]", displayName: "Fable 5.1 (1M context)" },
  { id: "fable", model: "claude-fable-5-1", displayName: "Fable 5.1" },
];
const FABLE_MAX = { model: "claude-fable-5-1", effort: "max" as const };

let stored: Session;
beforeEach(() => {
  vi.resetAllMocks();
  stored = {
    id: "s1",
    labels: { "omnigent.wrapper": "claude-code-native-ui" },
    modelOverride: "opus",
    reasoningEffort: "high",
  } as unknown as Session;
  mocks.getSessionSlim.mockImplementation(async () => stored);
  mocks.updateSession.mockImplementation(async (_id: string, patch: Partial<Session>) => {
    stored = { ...stored, ...patch };
    return stored;
  });
});

describe("aeFixedLead", () => {
  it("returns the lead only when the preset fixes it", () => {
    expect(aeFixedLead({ roles: { lead: { mode: "fixed", ...FABLE_MAX } } } as never)).toEqual(
      FABLE_MAX,
    );
    expect(aeFixedLead({ roles: { lead: { mode: "session" } } } as never)).toBeNull();
    expect(aeFixedLead({ roles: { lead: { mode: "auto" } } } as never)).toBeNull();
    expect(aeFixedLead(undefined)).toBeNull();
  });
});

describe("aeFindLeadOption", () => {
  it("matches a catalog id to the plain picker row over its 1M variant", () => {
    expect(aeFindLeadOption("claude-fable-5-1", MODELS)?.id).toBe("fable");
    expect(aeFindLeadOption("claude-haiku-5-5", MODELS)).toBeNull();
  });
});

describe("aeSwitchLead", () => {
  it("sets model and effort, says so, and Undo restores both", async () => {
    const on = vi.fn();
    const write = aePatchLeadWriter("s1", on);
    const result = await aeSwitchLead("s1", FABLE_MAX, MODELS, write);
    expect(mocks.updateSession.mock.calls).toEqual([
      ["s1", { modelOverride: "fable" }],
      ["s1", { reasoningEffort: "max" }],
    ]);
    expect(on).toHaveBeenCalledTimes(2);
    expect(aeLeadSentence(result)).toBe("Lead switched to Fable 5.1 max.");
    aeAnnounceLead("s1", "YOLO", result, write);
    expect(mocks.toast).toHaveBeenCalledWith(
      "Lead switched to Fable 5.1 max",
      expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }),
    );
    if (result.kind !== "switched") throw new Error("expected a switch");
    expect(await aeUndoLead("s1", result, write)).toEqual({
      restored: ["the model", "the effort"],
      kept: [],
    });
    expect(stored).toMatchObject({ modelOverride: "opus", reasoningEffort: "high" });
  });

  it("Undo leaves a model the user changed since the switch", async () => {
    const write = aePatchLeadWriter("s1", vi.fn());
    const result = await aeSwitchLead("s1", FABLE_MAX, MODELS, write);
    stored = { ...stored, modelOverride: "sonnet" };
    if (result.kind !== "switched") throw new Error("expected a switch");
    expect(await aeUndoLead("s1", result, write)).toEqual({
      restored: ["the effort"],
      kept: ["the model"],
    });
    expect(stored.modelOverride).toBe("sonnet");
  });

  it("changes nothing when the host does not offer the model, and says so", async () => {
    const write = aePatchLeadWriter("s1", vi.fn());
    const result = await aeSwitchLead("s1", FABLE_MAX, MODELS.slice(0, 1), write);
    expect(result).toEqual({ kind: "missing", name: "Fable 5.1" });
    expect(mocks.updateSession).not.toHaveBeenCalled();
    aeAnnounceLead("s1", "YOLO", result, write);
    expect(mocks.toast).toHaveBeenCalledWith(
      "Roles preset: YOLO. This host does not offer Fable 5.1, so the model was not changed.",
      { duration: 6_000 },
    );
  });

  it("does nothing when already on the lead, or when the preset has no fixed lead", async () => {
    stored = { ...stored, modelOverride: "fable", reasoningEffort: "max" };
    const write = aePatchLeadWriter("s1", vi.fn());
    expect(await aeSwitchLead("s1", FABLE_MAX, MODELS, write)).toEqual({ kind: "same" });
    expect(await aeSwitchLead("s1", null, MODELS, write)).toEqual({ kind: "none" });
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it("keeps the 1M variant of the same model and changes only the effort", async () => {
    stored = { ...stored, modelOverride: "fable[1m]", reasoningEffort: "high" };
    const result = await aeSwitchLead("s1", FABLE_MAX, MODELS, aePatchLeadWriter("s1", vi.fn()));
    expect(mocks.updateSession.mock.calls).toEqual([["s1", { reasoningEffort: "max" }]]);
    expect(result).toMatchObject({ kind: "switched", after: { model: "fable[1m]" } });
    stored = { ...stored, reasoningEffort: "max" };
    mocks.updateSession.mockClear();
    expect(await aeSwitchLead("s1", FABLE_MAX, MODELS, aePatchLeadWriter("s1", vi.fn()))).toEqual({
      kind: "same",
    });
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it("keeps a full-id 1M session when the picker row is a tier alias", async () => {
    stored = { ...stored, modelOverride: "claude-fable-5-1[1m]", reasoningEffort: "max" };
    expect(await aeSwitchLead("s1", FABLE_MAX, MODELS, aePatchLeadWriter("s1", vi.fn()))).toEqual({
      kind: "same",
    });
    expect(mocks.updateSession).not.toHaveBeenCalled();
    stored = { ...stored, reasoningEffort: "high" };
    const result = await aeSwitchLead("s1", FABLE_MAX, MODELS, aePatchLeadWriter("s1", vi.fn()));
    expect(mocks.updateSession.mock.calls).toEqual([["s1", { reasoningEffort: "max" }]]);
    expect(result).toMatchObject({ after: { model: "claude-fable-5-1[1m]" } });
  });

  it("still names the preset when the lead was already on its model", () => {
    aeAnnounceLead("s1", "YOLO", { kind: "same" }, aePatchLeadWriter("s1", vi.fn()));
    expect(mocks.toast).toHaveBeenCalledWith("Roles preset: YOLO", { duration: 2_000 });
    mocks.toast.mockClear();
    aeAnnounceLead("s1", "YOLO", { kind: "none" }, aePatchLeadWriter("s1", vi.fn()));
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("skips the effort on a harness without effort control", async () => {
    stored = { ...stored, labels: {}, harness: "openai-agents" } as unknown as Session;
    const result = await aeSwitchLead("s1", FABLE_MAX, MODELS, aePatchLeadWriter("s1", vi.fn()));
    expect(mocks.updateSession.mock.calls).toEqual([["s1", { modelOverride: "fable" }]]);
    expect(aeLeadSentence(result)).toBe("Lead switched to Fable 5.1.");
  });
});
