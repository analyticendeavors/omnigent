import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  fetch: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/components/ui/toast", () => ({ showToast: mocks.toast }));
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({ session: { labels: {}, hostId: null } }),
}));
vi.mock("@/hooks/useAeRoles", () => ({
  useAeRoles: () => ({
    data: {
      revision: 1,
      default_preset: "balanced",
      apply_start_on: false,
      presets: [{ id: "yolo", title: "YOLO", roles: {}, rules: {} }],
      starters: [],
    },
  }),
}));
vi.mock("@/lib/identity", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  authenticatedFetch: mocks.fetch,
}));
vi.mock("@/lib/aeLeadModelChat", () => ({
  aeSwitchPresetLead: async () => null,
  aeAnnouncePresetLead: () => {},
}));
vi.mock("@/lib/aeSessionRoles", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  saveAeSessionRoles: mocks.save,
}));

import { useAeSessionPreset } from "./useAeSessionPreset";

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  mocks.save.mockReset();
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValue(new Response("{}", { status: 404 }));
});
afterEach(cleanup);

describe("recording a preset switch", () => {
  it("calls the preset route after a pick is saved", async () => {
    mocks.save.mockResolvedValue({ labels: {} });
    const { result } = renderHook(() => useAeSessionPreset("conv_a"), { wrapper });
    await act(async () => {
      expect(await result.current.pick("yolo")).toBe(true);
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe("/v1/ae/sessions/conv_a/preset");
    expect(init).toMatchObject({ method: "PUT", body: JSON.stringify({ preset: "yolo" }) });
  });

  it("does not call it when the save fails", async () => {
    mocks.save.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useAeSessionPreset("conv_a"), { wrapper });
    await act(async () => {
      expect(await result.current.pick("yolo")).toBe(false);
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("ignores a network error from the route", async () => {
    mocks.save.mockResolvedValue({ labels: {} });
    mocks.fetch.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useAeSessionPreset("conv_a"), { wrapper });
    await act(async () => {
      expect(await result.current.pick("yolo")).toBe(true);
    });
  });
});
