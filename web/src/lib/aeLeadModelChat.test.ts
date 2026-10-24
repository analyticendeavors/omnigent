import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/store/chatStore";
import { aeAnnouncePresetLead, aeSwitchPresetLead } from "./aeLeadModelChat";
import type { Session } from "./types";

const mocks = vi.hoisted(() => ({
  getSessionSlim: vi.fn(),
  updateSession: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/sessionsApi", async (original) => ({
  ...(await original<object>()),
  getSessionSlim: mocks.getSessionSlim,
  updateSession: mocks.updateSession,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

const YOLO = {
  title: "YOLO",
  roles: {
    lead: { mode: "fixed", model: "claude-fable-5-1", effort: "max" },
    planner: { mode: "auto" },
    reviewer: { mode: "auto" },
    builder: { mode: "auto" },
    helper: { mode: "auto" },
  },
} as const;
const session = {
  id: "s1",
  hostId: "h1",
  labels: { "omnigent.wrapper": "claude-code-native-ui" },
  modelOverride: "opus",
  reasoningEffort: "high",
} as unknown as Session;

const initial = useChatStore.getState();
let queryClient: QueryClient;
// The server's row for s1: the chat store's writes land here too.
let stored: Session;
beforeEach(() => {
  vi.resetAllMocks();
  queryClient = new QueryClient();
  stored = { ...session };
  mocks.getSessionSlim.mockImplementation(async () => stored);
  mocks.updateSession.mockImplementation(async (_id: string, patch: object) => {
    stored = { ...stored, ...patch };
    return stored;
  });
});
afterEach(() => {
  useChatStore.setState(initial, true);
});

describe("aeSwitchPresetLead", () => {
  it("switches the open chat through the chat store's setModel and setEffort", async () => {
    const setModel = vi.fn(async (model: string | null) => {
      useChatStore.setState({ sessionModelOverride: model });
      stored = { ...stored, modelOverride: model };
    });
    const setEffort = vi.fn(async (effort: string | null) => {
      useChatStore.setState({ sessionReasoningEffort: effort });
      stored = { ...stored, reasoningEffort: effort };
    });
    useChatStore.setState({
      conversationId: "s1",
      codexModelOptions: [{ id: "fable", model: "claude-fable-5-1", displayName: "Fable 5.1" }],
      setModel,
      setEffort,
    });
    queryClient.setQueryData(["session", "s1"], { ...session, harness: "claude-native" });
    const result = await aeSwitchPresetLead(queryClient, "s1", "h1", YOLO);
    expect(setModel).toHaveBeenCalledWith("fable", { expectConfirmation: true });
    expect(setEffort).toHaveBeenCalledWith("max");
    expect(mocks.updateSession).not.toHaveBeenCalled();
    aeAnnouncePresetLead(queryClient, "s1", "YOLO", result);
    expect(mocks.toast).toHaveBeenCalledWith(
      "Lead switched to Fable 5.1 max",
      expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }),
    );
  });

  it("reads the switched session's own row when the user moves to another chat mid-switch", async () => {
    const setModel = vi.fn(async (model: string | null) => {
      stored = { ...stored, modelOverride: model };
      // The user opened another chat while the harness confirmed the switch.
      useChatStore.setState({ conversationId: "other", sessionModelOverride: "haiku" });
    });
    useChatStore.setState({
      conversationId: "s1",
      codexModelOptions: [{ id: "fable", model: "claude-fable-5-1", displayName: "Fable 5.1" }],
      setModel,
    });
    queryClient.setQueryData(["session", "s1"], { ...session, harness: "claude-native" });
    const result = await aeSwitchPresetLead(queryClient, "s1", "h1", YOLO);
    expect(result).toMatchObject({
      kind: "switched",
      after: { model: "fable", effort: "max" },
    });
    // The effort went to s1 by PATCH, since s1 is no longer the open chat.
    expect(mocks.updateSession).toHaveBeenCalledWith("s1", { reasoningEffort: "max" });
  });

  it("says the switch did not take when the session's model is not the target", async () => {
    const setModel = vi.fn(async () => {
      // The harness refused quietly: the row keeps its old model.
    });
    useChatStore.setState({
      conversationId: "s1",
      codexModelOptions: [{ id: "fable", model: "claude-fable-5-1", displayName: "Fable 5.1" }],
      setModel,
    });
    queryClient.setQueryData(["session", "s1"], { ...session, harness: "claude-native" });
    const result = await aeSwitchPresetLead(queryClient, "s1", "h1", YOLO);
    expect(result).toEqual({ kind: "not_taken", name: "Fable 5.1" });
    aeAnnouncePresetLead(queryClient, "s1", "YOLO", result);
    expect(mocks.toast).toHaveBeenCalledWith(
      "Roles preset: YOLO. The switch to Fable 5.1 did not take, so the model is as it was. Use the model picker.",
      { duration: 6_000 },
    );
  });

  it("uses only the cached options of the session's own harness", async () => {
    useChatStore.setState({ conversationId: "other" });
    queryClient.setQueryData(["session", "s1"], { ...session, harness: "codex-native" });
    queryClient.setQueryData(
      ["host-model-options", "h1", "claude-native"],
      [{ id: "fable", model: "claude-fable-5-1", displayName: "Fable 5.1" }],
    );
    const result = await aeSwitchPresetLead(queryClient, "s1", "h1", YOLO);
    expect(result).toEqual({ kind: "missing", name: expect.any(String) });
    expect(mocks.updateSession).not.toHaveBeenCalled();
    // No harness known: no fallback either.
    queryClient.removeQueries({ queryKey: ["session", "s1"] });
    expect(await aeSwitchPresetLead(queryClient, "s1", "h1", YOLO)).toMatchObject({
      kind: "missing",
    });
  });

  it("PATCHes a session that is not the open chat, using the host's cached options", async () => {
    useChatStore.setState({ conversationId: "other" });
    queryClient.setQueryData(["session", "s1"], { ...session, harness: "claude-native" });
    queryClient.setQueryData(
      ["host-model-options", "h1", "claude-native"],
      [{ id: "fable", model: "claude-fable-5-1", displayName: "Fable 5.1" }],
    );
    await aeSwitchPresetLead(queryClient, "s1", "h1", YOLO);
    expect(mocks.updateSession.mock.calls).toEqual([
      ["s1", { modelOverride: "fable" }],
      ["s1", { reasoningEffort: "max" }],
    ]);
    expect(queryClient.getQueryData(["session", "s1"])).toMatchObject({ reasoningEffort: "max" });
  });

  it("leaves the model alone for a preset whose lead is the session model", async () => {
    const preset = { ...YOLO, roles: { ...YOLO.roles, lead: { mode: "session" } } } as const;
    expect(await aeSwitchPresetLead(queryClient, "s1", "h1", preset)).toEqual({ kind: "none" });
    expect(mocks.getSessionSlim).not.toHaveBeenCalled();
  });

  it("reports a failed model write instead of throwing", async () => {
    useChatStore.setState({ conversationId: "other" });
    queryClient.setQueryData(
      ["host-model-options", "h1", "claude-native"],
      [{ id: "fable", model: "claude-fable-5-1" }],
    );
    queryClient.setQueryData(["session", "s1"], { ...session, harness: "claude-native" });
    mocks.updateSession.mockRejectedValueOnce(new Error("runner offline"));
    const result = await aeSwitchPresetLead(queryClient, "s1", "h1", YOLO);
    expect(result).toEqual({ kind: "failed", reason: "runner offline" });
    aeAnnouncePresetLead(queryClient, "s1", "YOLO", result);
    expect(mocks.toast).toHaveBeenCalledWith(
      "Roles preset: YOLO. Could not switch the lead model: runner offline. Use the model picker.",
    );
  });
});
