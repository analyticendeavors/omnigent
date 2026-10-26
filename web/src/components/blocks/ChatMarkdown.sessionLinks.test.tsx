// A chat link to another session routes in-app through the router: no new
// window, no file-open toast, on web and in a native shell alike.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type * as NativeBridge from "@/lib/nativeBridge";
import { FileViewerContext } from "@/shell/FileViewerContext";
import { FilePathAwareMessageResponse } from "./ChatMarkdown";

let native = false;
vi.mock("@/lib/nativeBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof NativeBridge>()),
  isNativeShell: () => native,
}));
const toast = vi.fn();
vi.mock("@/components/ui/toast", () => ({ showToast: (m: string) => toast(m) }));

const ID = "e96ed7580fd0415090a5407cbff87612";
const FILE_VIEWER = {
  openFile: vi.fn(),
  openGithubTab: () => {},
  isChangedPath: () => false,
  conversationId: "conv-1",
  workspaceRoot: "/ws",
  workspaceHome: "/home",
};

afterEach(() => {
  cleanup();
  native = false;
  delete window.__OMNIGENT_BASE_PATH__;
  vi.restoreAllMocks();
  toast.mockClear();
});

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function HistoryLength() {
  const location = useLocation();
  const type = useNavigationType();
  return <div data-testid="hist">{`${location.pathname}|${type}`}</div>;
}

function click(markdown: string, init: MouseEventInit = {}): MouseEvent {
  render(
    <MemoryRouter initialEntries={["/c/other"]}>
      <QueryClientProvider client={new QueryClient()}>
        <FileViewerContext.Provider value={FILE_VIEWER}>
          <FilePathAwareMessageResponse>{markdown}</FilePathAwareMessageResponse>
        </FileViewerContext.Provider>
      </QueryClientProvider>
      <Where />
    </MemoryRouter>,
  );
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  act(() => {
    screen.getByText("docs").dispatchEvent(event);
  });
  return event;
}

it.each([
  ["relative", `[docs](/c/${ID})`],
  ["ts.net", `[docs](https://box.tail1234.ts.net:8010/c/${ID})`],
  ["go-ae.org", `[docs](https://omnigent.go-ae.org/c/${ID})`],
])("switches sessions in-app for a %s link, on web and native", (_n, md) => {
  for (const isNative of [false, true]) {
    native = isNative;
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const event = click(md);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByTestId("where").textContent).toBe(`/c/${ID}`);
    expect(open).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    cleanup();
  }
});

it.each([
  ["meta", { metaKey: true }],
  ["ctrl", { ctrlKey: true }],
  ["shift", { shiftKey: true }],
  ["alt", { altKey: true }],
  ["middle button", { button: 1 }],
])("keeps a %s click native, on web and native", (_n, init) => {
  for (const isNative of [false, true]) {
    native = isNative;
    const event = click(`[docs](/c/${ID})`, init);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByTestId("where").textContent).toBe("/c/other");
    cleanup();
  }
});

it("keeps the anchor attributes of the incoming link", () => {
  click(`[docs](https://omnigent.go-ae.org/c/${ID})`);
  const link = screen.getByText("docs").closest("a");
  expect(link?.getAttribute("target")).toBe("_blank");
  expect(link?.getAttribute("rel")).toContain("noreferrer");
  expect(link?.hasAttribute("data-ae-session-link")).toBe(true);
});

it.each([
  `[docs](/c/${ID}#L12)`,
  `[docs](/c/${ID}/)`,
  `<https://omnigent.go-ae.org/c/${ID}>`,
  `https://omnigent.go-ae.org/c/${ID}`,
])("routes %s without the file toast", (md) => {
  const text = md.startsWith("[") ? "docs" : md.replace(/^<|>$/g, "");
  render(
    <MemoryRouter initialEntries={["/c/other"]}>
      <QueryClientProvider client={new QueryClient()}>
        <FileViewerContext.Provider value={FILE_VIEWER}>
          <FilePathAwareMessageResponse>{md}</FilePathAwareMessageResponse>
        </FileViewerContext.Provider>
      </QueryClientProvider>
      <Where />
    </MemoryRouter>,
  );
  act(() => {
    screen
      .getByText(text)
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  expect(screen.getByTestId("where").textContent).toBe(`/c/${ID}`);
  expect(toast).not.toHaveBeenCalled();
});

it("does not push a duplicate history entry for the open session", () => {
  render(
    <MemoryRouter initialEntries={["/c/other", `/c/${ID}`]} initialIndex={1}>
      <QueryClientProvider client={new QueryClient()}>
        <FileViewerContext.Provider value={FILE_VIEWER}>
          <FilePathAwareMessageResponse>{`[docs](/c/${ID})`}</FilePathAwareMessageResponse>
        </FileViewerContext.Provider>
      </QueryClientProvider>
      <HistoryLength />
    </MemoryRouter>,
  );
  const link = screen.getByText("docs");
  for (let i = 0; i < 3; i++) {
    act(() => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
  }
  expect(screen.getByTestId("hist").textContent).toBe(`/c/${ID}|POP`);
});

it("routes a link under the deployment base path in-app", () => {
  window.__OMNIGENT_BASE_PATH__ = "/omnigent";
  try {
    const event = click(`[docs](${window.location.origin}/omnigent/c/${ID})`);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByTestId("where").textContent).toBe(`/c/${ID}`);
  } finally {
    delete window.__OMNIGENT_BASE_PATH__;
  }
});

// A protocol-relative `//evil.com/c/<id>` is rewritten to the bare path `/c/<id>` by
// Streamdown's harden pass before it reaches the anchor; sessionLinkRoute itself
// rejects it (see aeSessionLinks.test.ts).
it.each([
  `https://evil-ts.net.example.com/c/${ID}`,
  `https://ts.net.evil.com/c/${ID}`,
  `https://omnigent.go-ae.org@evil.com/c/${ID}`,
  `http://relative.invalid/c/${ID}`,
])("never routes %s in-app", (url) => {
  vi.spyOn(window, "open").mockReturnValue(null);
  click(`[docs](${url})`);
  expect(screen.getByTestId("where").textContent).toBe("/c/other");
});

it("still opens another host externally", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const event = click(`[docs](https://example.com/c/${ID})`);
  expect(event.defaultPrevented).toBe(true);
  expect(open).toHaveBeenCalled();
  expect(screen.getByTestId("where").textContent).toBe("/c/other");
});
