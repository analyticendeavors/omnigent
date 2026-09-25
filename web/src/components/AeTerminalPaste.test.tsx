// The terminal's touch Paste control: shown on a coarse pointer only; a
// clipboard read pastes through the Run guards without Enter; every paste
// that does not go through lands in a sheet that keeps the text and says why.
// The last block mounts the real TerminalView to show the control outlives a
// dropped socket.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalView } from "@/components/blocks/TerminalView";
import type { AeTerminalSink } from "@/lib/aeTerminalInput";
import { AE_PASTE_MESSAGES, AeTerminalPaste, aeTrimPasteText } from "./AeTerminalPaste";

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

function fakeSink(options: { state?: "open" | "connecting" | "gone"; bracketed?: boolean } = {}) {
  const sink = {
    state: options.state ?? "open",
    bracketed: options.bracketed ?? true,
    aeWrite: vi.fn<(text: string, submit: boolean) => void>(),
    focus: vi.fn<() => void>(),
    aeInputState: () => sink.state,
    aeBracketedPaste: () => sink.bracketed,
    aeOnOutput: () => ({ dispose: () => {} }),
  };
  return sink satisfies AeTerminalSink;
}

/** A clipboard whose read resolves when the returned function is called. */
function pendingClipboard(): (text: string) => void {
  let resolveRead: (text: string) => void = () => {};
  setClipboard(
    () =>
      new Promise<string>((resolve) => {
        resolveRead = resolve;
      }),
  );
  return (text) => resolveRead(text);
}

function renderPaste(getSink: () => AeTerminalSink | null, connected = true) {
  return render(<AeTerminalPaste getSink={getSink} connected={connected} />);
}

function tap() {
  fireEvent.click(screen.getByTestId("ae-terminal-paste"));
}

async function sheetReason(): Promise<string | null> {
  const message = await screen.findByTestId("ae-terminal-paste-message");
  return message.getAttribute("data-reason");
}

function draftText(): string {
  return (screen.getByTestId("ae-terminal-paste-text") as HTMLTextAreaElement).value;
}

beforeEach(() => {
  setPointer(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.matchMedia = originalMatchMedia;
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else setClipboard(undefined);
});

describe("AeTerminalPaste", () => {
  it("is hidden on a fine pointer", () => {
    setPointer(false);
    renderPaste(() => fakeSink());
    expect(screen.queryByTestId("ae-terminal-paste")).toBeNull();
  });

  it("is shown on a coarse pointer and disabled while not connected", () => {
    const { rerender } = renderPaste(() => fakeSink());
    const button = screen.getByRole("button", { name: "Paste into terminal" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    rerender(<AeTerminalPaste getSink={() => fakeSink()} connected={false} />);
    expect(button.disabled).toBe(true);
  });

  it("writes the clipboard through aeWrite without Enter and refocuses", async () => {
    const sink = fakeSink();
    setClipboard(() => Promise.resolve("echo hi"));
    renderPaste(() => sink);
    tap();
    await waitFor(() => expect(sink.aeWrite).toHaveBeenCalledWith("echo hi", false));
    expect(sink.aeWrite).toHaveBeenCalledTimes(1);
    expect(sink.focus).toHaveBeenCalled();
    expect(screen.queryByTestId("ae-terminal-paste-sheet")).toBeNull();
  });

  it("drops exactly one trailing newline", async () => {
    expect(aeTrimPasteText("ls\r\n")).toBe("ls");
    expect(aeTrimPasteText("ls\n\n")).toBe("ls\n");
    const sink = fakeSink({ bracketed: false });
    setClipboard(() => Promise.resolve("git status\n"));
    renderPaste(() => sink);
    tap();
    await waitFor(() => expect(sink.aeWrite).toHaveBeenCalledWith("git status", false));
  });

  it("pastes multi-line text when the shell brackets pastes", async () => {
    const sink = fakeSink({ bracketed: true });
    setClipboard(() => Promise.resolve("cd /tmp\nls\n"));
    renderPaste(() => sink);
    tap();
    await waitFor(() => expect(sink.aeWrite).toHaveBeenCalledWith("cd /tmp\nls", false));
  });

  it("refuses multi-line text without bracketed paste and keeps it in the sheet", async () => {
    const sink = fakeSink({ bracketed: false });
    setClipboard(() => Promise.resolve("cd /tmp\nrm -rf build"));
    renderPaste(() => sink);
    tap();
    expect(await sheetReason()).toBe("multiline");
    expect(screen.getByTestId("ae-terminal-paste-message").textContent).toContain(
      AE_PASTE_MESSAGES.multiline,
    );
    expect(draftText()).toBe("cd /tmp\nrm -rf build");
    expect(sink.aeWrite).not.toHaveBeenCalled();
  });

  it("opens the sheet when the clipboard read is refused", async () => {
    const sink = fakeSink();
    setClipboard(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    renderPaste(() => sink);
    tap();
    expect(await sheetReason()).toBe("unreadable");
    expect(sink.aeWrite).not.toHaveBeenCalled();
  });

  it("opens the sheet when the Clipboard API is missing", async () => {
    setClipboard(undefined);
    renderPaste(() => fakeSink());
    tap();
    expect(await sheetReason()).toBe("unreadable");
  });

  it("says the clipboard is empty when it is", async () => {
    setClipboard(() => Promise.resolve("\n"));
    renderPaste(() => fakeSink());
    tap();
    expect(await sheetReason()).toBe("empty");
    expect(screen.getByTestId("ae-terminal-paste-message").textContent).toContain(
      "Clipboard is empty.",
    );
    const send = screen.getByTestId("ae-terminal-paste-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it("keeps the text and writes nothing when the terminal reconnected during the read", async () => {
    const first = fakeSink();
    const second = fakeSink({ state: "connecting" });
    let current: AeTerminalSink = first;
    const resolveRead = pendingClipboard();
    renderPaste(() => current);
    tap();
    first.state = "gone";
    current = second;
    await act(async () => resolveRead("make deploy"));
    expect(await sheetReason()).toBe("reconnected");
    expect(draftText()).toBe("make deploy");
    expect(first.aeWrite).not.toHaveBeenCalled();
    expect(second.aeWrite).not.toHaveBeenCalled();
  });

  it("keeps the text and says not ready when the socket closed during the read", async () => {
    const sink = fakeSink();
    const resolveRead = pendingClipboard();
    renderPaste(() => sink);
    tap();
    sink.state = "gone";
    await act(async () => resolveRead("make deploy"));
    expect(await sheetReason()).toBe("not-ready");
    expect(draftText()).toBe("make deploy");
    expect(sink.aeWrite).not.toHaveBeenCalled();
  });

  it("drops a read that resolves after unmount", async () => {
    const sink = fakeSink();
    const resolveRead = pendingClipboard();
    const { unmount } = renderPaste(() => sink);
    tap();
    unmount();
    await act(async () => resolveRead("echo late"));
    expect(sink.aeWrite).not.toHaveBeenCalled();
  });

  it("sends the textarea's text through aeWrite without Enter and closes", async () => {
    const sink = fakeSink();
    setClipboard(() => Promise.reject(new Error("no")));
    renderPaste(() => sink);
    tap();
    const box = await screen.findByTestId("ae-terminal-paste-text");
    fireEvent.change(box, { target: { value: "ls -la\npwd\n" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ae-terminal-paste-send"));
    });
    expect(sink.aeWrite).toHaveBeenCalledWith("ls -la\npwd", false);
    expect(sink.aeWrite).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId("ae-terminal-paste-sheet")).toBeNull());
  });

  it("keeps the sheet and the draft when Send cannot write", async () => {
    const sink = fakeSink({ bracketed: false });
    setClipboard(() => Promise.reject(new Error("no")));
    renderPaste(() => sink);
    tap();
    const box = await screen.findByTestId("ae-terminal-paste-text");
    fireEvent.change(box, { target: { value: "a\nb" } });
    fireEvent.click(screen.getByTestId("ae-terminal-paste-send"));
    expect(await sheetReason()).toBe("multiline");
    expect(draftText()).toBe("a\nb");
    sink.state = "connecting";
    fireEvent.change(box, { target: { value: "ab" } });
    fireEvent.click(screen.getByTestId("ae-terminal-paste-send"));
    expect(await sheetReason()).toBe("not-ready");
    expect(draftText()).toBe("ab");
    expect(sink.aeWrite).not.toHaveBeenCalled();
  });

  it("writes nothing on Cancel", async () => {
    const sink = fakeSink();
    setClipboard(() => Promise.reject(new Error("no")));
    renderPaste(() => sink);
    tap();
    const box = await screen.findByTestId("ae-terminal-paste-text");
    fireEvent.change(box, { target: { value: "rm -rf build" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ae-terminal-paste-cancel"));
    });
    await waitFor(() => expect(screen.queryByTestId("ae-terminal-paste-sheet")).toBeNull());
    expect(sink.aeWrite).not.toHaveBeenCalled();
  });
});

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send() {}
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    for (const fn of this.listeners.open ?? []) fn({});
  }
  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    for (const fn of this.listeners.close ?? []) fn({ code: 1006, reason: "" });
  }
}

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

describe("AeTerminalPaste in TerminalView", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });

  it("stays mounted with its sheet and draft through a dropped socket", async () => {
    setClipboard(() => Promise.reject(new Error("no")));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TerminalView sessionId="conv_paste" terminalId="terminal_bash_p1" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const socket = FakeWebSocket.instances.at(-1)!;
    act(() => socket.open());
    const button = (await screen.findByTestId("ae-terminal-paste")) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    tap();
    const box = await screen.findByTestId("ae-terminal-paste-text");
    fireEvent.change(box, { target: { value: "npm test" } });

    act(() => socket.drop());
    expect(screen.getByTestId("ae-terminal-paste")).toBe(button);
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId("ae-terminal-paste-sheet")).toBeTruthy();
    expect(draftText()).toBe("npm test");

    fireEvent.click(screen.getByTestId("ae-terminal-paste-send"));
    expect(await sheetReason()).toBe("not-ready");
    expect(draftText()).toBe("npm test");
  });
});
