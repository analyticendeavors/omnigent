// Tests for the Sent files section's pure part: the attachments on loaded
// user messages, their keys and their times.

import { describe, expect, it } from "vitest";
import type { AnyBlock, BlockContext, MessageContentBlock } from "@/lib/blocks";
import { formatSentAt, sentFilesOf, sessionFileContentPath } from "./aeRailSentFiles";

function sent(content: MessageContentBlock[], createdAtS?: number): AnyBlock {
  const ctx: BlockContext = {
    agent: null,
    depth: 0,
    turn: 0,
    timestamp: 0,
    responseId: "r",
    itemId: null,
    ...(createdAtS ? { createdAtS } : {}),
  };
  return { type: "user_message", ctx, content };
}

describe("sentFilesOf", () => {
  it("lists images and files from user messages in order", () => {
    const files = sentFilesOf([
      sent(
        [
          { type: "input_text", text: "look" },
          { type: "input_image", file_id: "f1", filename: "image.png" },
          { type: "input_file", file_id: "f2", filename: "capacity-export.csv" },
        ],
        1000,
      ),
      { type: "text_done", ctx: sent([]).ctx, fullText: "ok", hasCodeBlocks: false },
      sent([{ type: "input_image", image_url: "data:image/png;base64,AAAA" }]),
    ]);
    expect(files.map((f) => [f.kind, f.name, f.sentAtS])).toEqual([
      ["image", "image.png", 1000],
      ["file", "capacity-export.csv", 1000],
      ["image", "Attached image", null],
    ]);
    expect(files[0]).toMatchObject({ preview: { kind: "uploaded", fileId: "f1" } });
    expect(files[1]).toMatchObject({ fileId: "f2" });
    expect(files[2]).toMatchObject({ preview: { kind: "inline" } });
  });

  it("keeps a file sent twice as two rows with distinct keys", () => {
    const part: MessageContentBlock = { type: "input_file", file_id: "f2", filename: "a.csv" };
    const files = sentFilesOf([sent([part]), sent([part])]);
    expect(files).toHaveLength(2);
    expect(new Set(files.map((f) => f.key)).size).toBe(2);
  });

  it("leaves a file still uploading without an id to open", () => {
    const [file] = sentFilesOf([
      sent([{ type: "input_file", file_id: "pending:a.csv", filename: "a.csv" }]),
    ]);
    expect(file).toMatchObject({ kind: "file", fileId: null, name: "a.csv" });
  });

  it("is empty when nothing was sent", () => {
    expect(sentFilesOf([sent([{ type: "input_text", text: "hi" }])])).toEqual([]);
  });
});

describe("helpers", () => {
  it("builds the chat's content path", () => {
    expect(sessionFileContentPath("s 1", "f/1")).toBe(
      "/v1/sessions/s%201/resources/files/f%2F1/content",
    );
  });

  it("shows a time today and a date before", () => {
    const now = new Date(2026, 9, 17, 12, 0);
    const today = new Date(2026, 9, 17, 6, 46);
    const time = today.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    expect(formatSentAt(today.getTime() / 1000, now)).toBe(time);
    expect(formatSentAt(new Date(2026, 9, 14, 6, 46).getTime() / 1000, now)).toContain("Oct 14");
    expect(formatSentAt(null, now)).toBe("");
  });
});
