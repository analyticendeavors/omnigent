import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AeSwitchFamilyDialog } from "./AeSwitchFamilyDialog";
import { askAeSwitchFamily, dismissAeSwitchFamily } from "@/lib/aeSwitchFamily";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ showToast: vi.fn() }));
import { showToast } from "@/components/ui/toast";
import { authenticatedFetch } from "@/lib/identity";

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  vi.mocked(authenticatedFetch).mockReset();
  vi.mocked(showToast).mockReset();
});
afterEach(() => act(() => dismissAeSwitchFamily()));

let queryClient: QueryClient;

function ask(childCount = 3) {
  queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <AeSwitchFamilyDialog />
    </QueryClientProvider>,
  );
  act(() =>
    askAeSwitchFamily({ sessionId: "s1", account: "shared:Backup", label: "Backup", childCount }),
  );
}

describe("AeSwitchFamilyDialog", () => {
  it("asks with the child count and the login, Parent and children first and focused", async () => {
    ask();
    expect(await screen.findByText("Switch the child chats too?")).toBeTruthy();
    expect(
      screen.getByText(/This chat has 3 child chats\. Each moved chat restarts on Backup/),
    ).toBeTruthy();
    expect(screen.getByText(/skipped and listed so you can retry it/)).toBeTruthy();
    const both = screen.getByTestId("ae-switch-family-both");
    const parent = screen.getByTestId("ae-switch-family-parent");
    expect(both.textContent).toBe("Parent and children");
    expect(parent.textContent).toBe("Parent only");
    // DOM order is the tab order: the primary action comes first.
    expect(both.compareDocumentPosition(parent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(both));
    expect(both.getAttribute("title")).toBe("Restart this chat and its 3 child chats on Backup");
    expect(parent.getAttribute("title")).toBe(
      "Only this chat moves; its children finish on the login they have",
    );
  });

  it("says child chat for one", async () => {
    ask(1);
    expect(await screen.findByText(/This chat has 1 child chat\. Each/)).toBeTruthy();
  });

  it("Parent and children sends include_children and keeps a skip on screen", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({
        account: "shared:Backup",
        relaunched: true,
        children: {
          moved: [{ id: "c1", title: "Builder" }],
          skipped: [{ id: "c2", title: "Reviewer", reason: "mid-reply" }],
          pending: [],
        },
      }),
    );
    ask();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.click(await screen.findByTestId("ae-switch-family-both"));
    await waitFor(() =>
      expect(authenticatedFetch).toHaveBeenCalledWith(
        "/v1/ae/sessions/s1/claude-account",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ account: "shared:Backup", include_children: true }),
        }),
      ),
    );
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "This chat now runs on Backup; 1 child chat moved; 1 skipped: Reviewer is mid-reply",
        { duration: 0 },
      ),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["session", "c1"] });
    await waitFor(() => expect(screen.queryByTestId("ae-switch-family-dialog")).toBeNull());
  });

  it("keeps a failed cascade on screen with the not-switched line", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({
        account: "shared:Backup",
        relaunched: true,
        children: { moved: [], skipped: [], pending: [], error: "children not attempted" },
      }),
    );
    ask();
    fireEvent.click(await screen.findByTestId("ae-switch-family-both"));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "This chat now runs on Backup; its child chats were not switched",
        { duration: 0 },
      ),
    );
  });

  it("keeps the login and count in the text after the question is dismissed", async () => {
    ask(2);
    expect(
      await screen.findByText(/This chat has 2 child chats\. Each moved chat restarts on Backup/),
    ).toBeTruthy();
    act(() => dismissAeSwitchFamily());
    expect(screen.queryByText(/This chat has 0 child chats/)).toBeNull();
    expect(screen.queryByText(/restarts on undefined/)).toBeNull();
  });

  it("a clean family toast uses the default duration", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({
        account: "shared:Backup",
        relaunched: true,
        children: { moved: [{ id: "c1", title: "Builder" }], skipped: [], pending: [] },
      }),
    );
    ask();
    fireEvent.click(await screen.findByTestId("ae-switch-family-both"));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "This chat now runs on Backup; 1 child chat moved",
        undefined,
      ),
    );
  });

  it("Parent only sends the plain body, with no include_children", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({ account: "shared:Backup", relaunched: true }),
    );
    ask();
    fireEvent.click(await screen.findByTestId("ae-switch-family-parent"));
    await waitFor(() =>
      expect(authenticatedFetch).toHaveBeenCalledWith(
        "/v1/ae/sessions/s1/claude-account",
        expect.objectContaining({ body: JSON.stringify({ account: "shared:Backup" }) }),
      ),
    );
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("This chat now runs on Backup.", undefined),
    );
  });

  it("shows the server's refusal as a toast", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({ error: { message: "Claude is mid-reply or waiting on an approval." } }, 409),
    );
    ask();
    fireEvent.click(await screen.findByTestId("ae-switch-family-both"));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Claude is mid-reply or waiting on an approval."),
    );
  });
});
