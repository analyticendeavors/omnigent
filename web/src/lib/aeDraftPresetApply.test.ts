import { beforeEach, describe, expect, it, vi } from "vitest";
import { aeBindDraftPreset, aeGetDraftPick, aeSetDraftPick } from "./aeDraftPreset";
import { aeApplyNewChatStart } from "./aeDraftPresetApply";
import { aeQueueStartOn, aeTakeStartOn } from "./aeStartOnApply";
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
  roles: {},
  rules: {},
});
const ROLES = {
  revision: 1,
  default_preset: "balanced",
  apply_start_on: true,
  presets: [preset("balanced", "Balanced"), preset("yolo", "YOLO")],
  starters: [],
};
const session = { id: "s1", labels: {} } as unknown as Session;

beforeEach(() => {
  vi.resetAllMocks();
  aeSetDraftPick(null);
  mocks.fetchAeRoles.mockResolvedValue(ROLES);
  mocks.getSessionSlim.mockResolvedValue(session);
  mocks.updateSession.mockImplementation(async (_id: string, patch: object) => ({
    ...session,
    ...patch,
  }));
});

const bind = (id: string, pick: string, models: object[] = []) => {
  aeSetDraftPick(pick);
  aeBindDraftPreset(id, models as never);
};

describe("aeApplyNewChatStart", () => {
  it("applies a bound pick to the new session, once, and clears the draft", async () => {
    bind("s1", "yolo");
    expect(aeGetDraftPick()).toBeNull();
    const onSession = vi.fn();
    await aeApplyNewChatStart("s1", "s1", onSession);
    const label = JSON.parse(mocks.updateSession.mock.calls[0][1].labels["ae.team"]);
    expect(label.roles).toEqual({ preset: "yolo" });
    expect(onSession).toHaveBeenCalledTimes(1);
    expect(mocks.toast).not.toHaveBeenCalled();
    await aeApplyNewChatStart("s1", "s1", onSession);
    expect(mocks.updateSession).toHaveBeenCalledTimes(1);
  });

  it("beats a queued START ON line in the same message", async () => {
    bind("s1", "yolo");
    aeQueueStartOn("s1", { text: 'START ON: preset "Balanced"', models: [] });
    await aeApplyNewChatStart("s1", "s1", vi.fn());
    expect(mocks.updateSession).toHaveBeenCalledTimes(1);
    expect(aeTakeStartOn("s1")).toBeNull();
  });

  it("writes nothing for a bound default", async () => {
    bind("s1", "balanced");
    await aeApplyNewChatStart("s1", "s1", vi.fn());
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it("leaves a pick bound to another session alone", async () => {
    bind("s2", "yolo");
    await aeApplyNewChatStart("s1", "s1", vi.fn());
    expect(mocks.updateSession).not.toHaveBeenCalled();
    await aeApplyNewChatStart("s2", "s2", vi.fn());
    expect(mocks.updateSession).toHaveBeenCalledTimes(1);
  });

  it("toasts once and returns when the PATCH fails", async () => {
    bind("s1", "yolo");
    mocks.updateSession.mockRejectedValue(new Error("down"));
    await aeApplyNewChatStart("s1", "s1", vi.fn());
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(
      "Could not apply the YOLO preset: down. The message was sent as is.",
    );
  });

  it("toasts once with the pick id when the presets cannot be read", async () => {
    bind("s1", "yolo");
    mocks.fetchAeRoles.mockRejectedValue(new Error("offline"));
    await aeApplyNewChatStart("s1", "s1", vi.fn());
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(
      "Could not apply the yolo preset: offline. The message was sent as is.",
    );
  });

  it("switches the model for a fixed-lead preset from the bound options", async () => {
    mocks.fetchAeRoles.mockResolvedValue({
      ...ROLES,
      presets: [
        ...ROLES.presets,
        {
          ...preset("fast", "Fast"),
          roles: {
            ...preset("fast", "Fast").roles,
            lead: { mode: "fixed", model: "opus", effort: "high" },
          },
        },
      ],
    });
    bind("s1", "fast", [{ id: "opus", model: "claude-opus-5-5", displayName: "Opus 5.5" }]);
    await aeApplyNewChatStart("s1", "s1", vi.fn());
    const patches = mocks.updateSession.mock.calls.map(([, patch]) => patch);
    expect(patches.some((p) => "modelOverride" in p)).toBe(true);
  });

  it("reports a fixed lead the host does not offer", async () => {
    mocks.fetchAeRoles.mockResolvedValue({
      ...ROLES,
      presets: [
        ...ROLES.presets,
        {
          ...preset("fast", "Fast"),
          roles: {
            ...preset("fast", "Fast").roles,
            lead: { mode: "fixed", model: "opus", effort: "high" },
          },
        },
      ],
    });
    bind("s1", "fast", []);
    await aeApplyNewChatStart("s1", "s1", vi.fn());
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(String(mocks.toast.mock.calls[0][0])).toMatch(/^Could not apply the Fast preset: /);
  });
});
