import { beforeEach, describe, expect, it } from "vitest";
import {
  clearVoiceModelState,
  defaultFastModel,
  effectiveModelId,
  readVoiceModelPick,
  readVoiceModelState,
  resolveFastModel,
  VOICE_MODEL_OFF,
  mayRevertVoiceModel,
  voiceModelLabel,
  voiceModelVerdict,
  voiceTabId,
  type VoiceModelState,
  writeVoiceModelPick,
  writeVoiceModelState,
} from "./aeVoiceModel";

const OPTIONS = [
  { id: "opus", model: "claude-opus-5-5" },
  { id: "claude-sonnet-5", model: "claude-sonnet-5" },
  { id: "claude-sonnet-5-5", model: "claude-sonnet-5-5" },
  { id: "claude-haiku-4-5", model: "claude-haiku-4-5" },
];

beforeEach(() => window.localStorage.clear());

describe("aeVoiceModel", () => {
  it("defaults to the newest Sonnet row", () => {
    expect(defaultFastModel(OPTIONS)?.id).toBe("claude-sonnet-5-5");
  });

  it("takes an alias row that names Sonnet when no row carries a version", () => {
    expect(defaultFastModel([{ id: "opus" }, { id: "sonnet" }])?.id).toBe("sonnet");
  });

  it("has no default without a Sonnet row", () => {
    expect(defaultFastModel([{ id: "opus" }, { id: "haiku" }])).toBeNull();
    expect(resolveFastModel(null, [{ id: "opus" }])).toBeNull();
  });

  it("resolves a saved pick, off, and a pick the catalog no longer has", () => {
    expect(resolveFastModel("claude-haiku-4-5", OPTIONS)).toBe("claude-haiku-4-5");
    expect(resolveFastModel(VOICE_MODEL_OFF, OPTIONS)).toBeNull();
    expect(resolveFastModel("claude-gone", OPTIONS)).toBe("claude-sonnet-5-5");
  });

  it("stores the pick per device", () => {
    expect(readVoiceModelPick()).toBeNull();
    writeVoiceModelPick("opus");
    expect(readVoiceModelPick()).toBe("opus");
    writeVoiceModelPick(null);
    expect(readVoiceModelPick()).toBeNull();
  });

  it("labels a row by its version, else its name", () => {
    expect(voiceModelLabel({ id: "claude-sonnet-5-5", model: "claude-sonnet-5-5" })).toBe(
      "Sonnet 5.5",
    );
    expect(voiceModelLabel({ id: "weird", displayName: "Weird One" })).toBe("Weird One");
  });

  it("names the running model from the request, else the reported row", () => {
    expect(effectiveModelId(OPTIONS, "opus", "claude-sonnet-5")).toBe("opus");
    expect(effectiveModelId(OPTIONS, null, "claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(effectiveModelId(OPTIONS, null, null)).toBeNull();
  });

  it("keeps the remembered model per chat and drops a damaged value", () => {
    writeVoiceModelState("c1", { previous: "opus", fallback: "opus", fast: "claude-sonnet-5-5" });
    expect(readVoiceModelState("c1")).toEqual({
      previous: "opus",
      fallback: "opus",
      fast: "claude-sonnet-5-5",
      owner: voiceTabId(),
      at: expect.any(Number),
    });
    expect(readVoiceModelState("c2")).toBeNull();
    clearVoiceModelState("c1");
    expect(readVoiceModelState("c1")).toBeNull();
    window.localStorage.setItem("omnigent:ae-voice-model-state:c3", "{nope");
    expect(readVoiceModelState("c3")).toBeNull();
  });

  describe("restore verdicts", () => {
    const NOW = 1_000_000_000;
    const base: VoiceModelState = {
      previous: "opus",
      fallback: "opus",
      fast: "claude-sonnet-5-5",
      owner: "tab-a",
      at: NOW,
    };
    it("reverts while still on the fast model", () => {
      expect(voiceModelVerdict(base, "claude-sonnet-5-5", OPTIONS, NOW)).toBe("revert");
    });
    it("keeps the state while the override is empty, unknown or the previous model", () => {
      expect(voiceModelVerdict(base, null, OPTIONS, NOW)).toBe("keep");
      expect(voiceModelVerdict(base, "opus", OPTIONS, NOW)).toBe("keep");
      expect(voiceModelVerdict(base, "mystery", OPTIONS, NOW)).toBe("keep");
    });
    it("treats a known third model as hand-picked", () => {
      expect(voiceModelVerdict(base, "claude-haiku-4-5", OPTIONS, NOW)).toBe("hand-picked");
    });
    it("treats an abandoned state as hand-picked", () => {
      expect(voiceModelVerdict(base, null, OPTIONS, NOW + 7 * 3_600_000)).toBe("hand-picked");
    });
  });

  describe("tab ownership", () => {
    const NOW = 1_000_000_000;
    const state: VoiceModelState = {
      previous: null,
      fallback: null,
      fast: "f",
      owner: "other-tab",
      at: NOW,
    };
    it("lets the owner, an ownerless state, a persisted-off chat or a stale state revert", () => {
      expect(mayRevertVoiceModel({ ...state, owner: voiceTabId() }, true, NOW)).toBe(true);
      expect(mayRevertVoiceModel({ ...state, owner: null }, true, NOW)).toBe(true);
      expect(mayRevertVoiceModel(state, false, NOW)).toBe(true);
      expect(mayRevertVoiceModel(state, true, NOW + 7 * 3_600_000)).toBe(true);
    });
    it("leaves another live tab's state alone", () => {
      expect(mayRevertVoiceModel(state, true, NOW + 1000)).toBe(false);
    });
  });
});
