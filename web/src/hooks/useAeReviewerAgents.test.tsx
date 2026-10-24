import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAeReviewerAgents } from "./useAeReviewerAgents";

const mocks = vi.hoisted(() => ({ agents: vi.fn(), hosts: vi.fn() }));
vi.mock("@/hooks/useAvailableAgents", () => ({ useAvailableAgents: mocks.agents }));
vi.mock("@/hooks/useHosts", () => ({ useHosts: mocks.hosts }));

describe("useAeReviewerAgents", () => {
  it("pins the agents the stored reviewers name, like the lead and members", () => {
    mocks.agents.mockReturnValue({ data: [], isSuccess: true });
    mocks.hosts.mockReturnValue({ data: [], isSuccess: true });
    renderHook(() => useAeReviewerAgents(undefined, ["codex-id"]));
    expect(mocks.agents).toHaveBeenLastCalledWith({
      enabled: true,
      pinnedAgentIds: ["codex-id"],
    });
    renderHook(() => useAeReviewerAgents());
    expect(mocks.agents).toHaveBeenLastCalledWith({ enabled: true, pinnedAgentIds: undefined });
  });
});
