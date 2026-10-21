import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AE_SUGGESTION_KEYS_STORAGE_KEY, writeAeSuggestionKey } from "@/lib/aeSuggestionKeys";
import { ChatComposer } from "./ChatComposer";

function renderComposer(suggestion: string | readonly string[] | null, initial = "") {
  // One list for the whole render, as the store holds it.
  const suggestions = typeof suggestion === "string" ? [suggestion] : suggestion;
  const onKeyDown = vi.fn();
  const onSubmit = vi.fn();
  function Editor() {
    const [value, setValue] = useState(initial);
    return (
      <form onSubmit={onSubmit}>
        <ChatComposer
          keyboard={{ submitWithModEnter: false, preventsKeyboardSubmit: false }}
          aeSuggestion={suggestions}
          input={{
            "aria-label": "Draft",
            placeholder: "Send a message…",
            value,
            onChange: (event) => setValue(event.target.value),
            onKeyDown,
          }}
          actions={{ leading: null, trailing: null }}
        />
      </form>
    );
  }
  render(<Editor />);
  return {
    input: screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement,
    onKeyDown,
    onSubmit,
  };
}

function mockWidth(narrow: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: narrow && query.includes("max-width: 639"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  writeAeSuggestionKey("next", null);
  writeAeSuggestionKey("previous", null);
});

describe("ChatComposer prompt suggestion", () => {
  it("shows the ghost text and the Tab chip over an empty box, hiding the placeholder", () => {
    const { input } = renderComposer("Open a draft PR");
    expect(screen.getByTestId("ae-suggestion-text")).toHaveTextContent("Open a draft PR");
    expect(screen.getByTestId("ae-suggestion-hint")).toHaveTextContent("Tab to use");
    expect(input).toHaveAttribute("placeholder", "");
  });

  it("is not drawn without a suggestion or once the box has text", () => {
    renderComposer(null);
    expect(screen.queryByTestId("ae-suggestion")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Draft" })).toHaveAttribute(
      "placeholder",
      "Send a message…",
    );
  });

  it("hides as soon as the user types", () => {
    const { input } = renderComposer("Open a draft PR");
    fireEvent.change(input, { target: { value: "h" } });
    expect(screen.queryByTestId("ae-suggestion")).toBeNull();
  });

  it("Tab fills the suggestion into the box and never sends it", () => {
    const { input, onKeyDown, onSubmit } = renderComposer("Open a draft PR");
    const tab = fireEvent.keyDown(input, { key: "Tab" });
    expect(tab).toBe(false); // default prevented: focus stays in the box
    expect(input).toHaveValue("Open a draft PR");
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByTestId("ae-suggestion")).toBeNull();
  });

  it("leaves Tab alone when no suggestion shows", () => {
    const { input, onKeyDown } = renderComposer(null);
    const tab = fireEvent.keyDown(input, { key: "Tab" });
    expect(tab).toBe(true);
    expect(input).toHaveValue("");
    expect(onKeyDown).toHaveBeenCalledWith(
      expect.objectContaining({ key: "Tab" }),
      expect.anything(),
    );
  });

  it("leaves Tab alone while the box has text", () => {
    const typed = renderComposer("Open a draft PR", "draft @fi");
    fireEvent.keyDown(typed.input, { key: "Tab" });
    expect(typed.input).toHaveValue("draft @fi");
    expect(typed.onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("a tap on the grey text does not fill the box; it lets the tap through", () => {
    const { input } = renderComposer("Run the tests again");
    const text = screen.getByTestId("ae-suggestion-text");
    expect(text.tagName).toBe("SPAN");
    expect(text.closest("[data-testid=ae-suggestion]")).toHaveClass("pointer-events-none");
    expect(text).not.toHaveClass("pointer-events-auto");
    fireEvent.click(text);
    expect(input).toHaveValue("");
  });

  it("the chip fills the box too", () => {
    const { input } = renderComposer("Run the tests again");
    fireEvent.click(screen.getByTestId("ae-suggestion-hint"));
    expect(input).toHaveValue("Run the tests again");
  });

  it("ignores Tab mid-composition", () => {
    const { input } = renderComposer("Open a draft PR");
    fireEvent.keyDown(input, { key: "Tab", isComposing: true });
    expect(input).toHaveValue("");
  });

  it("Esc hides the suggestion until the next one, and Tab then behaves as usual", () => {
    const onKeyDown = vi.fn();
    function Editor() {
      const [value, setValue] = useState("");
      const [suggestion, setSuggestion] = useState<string[] | null>(["Open a draft PR"]);
      return (
        <>
          <button type="button" onClick={() => setSuggestion(null)}>
            turn starts
          </button>
          <button type="button" onClick={() => setSuggestion(["Open a draft PR"])}>
            turn ends
          </button>
          <ChatComposer
            keyboard={{ submitWithModEnter: false, preventsKeyboardSubmit: false }}
            aeSuggestion={suggestion}
            input={{
              "aria-label": "Draft",
              value,
              onChange: (event) => setValue(event.target.value),
              onKeyDown,
            }}
            actions={{ leading: null, trailing: null }}
          />
        </>
      );
    }
    render(<Editor />);
    const input = screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("ae-suggestion")).toBeNull();
    expect(onKeyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input).toHaveValue("");
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    // The next turn clears the old suggestion, then brings one back (same text or not).
    fireEvent.click(screen.getByText("turn starts"));
    fireEvent.click(screen.getByText("turn ends"));
    expect(screen.getByTestId("ae-suggestion-text")).toHaveTextContent("Open a draft PR");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input).toHaveValue("Open a draft PR");
  });

  it("shows no counter for a single guess, and Alt+] then types as usual", () => {
    const { input, onKeyDown } = renderComposer("Open a draft PR");
    expect(screen.queryByTestId("ae-suggestion-next")).toBeNull();
    expect(fireEvent.keyDown(input, { key: "]", code: "BracketRight", altKey: true })).toBe(true);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("Alt+] and Alt+[ step through the guesses, wrapping, and Tab takes the one shown", () => {
    const { input, onKeyDown } = renderComposer(["Open a PR", "Run the tests", "Ship it"]);
    const text = () => screen.getByTestId("ae-suggestion-text");
    const counter = () => screen.getByTestId("ae-suggestion-next");
    expect(text()).toHaveTextContent("Open a PR");
    expect(counter()).toHaveTextContent("1/3");
    // On a Mac, Option+] reports "‘" as the key; the physical key is what counts.
    expect(fireEvent.keyDown(input, { key: "‘", code: "BracketRight", altKey: true })).toBe(false);
    expect(text()).toHaveTextContent("Run the tests");
    expect(counter()).toHaveTextContent("2/3");
    fireEvent.keyDown(input, { key: "[", code: "BracketLeft", altKey: true });
    fireEvent.keyDown(input, { key: "[", code: "BracketLeft", altKey: true });
    expect(text()).toHaveTextContent("Ship it");
    expect(onKeyDown).not.toHaveBeenCalled();
    // The step is the composer's alone: a window hotkey on the same keys never sees it.
    const appHotkey = vi.fn();
    window.addEventListener("keydown", appHotkey);
    fireEvent.keyDown(input, { key: "]", code: "BracketRight", altKey: true });
    window.removeEventListener("keydown", appHotkey);
    expect(appHotkey).not.toHaveBeenCalled();
    expect(text()).toHaveTextContent("Open a PR");
    fireEvent.keyDown(input, { key: "[", code: "BracketLeft", altKey: true });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input).toHaveValue("Ship it");
  });

  it("a tap on the counter shows the next guess without filling the box", () => {
    const { input } = renderComposer(["Open a PR", "Run the tests"]);
    fireEvent.click(screen.getByTestId("ae-suggestion-next"));
    expect(screen.getByTestId("ae-suggestion-text")).toHaveTextContent("Run the tests");
    expect(screen.getByTestId("ae-suggestion-next")).toHaveTextContent("2/2");
    expect(input).toHaveValue("");
    fireEvent.click(screen.getByTestId("ae-suggestion-hint"));
    expect(input).toHaveValue("Run the tests");
  });

  it("uses the keys saved in Settings instead of the defaults", () => {
    writeAeSuggestionKey("next", {
      code: "KeyJ",
      alt: false,
      ctrl: true,
      meta: false,
      shift: false,
    });
    expect(window.localStorage.getItem(AE_SUGGESTION_KEYS_STORAGE_KEY)).toContain("KeyJ");
    const { input, onKeyDown } = renderComposer(["Open a PR", "Run the tests"]);
    fireEvent.keyDown(input, { key: "]", code: "BracketRight", altKey: true });
    expect(screen.getByTestId("ae-suggestion-text")).toHaveTextContent("Open a PR");
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "j", code: "KeyJ", ctrlKey: true });
    expect(screen.getByTestId("ae-suggestion-text")).toHaveTextContent("Run the tests");
  });

  it("wraps a long guess instead of cutting it off", () => {
    renderComposer("word ".repeat(24).trim());
    const text = screen.getByTestId("ae-suggestion-text");
    expect(text).not.toHaveClass("truncate");
    expect(text).toHaveClass("whitespace-normal");
  });

  it("says Tap to use below 640 px wide", () => {
    mockWidth(true);
    renderComposer("Open a draft PR");
    expect(screen.getByTestId("ae-suggestion-hint")).toHaveTextContent("Tap to use");
  });

  it("says Tab to use at 640 px and wider", () => {
    mockWidth(false);
    renderComposer("Open a draft PR");
    expect(screen.getByTestId("ae-suggestion-hint")).toHaveTextContent("Tab to use");
  });
});
