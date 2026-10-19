// The bulk-select bar in a narrow sidebar (omnigent-ae, 2026-10-19): the pill
// is a container-query container, the "N selected" label stays one text node
// that screen readers always hear, and a hidden-from-readers bare count takes
// its place where the label does not fit. jsdom has no container queries, so
// the layout itself is checked by screenshot; this locks the structure.

import { renderSidebar } from "@/test/sidebarTestHelpers";
import { conversation, conversationPage } from "@/test/sidebarMockHelpers";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useScopeCache", () => import("@/test/mockScopeCache"));
vi.mock("@/hooks/useConversations", async () => {
  const { conversationHooksMock } = await import("@/test/sidebarMockHelpers");
  return conversationHooksMock();
});
vi.mock("@/components/PermissionsModal", () => ({ PermissionsModal: () => null }));

import { useConversations } from "@/hooks/useConversations";

beforeEach(() => {
  vi.mocked(useConversations).mockImplementation(() =>
    conversationPage([conversation("conv_1", { title: "My Session" })]),
  );
});

afterEach(cleanup);

describe("bulk-select bar in a narrow sidebar", () => {
  it("keeps the label for screen readers and shows a bare count where it does not fit", () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Select sessions" }));
    fireEvent.click(screen.getByRole("link", { name: /My Session/ }));

    const label = screen.getByText("1 selected");
    expect(label).toHaveClass("sr-only", "@[13rem]/bulk:not-sr-only");
    const pill = label.parentElement as HTMLElement;
    expect(pill).toHaveClass("@container/bulk");
    expect(pill.className).not.toMatch(/\b(hidden|absolute)\b/);

    const count = screen.getByTestId("ae-bulk-count");
    expect(count).toHaveTextContent(/^1$/);
    expect(count).toHaveAttribute("aria-hidden", "true");
    expect(count).toHaveClass("@[13rem]/bulk:hidden");
    expect(pill).toContainElement(count);
    // The count sits between the label and the actions.
    expect(label.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      count.compareDocumentPosition(screen.getByTestId("bulk-delete")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("leaves with the selection", () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Select sessions" }));
    expect(screen.getByTestId("ae-bulk-count")).toHaveTextContent(/^0$/);
    fireEvent.click(screen.getByRole("button", { name: "Exit selection mode" }));
    expect(screen.queryByTestId("ae-bulk-count")).toBeNull();
  });
});
