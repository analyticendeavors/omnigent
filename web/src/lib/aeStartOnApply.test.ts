import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  aeApplyQueuedStartOn,
  aeDropStartOn,
  aeQueueStartOn,
  aeTakeStartOn,
} from "./aeStartOnApply";
import type { Session } from "./types";

const mocks = vi.hoisted(() => ({
  fetchAeRoles: vi.fn(),
  getSessionSlim: vi.fn(),
  updateSession: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/hooks/useAeRoles", () => ({ fetchAeRoles: mocks.fetchAeRoles }));
vi.mock("@/lib/sessionsApi", () => ({
  getSessionSlim: mocks.getSessionSlim,
  updateSession: mocks.updateSession,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

const preset = (id: string, title: string) => ({
  id,
  title,
  icon: "scale",
  color: "teal",
  description: "",
  when_to_use: "",
  pinned: false,
  roles: {
    lead: { mode: "session" },
    planner: { mode: "auto" },
    reviewer: { mode: "auto" },
    builder: { mode: "auto" },
    helper: { mode: "auto" },
  },
  rules: { raise_or_lower: "tell", lead_steps_down: true, auto_raises: 1 },
});
const ROLES = {
  revision: 1,
  default_preset: "balanced",
  apply_start_on: true,
  presets: [preset("balanced", "Balanced"), preset("yolo", "YOLO")],
  starters: [],
};
const MODELS = [{ id: "opus", model: "claude-opus-5-5", displayName: "Opus 5.5" }];
const session = {
  id: "s1",
  labels: {
    "omnigent.wrapper": "claude-code-native-ui",
    "ae.team": JSON.stringify({ version: 1, mode: "solo", members: [] }),
  },
  modelOverride: "sonnet",
  reasoningEffort: "medium",
} as unknown as Session;

function undoAction() {
  const call = mocks.toast.mock.calls.find(([text]) => String(text).startsWith("Started on"));
  return call?.[1]?.action?.onClick as () => void;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.fetchAeRoles.mockResolvedValue(ROLES);
  mocks.getSessionSlim.mockResolvedValue(session);
  mocks.updateSession.mockImplementation(async (_id: string, patch: object) => ({
    ...session,
    ...patch,
  }));
});

describe("aeApplyQueuedStartOn", () => {
  it("sets the preset in the label, once, and Undo puts the old choice back", async () => {
    const onSession = vi.fn();
    aeQueueStartOn("s1", { text: 'START ON: preset "YOLO"', models: MODELS });
    await aeApplyQueuedStartOn("s1", "s1", onSession);
    const label = JSON.parse(mocks.updateSession.mock.calls[0][1].labels["ae.team"]);
    expect(label).toEqual({ version: 1, mode: "solo", members: [], roles: { preset: "yolo" } });
    expect(onSession).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith("Started on YOLO", expect.anything());

    await aeApplyQueuedStartOn("s1", "s1", onSession);
    expect(mocks.updateSession).toHaveBeenCalledTimes(1);

    mocks.getSessionSlim.mockResolvedValue({
      ...session,
      labels: { "ae.team": label ? JSON.stringify(label) : "" },
    });
    undoAction()();
    await vi.waitFor(() => expect(mocks.updateSession).toHaveBeenCalledTimes(2));
    const restored = JSON.parse(mocks.updateSession.mock.calls[1][1].labels["ae.team"]);
    expect(restored).toEqual({ version: 1, mode: "solo", members: [] });
  });

  it("sets model and effort and Undo restores both", async () => {
    aeQueueStartOn(null, { text: "START ON: Opus 5.5 high", models: MODELS });
    await aeApplyQueuedStartOn(null, "s1", vi.fn());
    expect(mocks.updateSession.mock.calls.map((c) => c[1])).toEqual([
      { modelOverride: "opus" },
      { reasoningEffort: "high" },
    ]);
    mocks.getSessionSlim.mockResolvedValue({
      ...session,
      modelOverride: "opus",
      reasoningEffort: "high",
    });
    undoAction()();
    await vi.waitFor(() => expect(mocks.updateSession).toHaveBeenCalledTimes(4));
    expect(mocks.updateSession.mock.calls.slice(2).map((c) => c[1])).toEqual([
      { modelOverride: "sonnet" },
      { reasoningEffort: "medium" },
    ]);
  });

  it("changes nothing when the switch is off, the line is unreadable or the plan is for another session", async () => {
    mocks.fetchAeRoles.mockResolvedValue({ ...ROLES, apply_start_on: false });
    aeQueueStartOn("s1", { text: "START ON: YOLO", models: MODELS });
    await aeApplyQueuedStartOn("s1", "s1", vi.fn());
    mocks.fetchAeRoles.mockResolvedValue(ROLES);
    aeQueueStartOn("s1", { text: "START ON: something odd", models: MODELS });
    await aeApplyQueuedStartOn("s1", "s1", vi.fn());
    aeQueueStartOn("s2", { text: "START ON: YOLO", models: MODELS });
    await aeApplyQueuedStartOn("s1", "s1", vi.fn());
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("does not put back a model or effort that changed after START ON, and says so", async () => {
    aeQueueStartOn(null, { text: "START ON: Opus 5.5 high", models: MODELS });
    await aeApplyQueuedStartOn(null, "s1", vi.fn());
    mocks.getSessionSlim.mockResolvedValue({
      ...session,
      modelOverride: "haiku",
      reasoningEffort: "high",
    });
    undoAction()();
    await vi.waitFor(() => expect(mocks.updateSession).toHaveBeenCalledTimes(3));
    expect(mocks.updateSession.mock.calls[2][1]).toEqual({ reasoningEffort: "medium" });
    expect(mocks.toast).toHaveBeenLastCalledWith(
      "Put back the effort. Left the model as it is now, since it changed after START ON.",
    );
  });

  it("says when the model landed but the effort did not, and still offers Undo", async () => {
    mocks.updateSession.mockImplementation(async (_id: string, patch: object) => {
      if ("reasoningEffort" in patch) throw new Error("effort refused");
      return { ...session, ...patch };
    });
    aeQueueStartOn(null, { text: "START ON: Opus 5.5 high", models: MODELS });
    await aeApplyQueuedStartOn(null, "s1", vi.fn());
    expect(mocks.toast).toHaveBeenCalledWith(
      "Started on Opus 5.5; effort high was not applied (effort refused).",
      expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }),
    );
    mocks.getSessionSlim.mockResolvedValue({ ...session, modelOverride: "opus" });
    mocks.updateSession.mockClear();
    mocks.updateSession.mockImplementation(async (_id: string, patch: object) => ({
      ...session,
      ...patch,
    }));
    const call = mocks.toast.mock.calls.find(([text]) => String(text).startsWith("Started on"));
    call?.[1]?.action?.onClick();
    await vi.waitFor(() => expect(mocks.updateSession).toHaveBeenCalledTimes(1));
    expect(mocks.updateSession.mock.calls[0][1]).toEqual({ modelOverride: "sonnet" });
  });

  it("past the budget the send goes on, then the Started on toast and Undo follow", async () => {
    vi.useFakeTimers();
    try {
      let release: (value: Session) => void = () => {};
      mocks.getSessionSlim.mockReturnValue(
        new Promise<Session>((resolve) => {
          release = resolve;
        }),
      );
      aeQueueStartOn(null, { text: 'START ON: preset "YOLO"', models: MODELS });
      const applied = aeApplyQueuedStartOn(null, "s1", vi.fn());
      await vi.advanceTimersByTimeAsync(8_100);
      await applied;
      expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("taking a while"));
      expect(mocks.toast).not.toHaveBeenCalledWith("Started on YOLO", expect.anything());
      release(session);
      await vi.advanceTimersByTimeAsync(10);
      expect(mocks.toast).toHaveBeenCalledWith(
        "Started on YOLO",
        expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a queued plan whose send aborts does not apply to the next message", async () => {
    aeQueueStartOn("s1", { text: "START ON: YOLO", models: MODELS });
    aeDropStartOn("s2");
    expect(aeTakeStartOn("s1")).not.toBeNull();
    aeQueueStartOn("s1", { text: "START ON: YOLO", models: MODELS });
    aeDropStartOn("s1");
    await aeApplyQueuedStartOn("s1", "s1", vi.fn());
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });
});
