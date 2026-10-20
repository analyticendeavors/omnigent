import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAccounts } from "./ClaudeAccounts";
import type { Host } from "@/hooks/useHosts";
import type * as identity from "@/lib/identity";

const mutate = vi.fn();
let rows = [
  { family: "claude-oauth-active", source: "Default CLI account", env_var: "" },
  { family: "claude-oauth", source: "Backup", env_var: "Backup" },
];
let isPending = false;
const refetch = vi.fn();
const invalidateAll = vi.fn();
vi.mock("@/hooks/useHosts", () => ({
  useDetectedCredentials: () => ({ data: rows, refetch }),
  useStoreCredential: () => ({ mutate, isPending }),
  useInvalidateDetectedCredentials: () => invalidateAll,
}));
let isAdmin = false;
vi.mock("@/lib/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof identity>()),
  getCurrentIsAdmin: () => isAdmin,
}));
const fetchMock = vi.fn();
const host = { host_id: "host", name: "Laptop" } as Host;
beforeEach(() => {
  mutate.mockReset();
  refetch.mockReset();
  invalidateAll.mockReset();
  isAdmin = false;
  fetchMock.mockReset();
  // The Shared group's read stays pending unless a test answers it.
  fetchMock.mockReturnValue(new Promise(() => {}));
  vi.stubGlobal("fetch", fetchMock);
  rows = [
    { family: "claude-oauth-active", source: "Default CLI account", env_var: "" },
    { family: "claude-oauth", source: "Backup", env_var: "Backup" },
  ];
  isPending = false;
});
describe("ClaudeAccounts", () => {
  it("shows only compact account choices with the new-chat default identified", () => {
    rows = [...rows, { family: "claude-oauth", source: "Personal", env_var: "Personal" }];
    render(<ClaudeAccounts host={host} compact />);

    const picker = screen.getByTestId("claude-accounts");
    expect(picker.querySelector(".grid-cols-2")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByText("Claude subscription account")).toBeNull();
    expect(screen.queryByText(/Used for new Claude subscription chats/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Rename/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Claude account" })).toBeNull();
    expect(screen.getByRole("button", { name: "Default CLI account (selected)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Default CLI account (selected)" })).toHaveAttribute(
      "title",
      "Default CLI account: current new-chat default",
    );
    fireEvent.click(screen.getByRole("button", { name: "Personal" }));
    expect(mutate.mock.calls[0][0]).toEqual({
      harness: "claude-native",
      kind: "claude-oauth-select",
      account_name: "Personal",
    });
    act(() => mutate.mock.calls[0][1].onError(new Error("Selection failed.")));
    expect(screen.getByRole("alert")).toHaveTextContent("Selection failed.");
  });

  it("keeps account management and explanation in the default view", () => {
    render(<ClaudeAccounts host={host} />);
    expect(screen.getByText("Claude subscription account")).toBeTruthy();
    expect(screen.getByText(/Used for new Claude subscription chats/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rename Backup" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Claude account" })).toBeTruthy();
  });

  it("selects the backup account without a token", () => {
    render(<ClaudeAccounts host={host} />);
    fireEvent.click(screen.getByText("Backup"));
    expect(mutate.mock.calls[0][0]).toEqual({
      harness: "claude-native",
      kind: "claude-oauth-select",
      account_name: "Backup",
    });
    expect(screen.getByText(/Start a new chat/)).toBeTruthy();
  });
  it("adds a named OAuth token through the credential endpoint", () => {
    render(<ClaudeAccounts host={host} />);
    fireEvent.click(screen.getByText("Add Claude account"));
    fireEvent.change(screen.getByLabelText("Claude account name"), {
      target: { value: "Personal" },
    });
    fireEvent.change(screen.getByLabelText("Claude OAuth token"), {
      target: { value: "sk-ant-oat-example" },
    });
    fireEvent.click(screen.getByText("Save account"));
    expect(mutate.mock.calls[0][0]).toEqual({
      harness: "claude-native",
      kind: "claude-oauth-add",
      account_name: "Personal",
      secret: "sk-ant-oat-example",
    });
  });
  it("renames the default account using its empty stable ID", () => {
    render(<ClaudeAccounts host={host} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename Default CLI account" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Account label for Default CLI account" }),
      {
        target: { value: "  Main  " },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(mutate.mock.calls[0][0]).toEqual({
      harness: "claude-native",
      kind: "claude-oauth-rename",
      account_name: "",
      account_label: "Main",
    });
  });
  it("keeps the backup stable ID for selection after its label changes", () => {
    const view = render(<ClaudeAccounts host={host} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename Backup" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Account label for Backup" }), {
      target: { value: "Work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(mutate.mock.calls[0][0]).toEqual({
      harness: "claude-native",
      kind: "claude-oauth-rename",
      account_name: "Backup",
      account_label: "Work",
    });
    act(() => mutate.mock.calls[0][1].onSuccess());
    rows = [rows[0], { ...rows[1], source: "Work" }];
    view.rerender(<ClaudeAccounts host={host} />);
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(mutate.mock.calls[1][0]).toEqual({
      harness: "claude-native",
      kind: "claude-oauth-select",
      account_name: "Backup",
    });
    expect(screen.getByRole("button", { name: "Default CLI account (selected)" })).toBeDisabled();
  });
  it("cancels a rename without sending a mutation", () => {
    render(<ClaudeAccounts host={host} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename Backup" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Account label for Backup" }), {
      target: { value: "Work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: "Account label for Backup" })).toBeNull();
    expect(screen.getByRole("button", { name: "Backup" })).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
  });
  it("keeps the editor open and shows a rename failure", () => {
    render(<ClaudeAccounts host={host} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename Backup" }));
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    act(() => mutate.mock.calls[0][1].onError(new Error("Could not save account name.")));
    expect(screen.getByRole("alert").textContent).toBe("Could not save account name.");
    expect(screen.getByRole("textbox", { name: "Account label for Backup" })).toBeTruthy();
  });
  it("marks shared accounts, selects them by id and offers no rename", () => {
    rows = [
      ...rows,
      { family: "claude-oauth", source: "Company Max", env_var: "shared:Team" },
      { family: "claude-oauth", source: "Team", env_var: "Team" },
    ];
    render(<ClaudeAccounts host={host} compact />);
    const markers = screen.getAllByTestId("ae-shared-account-marker");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toHaveTextContent("Shared");
    expect(markers[0].querySelector("svg")).toBeTruthy();
    const shared = screen.getByRole("button", { name: /Company Max/ });
    expect(shared).toContainElement(markers[0]);
    fireEvent.click(shared);
    expect(mutate.mock.calls[0][0]).toEqual({
      harness: "claude-native",
      kind: "claude-oauth-select",
      account_name: "shared:Team",
    });
  });
  it("disables account actions while a rename is pending", () => {
    const view = render(<ClaudeAccounts host={host} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename Backup" }));
    isPending = true;
    view.rerender(<ClaudeAccounts host={host} />);
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Account label for Backup" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rename Default CLI account" })).toBeDisabled();
  });

  describe("the Shared group", () => {
    const TEAM = {
      name: "Team",
      account: "shared:Team",
      label: "Company Max",
      created_by: "admin@example.com",
      created_at: "not a date",
    };
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    /** Answers the list read; a POST answers `post` and is recorded. */
    const serve = (post: () => Response = () => json(200, { account: TEAM })) => {
      fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve(
          init?.method === "POST"
            ? post()
            : json(200, { accounts: [TEAM], can_manage: isAdmin, key_configured: true }),
        ),
      );
    };
    const posts = () =>
      fetchMock.mock.calls
        .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
        .map(([input, init]) => [
          String(input).replace(/^.*(\/v1\/)/, "$1"),
          JSON.parse(String((init as RequestInit).body)),
        ]);
    const sharedRows = () => {
      rows = [
        ...rows,
        { family: "claude-oauth-active", source: "shared:Team", env_var: "shared:Team" },
      ];
    };

    it("lists the shared accounts for everyone and selects one by id", async () => {
      sharedRows();
      serve();
      render(<ClaudeAccounts host={host} />);
      const group = screen.getByTestId("ae-shared-claude-accounts");
      await within(group).findByText("shared:Team · Added by admin@example.com");
      expect(within(group).getByRole("button", { name: "Company Max (selected)" })).toBeDisabled();
      // The host's own list no longer repeats the shared account.
      expect(screen.getAllByRole("button", { name: /Company Max/ })).toHaveLength(1);
      expect(within(group).getByText(/Only an admin can add or change them/)).toBeTruthy();
      expect(within(group).queryByRole("button", { name: "Add shared account" })).toBeNull();
      expect(within(group).queryByRole("button", { name: /Rename|Remove/ })).toBeNull();
      expect(screen.getByRole("button", { name: "Rename Backup" })).toBeTruthy();
    });

    it("selects a shared account the host has not picked", async () => {
      serve();
      render(<ClaudeAccounts host={host} />);
      fireEvent.click(await screen.findByRole("button", { name: "Company Max" }));
      expect(mutate.mock.calls[0][0]).toEqual({
        harness: "claude-native",
        kind: "claude-oauth-select",
        account_name: "shared:Team",
      });
    });

    it("gives an admin + Add with the form closed until pressed, and Cancel closes it", async () => {
      isAdmin = true;
      serve();
      render(<ClaudeAccounts host={host} />);
      const group = screen.getByTestId("ae-shared-claude-accounts");
      await within(group).findByText("Company Max");
      expect(within(group).queryByLabelText("OAuth token")).toBeNull();
      fireEvent.click(within(group).getByRole("button", { name: "Add shared account" }));
      expect(within(group).getByLabelText("OAuth token")).toHaveAttribute("type", "password");
      expect(within(group).getByLabelText("Name")).toBeTruthy();
      expect(within(group).getByLabelText("Label (optional)")).toBeTruthy();
      fireEvent.click(within(group).getByRole("button", { name: "Cancel" }));
      expect(within(group).queryByLabelText("OAuth token")).toBeNull();
      expect(posts()).toEqual([]);
    });

    it("adds an account, clears the token at once and closes the form", async () => {
      isAdmin = true;
      serve();
      render(<ClaudeAccounts host={host} />);
      const group = screen.getByTestId("ae-shared-claude-accounts");
      fireEvent.click(await within(group).findByRole("button", { name: "Add shared account" }));
      fireEvent.change(within(group).getByLabelText("Name"), { target: { value: " Team " } });
      fireEvent.change(within(group).getByLabelText("Label (optional)"), {
        target: { value: "Company Max" },
      });
      fireEvent.change(within(group).getByLabelText("OAuth token"), {
        target: { value: "sk-ant-oat-example" },
      });
      fireEvent.click(within(group).getByRole("button", { name: "Add shared account" }));
      expect(within(group).getByLabelText("OAuth token")).toHaveValue("");
      await within(group).findByText("Added Company Max. It shows in every account picker now.");
      expect(posts()).toEqual([
        [
          "/v1/ae/claude-accounts/shared",
          { name: "Team", label: "Company Max", token: "sk-ant-oat-example" },
        ],
      ]);
      expect(within(group).queryByLabelText("OAuth token")).toBeNull();
      await waitFor(() => expect(refetch).toHaveBeenCalled());
      expect(invalidateAll).toHaveBeenCalled();
    });

    it("keeps the form open with the server's refusal and an empty token", async () => {
      isAdmin = true;
      serve(() => json(409, { error: { code: "exists", message: "Team already exists." } }));
      render(<ClaudeAccounts host={host} />);
      const group = screen.getByTestId("ae-shared-claude-accounts");
      fireEvent.click(await within(group).findByRole("button", { name: "Add shared account" }));
      fireEvent.change(within(group).getByLabelText("Name"), { target: { value: "Team" } });
      fireEvent.change(within(group).getByLabelText("OAuth token"), {
        target: { value: "sk-ant-oat-example" },
      });
      fireEvent.click(within(group).getByRole("button", { name: "Add shared account" }));
      expect(await within(group).findByRole("alert")).toHaveTextContent("Team already exists.");
      expect(within(group).getByLabelText("OAuth token")).toHaveValue("");
      expect(within(group).getByLabelText("Name")).toHaveValue("Team");
    });

    it("asks for a name and token before sending anything", async () => {
      isAdmin = true;
      serve();
      render(<ClaudeAccounts host={host} />);
      const group = screen.getByTestId("ae-shared-claude-accounts");
      fireEvent.click(await within(group).findByRole("button", { name: "Add shared account" }));
      fireEvent.change(within(group).getByLabelText("OAuth token"), {
        target: { value: "sk-ant-oat-example" },
      });
      fireEvent.click(within(group).getByRole("button", { name: "Add shared account" }));
      expect(within(group).getByRole("alert")).toHaveTextContent(
        "Enter a name and the OAuth token.",
      );
      expect(within(group).getByLabelText("OAuth token")).toHaveValue("");
      expect(posts()).toEqual([]);
    });

    it("moves focus into the form on open and back to + Add on Cancel", async () => {
      isAdmin = true;
      serve();
      render(<ClaudeAccounts host={host} />);
      const group = screen.getByTestId("ae-shared-claude-accounts");
      fireEvent.click(await within(group).findByRole("button", { name: "Add shared account" }));
      expect(within(group).getByLabelText("Name")).toHaveFocus();
      expect(within(group).getByLabelText("OAuth token")).toHaveAccessibleDescription(
        /never comes back/,
      );
      fireEvent.click(within(group).getByRole("button", { name: "Cancel" }));
      expect(within(group).getByRole("button", { name: "Add shared account" })).toHaveFocus();
    });

    it("keeps one status region mounted and puts a rename's outcome in it", async () => {
      isAdmin = true;
      serve();
      render(<ClaudeAccounts host={host} />);
      const group = screen.getByTestId("ae-shared-claude-accounts");
      const region = within(group).getByRole("status");
      fireEvent.click(await within(group).findByRole("button", { name: "Rename Company Max" }));
      expect(within(group).getByLabelText("New label for Company Max")).toHaveFocus();
      fireEvent.change(within(group).getByLabelText("New label for Company Max"), {
        target: { value: "Team Max" },
      });
      fireEvent.click(within(group).getByRole("button", { name: "Save name" }));
      await waitFor(() => expect(region).toHaveTextContent("Renamed to Team Max."));
    });

    it("renames through the label route", async () => {
      isAdmin = true;
      serve();
      render(<ClaudeAccounts host={host} />);
      const group = screen.getByTestId("ae-shared-claude-accounts");
      fireEvent.click(await within(group).findByRole("button", { name: "Rename Company Max" }));
      fireEvent.change(within(group).getByRole("textbox", { name: "New label for Company Max" }), {
        target: { value: " Max plan " },
      });
      fireEvent.click(within(group).getByRole("button", { name: "Save name" }));
      await within(group).findByText("Renamed to Max plan.");
      expect(posts()).toEqual([
        ["/v1/ae/claude-accounts/shared/Team/label", { label: "Max plan" }],
      ]);
    });

    it("removes only after the one confirm, through the delete route", async () => {
      isAdmin = true;
      serve();
      render(<ClaudeAccounts host={host} />);
      const group = screen.getByTestId("ae-shared-claude-accounts");
      fireEvent.click(await within(group).findByRole("button", { name: "Remove Company Max" }));
      expect(posts()).toEqual([]);
      fireEvent.click(within(group).getByRole("button", { name: "Remove for everyone" }));
      await within(group).findByText("Removed Company Max.");
      expect(posts()).toEqual([["/v1/ae/claude-accounts/shared/Team/delete", {}]]);
    });
  });
});
