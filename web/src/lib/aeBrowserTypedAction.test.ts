import { describe, expect, it, vi } from "vitest";
import {
  aeIsBlankCapture,
  aeTypedActionParams,
  aeTypedBrowserAction,
} from "./aeBrowserTypedAction";

describe("aeTypedActionParams", () => {
  it("sends no params for a snapshot", () => {
    expect(aeTypedActionParams("snapshot", { ref: 1, stray: true })).toEqual({});
  });

  it("keeps a numeric ref with its snapshot_id and drops the selector", () => {
    expect(aeTypedActionParams("click", { ref: 5, snapshot_id: "s", selector: "a" })).toEqual({
      ref: 5,
      snapshot_id: "s",
    });
  });

  it("drops a snapshot_id that comes without a ref", () => {
    expect(aeTypedActionParams("click", { snapshot_id: "s", selector: "a" })).toEqual({
      selector: "a",
    });
  });

  it("treats a non-number ref as absent", () => {
    expect(aeTypedActionParams("click", { ref: "5", selector: "a" })).toEqual({ selector: "a" });
    expect(aeTypedActionParams("click", { ref: null, selector: null })).toEqual({});
  });

  it("drops a non-string snapshot_id or selector", () => {
    expect(aeTypedActionParams("click", { ref: 5, snapshot_id: 7 })).toEqual({ ref: 5 });
    expect(aeTypedActionParams("click", { selector: 3 })).toEqual({});
  });

  it("always sends text for type, defaulting to an empty string", () => {
    expect(aeTypedActionParams("type", { ref: 1 })).toEqual({ ref: 1, text: "" });
    expect(aeTypedActionParams("type", { selector: "i", text: 42 })).toEqual({
      selector: "i",
      text: "42",
    });
  });

  it("never sends text for click", () => {
    expect(aeTypedActionParams("click", { ref: 1, text: "x" })).toEqual({ ref: 1 });
  });
});

describe("aeTypedBrowserAction", () => {
  it("returns undefined when the shell has no typed bridge", () => {
    expect(aeTypedBrowserAction({}, "c", "snapshot", {})).toBeUndefined();
  });

  it("calls the typed bridge with the filtered params", async () => {
    const browserPerformAction = vi.fn().mockResolvedValue({ ok: true, result: "ok" });
    await aeTypedBrowserAction({ browserPerformAction }, "c", "type", { ref: 1, selector: "x" });
    expect(browserPerformAction).toHaveBeenCalledWith("c", "type", { ref: 1, text: "" });
  });
});

describe("aeIsBlankCapture", () => {
  it("flags a data URL with no payload", () => {
    expect(aeIsBlankCapture("data:image/png;base64,")).toBe(true);
    expect(aeIsBlankCapture("data:image/png;base64,  ")).toBe(true);
    expect(aeIsBlankCapture("not a data url")).toBe(true);
  });

  it("passes a data URL that carries an image", () => {
    expect(aeIsBlankCapture("data:image/png;base64,iVBORw0KGgo=")).toBe(false);
  });
});
