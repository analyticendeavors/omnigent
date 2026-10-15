import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeBrowserLogin } from "./ClaudeBrowserLogin";

const mutateAsync = vi.fn();
vi.mock("@/hooks/useHosts", () => ({
  useStoreCredential: () => ({ mutateAsync, isPending: false }),
}));
beforeEach(() => mutateAsync.mockReset());
afterEach(() => vi.useRealTimers());
const waiting = {
  login_id: "id",
  login_status: "waiting",
  login_url: "https://claude.com/oauth/authorize?state=example",
};
describe("Claude browser login", () => {
  it("starts login on the chosen host and submits only the one-time code", async () => {
    mutateAsync.mockResolvedValue(waiting);
    render(<ClaudeBrowserLogin hostId="host" name="Backup" onComplete={() => {}} />);
    fireEvent.click(screen.getByText("Sign in with Claude"));
    await screen.findByText("Open Claude sign-in");
    expect(mutateAsync.mock.calls[0][0]).toEqual({
      harness: "claude-native",
      kind: "claude-login-start",
      account_name: "Backup",
    });
    expect(screen.getByRole("link").getAttribute("href")).toBe(waiting.login_url);
    fireEvent.change(screen.getByLabelText("Claude authorization code"), {
      target: { value: "code#state" },
    });
    fireEvent.click(screen.getByText("Complete sign-in"));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        harness: "claude-native",
        kind: "claude-login-code",
        account_name: "id",
        secret: "code#state",
      }),
    );
  });
  it("never links an untrusted authorization URL", async () => {
    mutateAsync.mockResolvedValue({
      ...waiting,
      login_url: "https://claude.com.evil.test/oauth/authorize",
    });
    render(<ClaudeBrowserLogin hostId="host" name="Backup" onComplete={() => {}} />);
    fireEvent.click(screen.getByText("Sign in with Claude"));
    await screen.findByText("Cancel sign-in");
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("polls until the host confirms the account was saved", async () => {
    vi.useFakeTimers();
    mutateAsync
      .mockResolvedValueOnce(waiting)
      .mockResolvedValueOnce({ login_id: "id", login_status: "complete" });
    const done = vi.fn();
    render(<ClaudeBrowserLogin hostId="host" name="Backup" onComplete={done} />);
    await act(async () => {
      fireEvent.click(screen.getByText("Sign in with Claude"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(done).toHaveBeenCalledOnce();
  });
});
