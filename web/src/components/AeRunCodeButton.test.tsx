// Page test for Run-on-box: a Run on an assistant's bash block opens the
// session's shell and sends the exact bytes through the real TerminalView ->
// TerminalSession -> WebSocket path, the same path the keyboard uses. Only
// the WebSocket and ResizeObserver globals are fakes.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageResponse } from "@/components/ai-elements/message";
import { TerminalView } from "@/components/blocks/TerminalView";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { resetAeTerminalInputForTests, setAeRunTarget } from "@/lib/aeTerminalInput";
import type { TerminalInfo } from "@/lib/terminals";
import { pickRunShell, useAeRunInTerminal } from "@/shell/useAeRunInTerminal";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ showToast: toast }));

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: (string | Uint8Array)[] = [];
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    for (const fn of this.listeners.open ?? []) fn({});
  }
  message(data: string) {
    // A realm-local ArrayBuffer: TerminalSession checks `instanceof ArrayBuffer`.
    const encoded = new TextEncoder().encode(data);
    const buffer = new ArrayBuffer(encoded.length);
    new Uint8Array(buffer).set(encoded);
    for (const fn of this.listeners.message ?? []) fn({ data: buffer });
  }
  /** Everything sent as keystrokes (binary frames), decoded. */
  input(): string {
    const decoder = new TextDecoder();
    return this.sent
      .filter((m): m is Uint8Array => typeof m !== "string")
      .map((m) => decoder.decode(m))
      .join("");
  }
}

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

const SHELL: TerminalInfo = { id: "terminal_bash_u1", name: "bash", session: "u1", running: true };
const PWSH: TerminalInfo = { id: "terminal_pwsh_u2", name: "pwsh", session: "u2", running: true };
const ONE_SHELL = [SHELL];
const BASH_ONLY = ["bash"];
/** What a shell prints when it is ready: bracketed paste on, then its prompt. */
const PROMPT = "\x1b[?2004h$ ";

function assistantBlock(markdown: string, mode: "static" | "streaming" = "static"): ReactNode {
  return (
    <div data-testid="assistant-text-section">
      <MessageResponse mode={mode}>{markdown}</MessageResponse>
    </div>
  );
}

/** AppShell's part, reduced: the hook plus the rail tab it opens. */
function SessionPage({
  markdown,
  terminals = ONE_SHELL,
  declaredShells = BASH_ONLY,
  initiallyOpen = null,
}: {
  markdown: string;
  terminals?: TerminalInfo[];
  declaredShells?: string[];
  initiallyOpen?: string | null;
}) {
  const [openKey, setOpenKey] = useState<string | null>(initiallyOpen);
  useAeRunInTerminal("conv_run", {
    canRun: true,
    declaredShells,
    terminals,
    selectedTerminalKey: null,
    openTerminalTab: setOpenKey,
    openTerminalsPanel: setOpenKey,
  });
  return (
    <>
      {assistantBlock(markdown)}
      {openKey !== null && (
        <div data-testid="shell-tab" data-key={openKey}>
          <TerminalView sessionId="conv_run" terminalId={openKey.replace(/^terminal:/, "")} />
        </div>
      )}
    </>
  );
}

function renderPage(markdown: string, page: Partial<Parameters<typeof SessionPage>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionPage markdown={markdown} {...page} />
    </QueryClientProvider>,
  );
}

async function openAndConnect(): Promise<FakeWebSocket> {
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const socket = FakeWebSocket.instances.at(-1)!;
  act(() => socket.open());
  return socket;
}

beforeEach(() => {
  toast.mockReset();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  cleanup();
  resetAeTerminalInputForTests();
  vi.unstubAllGlobals();
});

describe("Run on a chat code block", () => {
  it("sends the exact bytes of a multi-line block as one bracketed paste, then Enter", async () => {
    renderPage("```bash\ncd /secure/omnigent\ndocker compose ps\n```");

    fireEvent.click(await screen.findByTestId("ae-run-button"));
    expect(screen.getByTestId("ae-run-text").textContent).toBe(
      "cd /secure/omnigent\ndocker compose ps",
    );
    fireEvent.click(screen.getByTestId("ae-run-confirm"));

    const socket = await openAndConnect();
    act(() => socket.message(PROMPT));
    await waitFor(() =>
      expect(socket.input()).toBe("\x1b[200~cd /secure/omnigent\rdocker compose ps\x1b[201~\r"),
    );
    expect(screen.getByTestId("shell-tab")).toBeTruthy();
  });

  it("holds the paste until the shell has drawn, not just until the socket opens", async () => {
    renderPage("```bash\necho one\necho two\n```");
    fireEvent.click(await screen.findByTestId("ae-run-button"));
    fireEvent.click(screen.getByTestId("ae-run-confirm"));
    const socket = await openAndConnect();
    // Nothing from the shell yet: xterm cannot know it wants bracketed paste,
    // so an early paste would run each line on its own.
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 600);
      });
    });
    expect(socket.input()).toBe("");
    act(() => socket.message(PROMPT));
    await waitFor(() => expect(socket.input()).toBe("\x1b[200~echo one\recho two\x1b[201~\r"));
  });

  it("sends nothing multi-line to a shell without bracketed paste, and says so", async () => {
    renderPage("```bash\nrm -rf build\ncat > notes <<EOF\nkey=1\n```");
    fireEvent.click(await screen.findByTestId("ae-run-button"));
    fireEvent.click(screen.getByTestId("ae-run-confirm"));
    const socket = await openAndConnect();
    act(() => socket.message("$ "));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/bracketed/)));
    expect(socket.input()).toBe("");
  });

  it("pastes an open heredoc without Enter and says why", async () => {
    renderPage("```bash\nsudo tee /etc/ae.conf <<EOF\nkey=1\n```");
    fireEvent.click(await screen.findByTestId("ae-run-button"));
    expect(screen.getByTestId("ae-run-hint").textContent).toMatch(/<<EOF/);
    expect(
      screen.getByTestId("ae-run-dangers").querySelector('[data-danger="sudo"]')?.textContent,
    ).toMatch(/password/);
    fireEvent.click(screen.getByTestId("ae-run-confirm"));
    const socket = await openAndConnect();
    act(() => socket.message(PROMPT));
    await waitFor(() =>
      expect(socket.input()).toBe("\x1b[200~sudo tee /etc/ae.conf <<EOF\rkey=1\x1b[201~"),
    );
  });

  it("moves the focus to the terminal after a Run, so a password can be typed", async () => {
    // The shell is already open and connected; the user is reading the chat.
    renderPage("```bash\nsudo apt update\n```", { initiallyOpen: "terminal:terminal_bash_u1" });
    const socket = await openAndConnect();
    act(() => socket.message(PROMPT));
    // A browser focuses a clicked button.
    const run = await screen.findByTestId("ae-run-button");
    run.focus();
    fireEvent.click(run);
    fireEvent.click(screen.getByTestId("ae-run-confirm"));
    await waitFor(() => expect(socket.input()).toBe("\x1b[200~sudo apt update\x1b[201~\r"));
    await waitFor(() => expect(screen.queryByTestId("ae-run-sheet")).toBeNull());
    await waitFor(() =>
      expect(screen.getByTestId("shell-tab").contains(document.activeElement)).toBe(true),
    );
  });

  it("sends once on a double tap", async () => {
    renderPage("```bash\nuptime\n```");
    fireEvent.click(await screen.findByTestId("ae-run-button"));
    const confirm = screen.getByTestId("ae-run-confirm");
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    const socket = await openAndConnect();
    act(() => socket.message(PROMPT));
    await waitFor(() => expect(socket.input()).toBe("\x1b[200~uptime\x1b[201~\r"));
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 600);
      });
    });
    expect(socket.input()).toBe("\x1b[200~uptime\x1b[201~\r");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("scrolls the sheet inside the screen on a phone", async () => {
    renderPage("```bash\nsudo rm -rf /tmp/x\n```");
    fireEvent.click(await screen.findByTestId("ae-run-button"));
    const sheet = screen.getByTestId("ae-run-sheet");
    expect(sheet.className).toMatch(/max-h-\[85vh\]/);
    expect(sheet.className).toMatch(/overflow-y-auto/);
  });

  it("runs a powershell block in the session's PowerShell shell, never in bash", async () => {
    renderPage("```powershell\nGet-Process\n```", {
      terminals: [SHELL, PWSH],
      declaredShells: ["bash", "pwsh"],
    });
    fireEvent.click(await screen.findByTestId("ae-run-button"));
    fireEvent.click(screen.getByTestId("ae-run-confirm"));
    const socket = await openAndConnect();
    expect(screen.getByTestId("shell-tab").dataset.key).toBe("terminal:terminal_pwsh_u2");
    act(() => socket.message(PROMPT));
    await waitFor(() => expect(socket.input()).toBe("\x1b[200~Get-Process\x1b[201~\r"));
  });

  it("sends nothing on Cancel", async () => {
    renderPage("```sh\nrm -rf /tmp/scratch\n```");
    fireEvent.click(await screen.findByTestId("ae-run-button"));
    expect(
      screen.getByTestId("ae-run-dangers").querySelector('[data-danger="rm-rf"]'),
    ).not.toBeNull();
    fireEvent.click(screen.getByTestId("ae-run-cancel"));
    await waitFor(() => expect(screen.queryByTestId("ae-run-sheet")).toBeNull());
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(screen.queryByTestId("shell-tab")).toBeNull();
  });

  it("keeps upstream's copy button beside Run", async () => {
    renderPage("```zsh\nls\n```");
    await screen.findByTestId("ae-run-button");
    expect(screen.getByRole("button", { name: "Copy Code" })).toBeTruthy();
  });
});

describe("where Run shows", () => {
  const target = { conversationId: "conv_run", shells: new Set(["posix" as const]), run: vi.fn() };

  it("shows on shell fences and command-like untagged blocks in assistant text", async () => {
    setAeRunTarget(target);
    render(assistantBlock("```console\n$ uptime\n```\n\n```\ngit status\n```"));
    await waitFor(() => expect(screen.getAllByTestId("ae-run-button")).toHaveLength(2));
  });

  it("hides on other languages and on prose-like untagged blocks", async () => {
    setAeRunTarget(target);
    render(assistantBlock("```python\nprint(1)\n```\n\n```\nsee the notes below\n```"));
    await screen.findAllByRole("button", { name: "Copy Code" });
    expect(screen.queryByTestId("ae-run-button")).toBeNull();
  });

  it("hides without a run target (no shells, a non-owner, a shared view)", async () => {
    render(assistantBlock("```bash\nls\n```"));
    await screen.findByRole("button", { name: "Copy Code" });
    expect(screen.queryByTestId("ae-run-button")).toBeNull();
  });

  it("hides on a powershell block when the session has no PowerShell shell", async () => {
    renderPage("```powershell\nGet-Process\n```\n\n```bash\nls\n```");
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Copy Code" })).toHaveLength(2),
    );
    expect(screen.getAllByTestId("ae-run-button")).toHaveLength(1);
  });

  it("hides while the message is still streaming (the block may be a partial command)", async () => {
    setAeRunTarget(target);
    render(assistantBlock("```bash\nrm -rf ./bu", "streaming"));
    await screen.findByRole("button", { name: "Copy Code" });
    expect(screen.queryByTestId("ae-run-button")).toBeNull();
  });

  it("hides in a user message and in a side chat", async () => {
    setAeRunTarget(target);
    render(
      <>
        <MessageResponse mode="static">{"```bash\nls\n```"}</MessageResponse>
        <ConversationScopeContext.Provider value="conv_side">
          {assistantBlock("```bash\nls\n```")}
        </ConversationScopeContext.Provider>
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Copy Code" })).toHaveLength(2),
    );
    expect(screen.queryByTestId("ae-run-button")).toBeNull();
  });
});

describe("pickRunShell", () => {
  const other: TerminalInfo = { id: "terminal_zsh_u2", name: "zsh", session: "u2", running: true };
  const agent: TerminalInfo = {
    id: "terminal_claude_main",
    name: "claude",
    session: "main",
    running: true,
  };

  it("prefers the selected live shell, then the newest, never the agent pane", () => {
    expect(pickRunShell([SHELL, other], "terminal:terminal_bash_u1")).toBe(SHELL);
    expect(pickRunShell([SHELL, other], null)).toBe(other);
    expect(pickRunShell([SHELL, { ...other, running: false }], null)).toBe(SHELL);
    expect(pickRunShell([agent], null)).toBeNull();
  });
});
