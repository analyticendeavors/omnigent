// Open and Download on a file a chat reply names, as inline code and as a link.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileViewerContext } from "@/shell/FileViewerContext";
import { FilePathAwareMessageResponse } from "./ChatMarkdown";

vi.mock("@/components/ui/toast", () => ({ showToast: vi.fn() }));
vi.mock("@/hooks/useFileContent", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  downloadWorkspaceFile: vi.fn(),
}));
import { showToast } from "@/components/ui/toast";
import { downloadWorkspaceFile } from "@/hooks/useFileContent";

const downloadMock = vi.mocked(downloadWorkspaceFile);
const toastMock = vi.mocked(showToast);
const openFile = vi.fn();
const fetchMock = vi.fn();

const WORKSPACE = "/home/u/ws";
const VIEWER = {
  openFile,
  openGithubTab: () => {},
  isChangedPath: (p: string) => p === "clip.mp4",
  conversationId: "conv_1" as string | undefined,
  workspaceRoot: WORKSPACE as string | null,
  workspaceHome: "/home/u",
};

function setCoarse(coarse: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: coarse && query.includes("coarse"),
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

function renderMarkdown(markdown: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <FileViewerContext.Provider value={VIEWER}>
        <FilePathAwareMessageResponse>{markdown}</FilePathAwareMessageResponse>
      </FileViewerContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  openFile.mockClear();
  downloadMock.mockReset();
  downloadMock.mockResolvedValue(undefined);
  toastMock.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) });
  vi.stubGlobal("fetch", fetchMock);
  setCoarse(false);
});

afterEach(cleanup);

const FORMS = [
  ["inline code", `Saved \`${WORKSPACE}/clip.mp4\`.`, `${WORKSPACE}/clip.mp4`],
  ["markdown link", `[the clip](${WORKSPACE}/clip.mp4)`, "the clip"],
] as const;

describe.each(FORMS)("%s to a workspace file", (_label, markdown, name) => {
  it("offers Open and Download on right-click", () => {
    renderMarkdown(markdown);
    fireEvent.contextMenu(screen.getByRole("button", { name }));
    expect(screen.getByRole("menuitem", { name: "Open" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Download" })).toBeTruthy();
  });

  it("downloads the resolved path for this conversation", () => {
    renderMarkdown(markdown);
    fireEvent.contextMenu(screen.getByRole("button", { name }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Download" }));
    expect(downloadMock).toHaveBeenCalledWith("conv_1", "clip.mp4");
    expect(openFile).not.toHaveBeenCalled();
  });

  it("opens the file from the menu", () => {
    renderMarkdown(markdown);
    fireEvent.contextMenu(screen.getByRole("button", { name }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(openFile).toHaveBeenCalledWith("clip.mp4");
  });

  it("shows the download icon only on a coarse pointer", () => {
    renderMarkdown(markdown);
    expect(screen.queryByLabelText("Download clip.mp4")).toBeNull();
    cleanup();
    setCoarse(true);
    renderMarkdown(markdown);
    fireEvent.click(screen.getByLabelText("Download clip.mp4"));
    expect(downloadMock).toHaveBeenCalledWith("conv_1", "clip.mp4");
    expect(openFile).not.toHaveBeenCalled();
  });

  it("keeps the link name and puts the touch icon beside it, not inside", () => {
    setCoarse(true);
    renderMarkdown(markdown);
    const link = screen.getByRole("button", { name });
    const icon = screen.getByLabelText("Download clip.mp4");
    expect(link.contains(icon)).toBe(false);
  });

  it("adds the right-click hint on a fine pointer only", () => {
    renderMarkdown(markdown);
    expect(screen.getByRole("button", { name }).getAttribute("title")).toContain("right-click");
    cleanup();
    setCoarse(true);
    renderMarkdown(markdown);
    expect(screen.getByRole("button", { name }).getAttribute("title")).not.toContain("right-click");
  });

  it("toasts when the native-shell blob download rejects", async () => {
    downloadMock.mockRejectedValue(new Error("502 Bad Gateway"));
    renderMarkdown(markdown);
    fireEvent.contextMenu(screen.getByRole("button", { name }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Download" }));
    await vi.waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(toastMock.mock.calls[0][0]).toContain("Download failed: 502 Bad Gateway");
  });
});

describe("a dead link", () => {
  it("has no menu", () => {
    renderMarkdown("[gone](/home/u/ws/../../etc/passwd)");
    const dead = screen.getByText("gone");
    const notPrevented = fireEvent.contextMenu(dead);
    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});
