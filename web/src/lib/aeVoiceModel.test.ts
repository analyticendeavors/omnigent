import { beforeEach, describe, expect, it } from "vitest";
import {
  clearVoiceModelState,
  defaultFastModel,
  effectiveModelId,
  readVoiceModelPick,
  readVoiceModelState,
  resolveFastModel,
  VOICE_MODEL_OFF,
  voiceModelLabel,
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
    });
    expect(readVoiceModelState("c2")).toBeNull();
    clearVoiceModelState("c1");
    expect(readVoiceModelState("c1")).toBeNull();
    window.localStorage.setItem("omnigent:ae-voice-model-state:c3", "{nope");
    expect(readVoiceModelState("c3")).toBeNull();
  });
});
