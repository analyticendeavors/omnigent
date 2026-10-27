import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: { session: null as { hostId?: string } | null, isLoading: false },
  credentials: { data: undefined as unknown, isSuccess: false, isError: false, isFetching: false },
  hostsAsked: [] as unknown[],
  sessionsAsked: [] as unknown[],
}));
vi.mock("@/hooks/useSession", () => ({
  useSession: (id: unknown) => {
    mocks.sessionsAsked.push(id);
    return mocks.session;
  },
}));
vi.mock("@/hooks/useHosts", () => ({
  useDetectedCredentials: (hostId: unknown) => {
    mocks.hostsAsked.push(hostId);
    return mocks.credentials;
  },
}));

import { useChatStore } from "@/store/chatStore";
import { useAePickedClaudeAccount } from "./useAePickedClaudeAccount";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

beforeEach(() => {
  mocks.hostsAsked = [];
  mocks.sessionsAsked = [];
  useChatStore.setState({ conversationId: null, sessionHostId: null });
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

  it("names a new chat's pick from the host the composer seeded, with no session read", () => {
    useChatStore.setState({ conversationId: "temp:abc", sessionHostId: "h-seeded" });
    mocks.session = { session: null, isLoading: false };
    mocks.credentials = {
      data: [{ family: "claude-oauth-active", source: "AE Backup", env_var: "shared:AE Backup" }],
      isSuccess: true,
      isError: false,
      isFetching: false,
    };
    const { result } = renderHook(() => useAePickedClaudeAccount("temp:abc", true), { wrapper });
    expect(result.current).toEqual({ account: "shared:AE Backup", ready: true });
    expect(mocks.hostsAsked).toEqual(["h-seeded"]);
    expect(mocks.sessionsAsked.every((id) => id === null)).toBe(true);
  });

  it("waits for the logins of a new chat's seeded host", () => {
    useChatStore.setState({ conversationId: "temp:def", sessionHostId: "h-seeded" });
    const { result } = renderHook(() => useAePickedClaudeAccount("temp:def", true), { wrapper });
    expect(result.current).toEqual({ account: undefined, ready: false });
  });
});
