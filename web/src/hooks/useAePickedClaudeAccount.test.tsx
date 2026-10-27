import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: { session: null as { hostId?: string } | null, isLoading: false },
  credentials: { data: undefined as unknown, isSuccess: false, isError: false, isFetching: false },
}));
vi.mock("@/hooks/useSession", () => ({ useSession: () => mocks.session }));
vi.mock("@/hooks/useHosts", () => ({ useDetectedCredentials: () => mocks.credentials }));

import { useAePickedClaudeAccount } from "./useAePickedClaudeAccount";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

beforeEach(() => {
  mocks.session = { session: { hostId: "h1" }, isLoading: false };
  mocks.credentials = { data: undefined, isSuccess: false, isError: false, isFetching: false };
});

describe("useAePickedClaudeAccount", () => {
  it("is ready with no account when it is off", () => {
    const { result } = renderHook(() => useAePickedClaudeAccount("conv_a", false), { wrapper });
    expect(result.current).toEqual({ account: undefined, ready: true });
  });

  it("waits for the host's logins, then names the selected one", async () => {
    const { result, rerender } = renderHook(() => useAePickedClaudeAccount("conv_a", true), {
      wrapper,
    });
    expect(result.current).toEqual({ account: undefined, ready: false });
    mocks.credentials = {
      data: [
        { family: "claude-oauth", source: "Default CLI account", env_var: "" },
        { family: "claude-oauth-active", source: "AE Backup", env_var: "shared:AE Backup" },
      ],
      isSuccess: true,
      isError: false,
      isFetching: false,
    };
    rerender();
    await waitFor(() =>
      expect(result.current).toEqual({ account: "shared:AE Backup", ready: true }),
    );
  });

  it("is ready without a hint when the logins cannot be read or the host is unknown", () => {
    mocks.credentials = { data: undefined, isSuccess: false, isError: true, isFetching: false };
    const failed = renderHook(() => useAePickedClaudeAccount("conv_a", true), { wrapper });
    expect(failed.result.current).toEqual({ account: undefined, ready: true });
    mocks.session = { session: null, isLoading: false };
    const noHost = renderHook(() => useAePickedClaudeAccount("conv_a", true), { wrapper });
    expect(noHost.result.current).toEqual({ account: undefined, ready: true });
  });

  it("does not name a pick from stale cached logins while a refetch is in flight", () => {
    mocks.credentials = {
      data: [{ family: "claude-oauth-active", source: "AE Backup", env_var: "AE Backup" }],
      isSuccess: true,
      isError: false,
      isFetching: true,
    };
    const { result, rerender } = renderHook(() => useAePickedClaudeAccount("conv_a", true), {
      wrapper,
    });
    expect(result.current).toEqual({ account: undefined, ready: false });
    mocks.credentials = {
      data: [{ family: "claude-oauth-active", source: "Default CLI account", env_var: "" }],
      isSuccess: true,
      isError: false,
      isFetching: false,
    };
    rerender();
    expect(result.current).toEqual({ account: "", ready: true });
  });
});
