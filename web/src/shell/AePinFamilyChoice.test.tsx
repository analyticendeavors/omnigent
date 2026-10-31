// The pin-family dialog (omnigent-ae, 2026-10-31): shows what was asked, each
// button answers, Escape cancels, and a new question replaces an open one.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { answerPinFamily, askPinFamily } from "@/lib/aePinFamilyChoice";
import { AePinFamilyChoiceHost } from "./AePinFamilyChoice";

describe("AePinFamilyChoiceHost", () => {
  it("renders nothing until asked", async () => {
    render(<AePinFamilyChoiceHost />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("asks about a pin and resolves with the button pressed", async () => {
    render(<AePinFamilyChoiceHost />);
    let answer: Promise<string> = Promise.resolve("");
    act(() => {
      answer = askPinFamily({ action: "pin", title: "Lead chat" });
    });
    expect(
      await screen.findByRole("dialog", {
        name: "Pin only the parent, or the parent and its whole family?",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Lead chat/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Pin the whole family" }));
    await expect(answer).resolves.toBe("family");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("words the unpin question and answers the parent button", async () => {
    render(<AePinFamilyChoiceHost />);
    let answer: Promise<string> = Promise.resolve("");
    act(() => {
      answer = askPinFamily({ action: "unpin", title: null });
    });
    expect(
      await screen.findByRole("dialog", { name: "Unpin only the parent, or the whole family?" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Unpin only the parent" }));
    await expect(answer).resolves.toBe("parent");
  });

  it("cancels on the Cancel button and on Escape", async () => {
    render(<AePinFamilyChoiceHost />);
    let first: Promise<string> = Promise.resolve("");
    act(() => {
      first = askPinFamily({ action: "pin", title: "x" });
    });
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await expect(first).resolves.toBe("cancel");

    let second: Promise<string> = Promise.resolve("");
    act(() => {
      second = askPinFamily({ action: "pin", title: "x" });
    });
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await expect(second).resolves.toBe("cancel");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("cancels an open question when a newer one is asked", async () => {
    let first: Promise<string> = Promise.resolve("");
    act(() => {
      first = askPinFamily({ action: "pin", title: "a" });
    });
    act(() => {
      void askPinFamily({ action: "unpin", title: "b" });
    });
    await expect(first).resolves.toBe("cancel");
    act(() => answerPinFamily("cancel"));
  });

  it("cancels on a click outside the dialog", async () => {
    render(<AePinFamilyChoiceHost />);
    let answer: Promise<string> = Promise.resolve("");
    act(() => {
      answer = askPinFamily({ action: "pin", title: "x" });
    });
    await screen.findByRole("dialog");
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    await expect(answer).resolves.toBe("cancel");
  });

  it("disables the family button and says why when the family does not fit", async () => {
    render(<AePinFamilyChoiceHost />);
    let answer: Promise<string> = Promise.resolve("");
    act(() => {
      answer = askPinFamily({
        action: "pin",
        title: "x",
        familyBlocked: "Needs 3 pin spots, 2 free",
      });
    });
    expect(await screen.findByText("Needs 3 pin spots, 2 free")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pin the whole family" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Pin only the parent" }));
    await expect(answer).resolves.toBe("parent");
  });
});
