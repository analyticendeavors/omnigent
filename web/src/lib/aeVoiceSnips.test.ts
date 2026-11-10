import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  countImageFiles,
  imageFilesFromClipboard,
  isComposerPasteTarget,
  isSnipFile,
  readSendSnips,
  resetSnipsStore,
  SNIPS_KEY,
  subscribeSendSnips,
  writeSendSnips,
} from "./aeVoiceSnips";

const png = new File(["x"], "a.png", { type: "image/png" });
const pdf = new File(["x"], "a.pdf", { type: "application/pdf" });

beforeEach(() => {
  window.localStorage.clear();
  resetSnipsStore();
});

describe("send snips switch", () => {
  it("is off by default, writes and reads the saved key", () => {
    expect(readSendSnips()).toBe(false);
    writeSendSnips(true);
    expect(window.localStorage.getItem(SNIPS_KEY)).toBe("true");
    expect(readSendSnips()).toBe(true);
    writeSendSnips(false);
    expect(window.localStorage.getItem(SNIPS_KEY)).toBeNull();
    expect(readSendSnips()).toBe(false);
  });

  it("notifies subscribers on write and reset, and stops after unsubscribe", () => {
    const cb = vi.fn();
    const off = subscribeSendSnips(cb);
    writeSendSnips(true);
    resetSnipsStore();
    expect(cb).toHaveBeenCalledTimes(2);
    expect(readSendSnips()).toBe(false);
    off();
    writeSendSnips(true);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe("picture helpers", () => {
  it("counts only images", () => {
    expect(isSnipFile(png)).toBe(true);
    expect(isSnipFile(pdf)).toBe(false);
    expect(countImageFiles([png, pdf, png])).toBe(2);
  });

  it("takes only image file items from the clipboard", () => {
    const data = {
      items: [
        { kind: "file", type: "image/png", getAsFile: () => png },
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "application/pdf", getAsFile: () => pdf },
      ],
      files: [],
    } as unknown as DataTransfer;
    expect(imageFilesFromClipboard(data)).toEqual([png]);
    expect(imageFilesFromClipboard(null)).toEqual([]);
  });

  it("falls back to the files list", () => {
    const data = { items: [], files: [png, pdf] } as unknown as DataTransfer;
    expect(imageFilesFromClipboard(data)).toEqual([png]);
  });

  it("knows the composer's own paste targets", () => {
    const div = document.createElement("div");
    Object.defineProperty(div, "isContentEditable", { value: true });
    expect(isComposerPasteTarget(document.createElement("textarea"))).toBe(true);
    expect(isComposerPasteTarget(document.createElement("input"))).toBe(true);
    expect(isComposerPasteTarget(div)).toBe(true);
    expect(isComposerPasteTarget(document.body)).toBe(false);
    expect(isComposerPasteTarget(null)).toBe(false);
  });
});
