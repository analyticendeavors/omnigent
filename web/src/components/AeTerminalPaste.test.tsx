// The terminal's touch Paste control: shown on a coarse pointer only, a
// clipboard read writes through the session's `aeWrite` without Enter, and a
// refused read falls back to a sheet whose Send writes the typed text.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AeTerminalPaste, type AeTerminalPasteSink } from "./AeTerminalPaste";

const originalMatchMedia = window.matchMedia;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function setPointer(coarse: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function setClipboard(readText: (() => Promise<string>) | undefined): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: readText ? { readText } : undefined,
  });
}

function fakeSink() {
  const sink = {
    aeWrite: vi.fn<(text: string, submit: boolean) => void>(),
    focus: vi.fn<() => void>(),
  };
  return sink satisfies AeTerminalPasteSink;
}

beforeEach(() => {
  setPointer(true);
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else setClipboard(undefined);
});

describe("AeTerminalPaste", () => {
  it("is hidden on a fine pointer", () => {
    setPointer(false);
    render(<AeTerminalPaste getSink={() => fakeSink()} />);
    expect(screen.queryByTestId("ae-terminal-paste")).toBeNull();
  });

  it("is shown on a coarse pointer", () => {
    render(<AeTerminalPaste getSink={() => fakeSink()} />);
    expect(screen.getByRole("button", { name: "Paste into terminal" })).toBeTruthy();
  });

  it("writes the clipboard through aeWrite without Enter and refocuses", async () => {
    const sink = fakeSink();
    setClipboard(() => Promise.resolve("echo hi"));
    render(<AeTerminalPaste getSink={() => sink} />);
    fireEvent.click(screen.getByTestId("ae-terminal-paste"));
    await waitFor(() => expect(sink.aeWrite).toHaveBeenCalledWith("echo hi", false));
    expect(sink.aeWrite).toHaveBeenCalledTimes(1);
    expect(sink.focus).toHaveBeenCalled();
    expect(screen.queryByTestId("ae-terminal-paste-sheet")).toBeNull();
  });

  it("opens the sheet when the clipboard read is refused", async () => {
    const sink = fakeSink();
    setClipboard(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    render(<AeTerminalPaste getSink={() => sink} />);
    fireEvent.click(screen.getByTestId("ae-terminal-paste"));
    expect(await screen.findByTestId("ae-terminal-paste-sheet")).toBeTruthy();
    expect(sink.aeWrite).not.toHaveBeenCalled();
  });

  it("opens the sheet when the Clipboard API is missing", async () => {
    setClipboard(undefined);
    render(<AeTerminalPaste getSink={() => fakeSink()} />);
    fireEvent.click(screen.getByTestId("ae-terminal-paste"));
    expect(await screen.findByTestId("ae-terminal-paste-sheet")).toBeTruthy();
  });

  it("sends the textarea's text through aeWrite without Enter", async () => {
    const sink = fakeSink();
    setClipboard(() => Promise.reject(new Error("no")));
    render(<AeTerminalPaste getSink={() => sink} />);
    fireEvent.click(screen.getByTestId("ae-terminal-paste"));
    const box = await screen.findByTestId("ae-terminal-paste-text");
    fireEvent.change(box, { target: { value: "ls -la\npwd" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ae-terminal-paste-send"));
    });
    expect(sink.aeWrite).toHaveBeenCalledWith("ls -la\npwd", false);
    expect(sink.aeWrite).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId("ae-terminal-paste-sheet")).toBeNull());
  });

  it("writes nothing on Cancel", async () => {
    const sink = fakeSink();
    setClipboard(() => Promise.reject(new Error("no")));
    render(<AeTerminalPaste getSink={() => sink} />);
    fireEvent.click(screen.getByTestId("ae-terminal-paste"));
    const box = await screen.findByTestId("ae-terminal-paste-text");
    fireEvent.change(box, { target: { value: "rm -rf build" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ae-terminal-paste-cancel"));
    });
    await waitFor(() => expect(screen.queryByTestId("ae-terminal-paste-sheet")).toBeNull());
    expect(sink.aeWrite).not.toHaveBeenCalled();
  });

  it("keeps Send disabled while the box is empty", async () => {
    setClipboard(() => Promise.resolve(""));
    render(<AeTerminalPaste getSink={() => fakeSink()} />);
    fireEvent.click(screen.getByTestId("ae-terminal-paste"));
    const send = await screen.findByTestId("ae-terminal-paste-send");
    expect((send as HTMLButtonElement).disabled).toBe(true);
  });
});
