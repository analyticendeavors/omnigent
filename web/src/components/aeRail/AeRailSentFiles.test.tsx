// Tests for the rail's Sent files section: thumbnails at the chat's image
// URL, file rows that open the stored file, the count, and the empty states.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyBlock, BlockContext, MessageContentBlock } from "@/lib/blocks";
import { useAeSessionRailStore } from "@/lib/aeSessionRail";
import { useChatStore } from "@/store/chatStore";
import { AeRailSentFiles, openSessionFile } from "./AeRailSentFiles";

const host = vi.hoisted(() => ({ fetcher: null as null | (() => void) }));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOmnigentHostConfig: () => ({ fetcher: host.fetcher }),
}));
const fetched = vi.hoisted(() => ({ body: "", type: "text/html" }));
vi.mock("@/lib/identity", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  authenticatedFetch: async () =>
    new Response(fetched.body, { status: 200, headers: { "content-type": fetched.type } }),
}));

function sent(content: MessageContentBlock[], createdAtS = 1_760_000_000): AnyBlock {
  const ctx: BlockContext = {
    agent: null,
    depth: 0,
    turn: 0,
    timestamp: 0,
    responseId: "r",
    itemId: null,
    createdAtS,
  };
  return { type: "user_message", ctx, content };
}

function show(blocks: AnyBlock[] | null, hasMoreHistory = false) {
  useChatStore.setState({
    conversationId: blocks ? "s1" : "elsewhere",
    blocks: blocks ?? [],
    hasMoreHistory,
  });
  return render(<AeRailSentFiles sessionId="s1" />);
}

let open: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  useAeSessionRailStore.setState({ open: true, folded: {} });
  open = vi.spyOn(window, "open").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  open.mockRestore();
});

describe("AeRailSentFiles", () => {
  it("shows images as thumbnails and other files as rows, with the count", () => {
    show([
      sent([
        { type: "input_text", text: "see these" },
        { type: "input_image", file_id: "f1", filename: "image.png" },
        { type: "input_image", file_id: "f2", filename: "image_695362896f3a.png" },
      ]),
      sent([{ type: "input_file", file_id: "f3", filename: "capacity-export.csv" }]),
    ]);
    const section = screen.getByRole("region", { name: "Sent files" });
    expect(within(section).getByText("3")).toBeInTheDocument();
    const thumbs = screen.getAllByTestId("ae-sent-thumb");
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]).toHaveAttribute("title", expect.stringMatching(/^image\.png · /));
    expect(within(thumbs[0]).getByRole("img", { name: "image.png" })).toHaveAttribute(
      "src",
      expect.stringContaining("/v1/sessions/s1/resources/files/f1/content"),
    );
    expect(within(thumbs[0]).getByText("image.png")).toBeInTheDocument();
    const row = screen.getByRole("button", { name: /capacity-export\.csv/ });
    fireEvent.click(row);
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining("/v1/sessions/s1/resources/files/f3/content"),
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("says a file still uploading cannot open yet", () => {
    show([sent([{ type: "input_file", file_id: "pending:a.csv", filename: "a.csv" }])]);
    fireEvent.click(screen.getByRole("button", { name: /a\.csv/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("a.csv has not finished uploading");
    expect(open).not.toHaveBeenCalled();
  });

  it("is empty when nothing was sent", () => {
    show([sent([{ type: "input_text", text: "hello" }])]);
    expect(screen.getByText("No files sent in this session yet.")).toBeInTheDocument();
  });

  it("hedges the empty line while older history is not loaded", () => {
    show([], true);
    expect(screen.getByText("No files in the messages loaded so far.")).toBeInTheDocument();
  });

  it("waits for the chat to show this session", () => {
    show(null);
    expect(screen.getByText("Files show once this session's messages load.")).toBeInTheDocument();
  });
});

describe("openSessionFile", () => {
  afterEach(() => {
    host.fetcher = null;
  });

  it("opens the server path in a new tab when the page is same origin", async () => {
    await openSessionFile("s1", "file_1", "notes.html");
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining("/v1/sessions/s1/resources/files/file_1/content"),
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("embedded, saves the bytes as a download instead of navigating to them", async () => {
    host.fetcher = () => {};
    fetched.body = "<script>alert(1)</script>";
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:ae-test";
    });
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await openSessionFile("s1", "file_1", "page.html");
    expect(open).not.toHaveBeenCalled();
    expect(blobs[0].type).toBe("application/octet-stream");
    const link = click.mock.contexts[0] as HTMLAnchorElement;
    expect(link.download).toBe("page.html");
    expect(link.isConnected).toBe(false);
    click.mockRestore();
  });
});
