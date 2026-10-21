import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AE_SUGGESTION_KEYS_STORAGE_KEY,
  readAeSuggestionKeys,
  writeAeSuggestionKey,
} from "@/lib/aeSuggestionKeys";
import { AeSuggestionKeysSetting } from "./AeSuggestionKeysSetting";

afterEach(() => {
  writeAeSuggestionKey("next", null);
  writeAeSuggestionKey("previous", null);
});

const caps = (action: string) =>
  Array.from(screen.getByTestId(`ae-suggestion-key-${action}`).querySelectorAll("kbd")).map(
    (k) => k.textContent,
  );

describe("AeSuggestionKeysSetting", () => {
  it("shows Alt+] and Alt+[ by default, with no Reset", () => {
    render(<AeSuggestionKeysSetting />);
    expect(caps("next")).toEqual(["Alt", "]"]);
    expect(caps("previous")).toEqual(["Alt", "["]);
    expect(screen.queryByTestId("ae-suggestion-key-next-reset")).toBeNull();
  });

  it("records the next combo pressed after Change, saves it, and Reset puts the default back", () => {
    render(<AeSuggestionKeysSetting />);
    const change = screen.getByTestId("ae-suggestion-key-next-change");
    fireEvent.click(change);
    expect(change).toHaveTextContent("Cancel");
    // A modifier alone is still waiting for its key.
    fireEvent.keyDown(change, { key: "Control", code: "ControlLeft", ctrlKey: true });
    expect(change).toHaveTextContent("Cancel");
    fireEvent.keyDown(change, { key: "j", code: "KeyJ", ctrlKey: true });
    expect(caps("next")).toEqual(["Ctrl", "J"]);
    expect(readAeSuggestionKeys().next).toMatchObject({ code: "KeyJ", ctrl: true, alt: false });
    expect(window.localStorage.getItem(AE_SUGGESTION_KEYS_STORAGE_KEY)).toContain("KeyJ");

    fireEvent.click(screen.getByTestId("ae-suggestion-key-next-reset"));
    expect(caps("next")).toEqual(["Alt", "]"]);
    expect(window.localStorage.getItem(AE_SUGGESTION_KEYS_STORAGE_KEY)).toBeNull();
  });

  it("refuses a bare key, the other action's combo and an app hotkey, and keeps listening", () => {
    render(<AeSuggestionKeysSetting />);
    const change = screen.getByTestId("ae-suggestion-key-next-change");
    fireEvent.click(change);
    fireEvent.keyDown(change, { key: "j", code: "KeyJ" });
    expect(screen.getByRole("alert")).toHaveTextContent("would type into the box");
    fireEvent.keyDown(change, { key: "[", code: "BracketLeft", altKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent("previous suggestion");
    fireEvent.keyDown(change, { key: "]", code: "BracketRight", ctrlKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent("switch sessions");
    expect(change).toHaveTextContent("Cancel");
    expect(readAeSuggestionKeys().next).toMatchObject({ code: "BracketRight", alt: true });
  });

  it("blocks Ctrl+Alt+V (voice dictation) on save, and the press reaches no app hotkey", () => {
    const appHotkey = vi.fn();
    window.addEventListener("keydown", appHotkey);
    render(<AeSuggestionKeysSetting />);
    const change = screen.getByTestId("ae-suggestion-key-next-change");
    fireEvent.click(change);
    fireEvent.keyDown(document.body, { key: "v", code: "KeyV", ctrlKey: true, altKey: true });
    window.removeEventListener("keydown", appHotkey);
    expect(screen.getByRole("alert")).toHaveTextContent("Already used");
    expect(appHotkey).not.toHaveBeenCalled();
    expect(readAeSuggestionKeys().next).toMatchObject({ code: "BracketRight", alt: true });
  });

  it("hears the combo with focus elsewhere (Safari leaves a clicked button unfocused)", () => {
    render(<AeSuggestionKeysSetting />);
    fireEvent.click(screen.getByTestId("ae-suggestion-key-next-change"));
    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ", ctrlKey: true });
    expect(caps("next")).toEqual(["Ctrl", "J"]);
  });

  it("a click elsewhere cancels", () => {
    render(<AeSuggestionKeysSetting />);
    const change = screen.getByTestId("ae-suggestion-key-next-change");
    fireEvent.click(change);
    fireEvent.pointerDown(document.body);
    expect(change).toHaveTextContent("Change");
  });

  it("Esc cancels without saving", () => {
    render(<AeSuggestionKeysSetting />);
    const change = screen.getByTestId("ae-suggestion-key-previous-change");
    fireEvent.click(change);
    fireEvent.keyDown(change, { key: "Escape", code: "Escape" });
    expect(change).toHaveTextContent("Change");
    expect(caps("previous")).toEqual(["Alt", "["]);
  });
});
