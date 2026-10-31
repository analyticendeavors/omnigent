import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AeClaudeAccountSubmenu } from "./AeClaudeAccountSubmenu";
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import type { Host } from "@/hooks/useHosts";
import { AE_ACCOUNT_FOLLOW_UP_DELAYS_MS } from "@/lib/aeClaudeAccount";
import { dismissAeMoveAll } from "@/lib/aeMoveAllChats";
import { dismissAeSwitchFamily, useAeSwitchFamilyRequest } from "@/lib/aeSwitchFamily";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));
const familyRows = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/lib/aeFamilyRead", () => ({
  aeReadFamilySessions: () => Promise.resolve(familyRows.rows),
  aeFamilyOf: () => [],
}));
import { authenticatedFetch } from "@/lib/identity";

const mutate = vi.fn();
let rows: { family: string; source: string; env_var: string }[] = [];
let labels: Record<string, string> = {};
vi.mock("@/hooks/useHosts", () => ({
  useDetectedCredentials: () => ({ data: rows, isError: false, isSuccess: true }),
  useStoreCredential: () => ({ mutate, isPending: false }),
}));
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({ session: { id: "s1", hostId: "host", labels }, isLoading: false }),
}));

const host = { host_id: "host", name: "Laptop" } as Host;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

let qc: QueryClient;

function Asked() {
  const ask = useAeSwitchFamilyRequest();
  return (
    <span data-testid="ask">{ask ? `${ask.account}|${ask.label}|${ask.childCount}` : ""}</span>
  );
}

function renderMenu(turnBusy = false, sessionId = "s1") {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Asked />
      <DropdownMenu open>
        <DropdownMenuContent>
          <AeClaudeAccountSubmenu host={host} sessionId={sessionId} turnBusy={turnBusy} />
        </DropdownMenuContent>
      </DropdownMenu>
    </QueryClientProvider>,
  );
  fireEvent.keyDown(screen.getByTestId("composer-claude-account"), { key: "ArrowRight" });
}

beforeEach(() => {
  mutate.mockReset();
  vi.mocked(authenticatedFetch).mockReset();
  dismissAeMoveAll();
  dismissAeSwitchFamily();
  familyRows.rows = [];
  labels = { "ae.claude_account": "AE Backup" };
  rows = [
    { family: "claude-oauth-active", source: "AE Default", env_var: "" },
    { family: "claude-oauth", source: "AE Backup", env_var: "AE Backup" },
  ];
});

describe("Account submenu inside a chat", () => {
  it("has a This chat group ticked by the live label and a New chats group below it", () => {
    renderMenu();
    expect(screen.getByTestId("composer-claude-account-chat")).toHaveTextContent("This chat");
    expect(screen.getByTestId("composer-claude-account-new")).toHaveTextContent("New chats");
    const backup = screen.getByTestId("composer-claude-account-chat-AE Backup");
    expect(backup).toHaveAttribute("role", "menuitemradio");
    expect(backup).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("composer-claude-account-chat-default")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    // The new-chat rows are the host default (the active row), a separate list.
    expect(screen.getByTestId("composer-claude-account-default")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("composer-claude-account-value")).toHaveTextContent("AE Backup");
  });

  it("the server label outranks the live label", () => {
    labels = { "omnigent.claude_native.account": "", "ae.claude_account": "AE Backup" };
    renderMenu();
    expect(screen.getByTestId("composer-claude-account-chat-default")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("picking a login calls the PUT, then re-reads the chat and its Usage", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => json({ account: "", relaunched: true }));
    renderMenu();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    fireEvent.click(screen.getByTestId("composer-claude-account-chat-default"));
    await waitFor(() =>
      expect(authenticatedFetch).toHaveBeenCalledWith(
        "/v1/ae/sessions/s1/claude-account",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ account: "" }) }),
      ),
    );
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["session", "s1"] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["ae-limits", "s1"] });
    });
  });

  describe("follow-up re-reads", () => {
    afterEach(() => vi.useRealTimers());
    const reads = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(([a]) => {
        const key = (a as { queryKey?: unknown[] }).queryKey;
        return key?.[0] === "ae-limits" && key?.[1] === "s7";
      }).length;

    it("a switch that went through re-reads this chat's Usage on the schedule", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.mocked(authenticatedFetch).mockImplementation(() =>
        json({ account: "", relaunched: true }),
      );
      renderMenu(false, "s7");
      const invalidate = vi.spyOn(qc, "invalidateQueries");
      fireEvent.click(screen.getByTestId("composer-claude-account-chat-default"));
      await waitFor(() => expect(reads(invalidate)).toBe(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          AE_ACCOUNT_FOLLOW_UP_DELAYS_MS[AE_ACCOUNT_FOLLOW_UP_DELAYS_MS.length - 1],
        );
      });
      expect(reads(invalidate)).toBe(1 + AE_ACCOUNT_FOLLOW_UP_DELAYS_MS.length);
    });
  });

  it("asks about the child chats, and sends nothing yet, when the chat has some", async () => {
    familyRows.rows = [{ id: "kid", object: "conversation", labels: { "ae.orch": "s1" } }];
    renderMenu();
    fireEvent.click(screen.getByTestId("composer-claude-account-chat-default"));
    await waitFor(() => expect(screen.getByTestId("ask").textContent).toBe("|AE Default|1"));
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it("names a removed login as unavailable, never as the host's active one", () => {
    labels = { "omnigent.claude_native.account": "Gone" };
    renderMenu();
    const value = screen.getByTestId("composer-claude-account-value");
    expect(value).toHaveTextContent("Gone (unavailable)");
    expect(value).not.toHaveTextContent("AE Default");
    expect(screen.getByTestId("composer-claude-account-unavailable")).toHaveClass(
      "text-destructive",
    );
  });

  it("gives a new chat's temp id no This chat group and shows the new-chat default", () => {
    renderMenu(false, "temp:new-1");
    expect(screen.queryByTestId("composer-claude-account-chat")).toBeNull();
    expect(screen.queryByTestId("composer-claude-account-new")).toBeNull();
    expect(screen.getByTestId("composer-claude-account-value")).toHaveTextContent("AE Default");
  });

  it("shows the server's refusal under the rows", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({ error: { message: "Claude is mid-reply or waiting on an approval." } }, 409),
    );
    renderMenu();
    fireEvent.click(screen.getByTestId("composer-claude-account-chat-default"));
    expect(await screen.findByTestId("composer-claude-account-chat-error")).toHaveTextContent(
      "mid-reply",
    );
  });

  it("is disabled with the reason while a reply runs", () => {
    renderMenu(true);
    const row = screen.getByTestId("composer-claude-account-chat-default");
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("composer-claude-account-chat-busy")).toHaveTextContent(
      "Claude is replying",
    );
    fireEvent.click(row);
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it("hides This chat for a chat on provider credentials", () => {
    rows = [...rows, { family: "claude-provider-env", source: "Gateway", env_var: "X" }];
    renderMenu();
    expect(screen.queryByTestId("composer-claude-account-chat")).toBeNull();
    expect(screen.queryByTestId("composer-claude-account-new")).toBeNull();
  });

  it("picking a new-chat default asks whether to move every open chat", () => {
    mutate.mockImplementation((_input: unknown, options: { onSuccess?: () => void }) =>
      options.onSuccess?.(),
    );
    renderMenu();
    fireEvent.click(screen.getByTestId("composer-claude-account-AE Backup"));
    expect(mutate).toHaveBeenCalledWith(
      { harness: "claude-native", kind: "claude-oauth-select", account_name: "AE Backup" },
      expect.anything(),
    );
  });
});
