import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AE_SETTING_HINTS } from "@/lib/aeSettingHints";
import { useChatStore } from "@/store/chatStore";
import { installFakeSpeech, makeVoice, removeFakeSpeech } from "@/test/fakeSpeech";
import { AeSpeakRepliesButton } from "./AeSpeakRepliesButton";

const setEffort = vi.fn(() => Promise.resolve());
const originalSetEffort = useChatStore.getState().setEffort;

function renderButton(props: Partial<React.ComponentProps<typeof AeSpeakRepliesButton>> = {}) {
  return render(<AeSpeakRepliesButton chatId="c1" canSetEffort currentEffort="high" {...props} />);
}

async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("ae-speak-replies"));
  return user;
}

beforeEach(() => {
  window.localStorage.clear();
  setEffort.mockClear();
  useChatStore.setState({ conversationId: "c1", blocks: [], status: "idle", setEffort } as never);
  const synth = installFakeSpeech();
  synth.voices = [
    makeVoice({ name: "Plain", lang: "en-US", default: true }),
    makeVoice({
      name: "Microsoft Aria Online (Natural) - English",
      lang: "en-US",
      voiceURI: "aria",
    }),
  ];
  Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
});

afterEach(() => {
  removeFakeSpeech();
  useChatStore.setState({ setEffort: originalSetEffort } as never);
});

describe("AeSpeakRepliesButton", () => {
  it("renders nothing without the speech api", () => {
    removeFakeSpeech();
    const { container } = renderButton();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing without a chat id", () => {
    const { container } = renderButton({ chatId: null });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the trigger, off by default", () => {
    renderButton();
    const trigger = screen.getByTestId("ae-speak-replies");
    expect(trigger).toHaveAttribute("aria-pressed", "false");
    expect(trigger).toHaveAttribute("title", "Speak replies: off");
  });

  it("shows all four hints in the menu", async () => {
    renderButton();
    await openMenu();
    for (const id of ["voice.speak", "voice.fast", "voice.voice", "voice.rate"] as const) {
      expect(AE_SETTING_HINTS[id].hint).not.toBe("");
      expect(screen.getByText(AE_SETTING_HINTS[id].hint)).toBeInTheDocument();
    }
  });

  it("turns on, lowers the effort and remembers the old one, then restores it", async () => {
    renderButton();
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-speak-toggle"));
    expect(window.localStorage.getItem("omnigent:ae-speak-replies:c1")).toBe("true");
    expect(setEffort).toHaveBeenLastCalledWith("low");
    expect(JSON.parse(window.localStorage.getItem("omnigent:ae-speak-fast:c1") ?? "null")).toEqual({
      previousEffort: "high",
    });
    expect(screen.getByTestId("ae-speak-replies")).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByTestId("ae-speak-toggle"));
    expect(setEffort).toHaveBeenLastCalledWith("high");
    expect(window.localStorage.getItem("omnigent:ae-speak-replies:c1")).toBeNull();
    expect(window.localStorage.getItem("omnigent:ae-speak-fast:c1")).toBeNull();
  });

  it("leaves the effort alone when Fast answers is off", async () => {
    window.localStorage.setItem("omnigent:ae-speak-fast-enabled", "false");
    renderButton();
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-speak-toggle"));
    expect(setEffort).not.toHaveBeenCalled();
  });

  it("hides Fast answers when the effort cannot be set", async () => {
    renderButton({ canSetEffort: false });
    const user = await openMenu();
    expect(screen.queryByTestId("ae-speak-fast")).toBeNull();
    await user.click(screen.getByTestId("ae-speak-toggle"));
    expect(setEffort).not.toHaveBeenCalled();
  });

  it("lists a Natural voice first and stores the pick", async () => {
    renderButton();
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-speak-voice-trigger"));
    const options = await screen.findAllByTestId("ae-speak-voice-option");
    expect(options[0]).toHaveTextContent("Aria (Natural)");
    expect(options[0]).toHaveTextContent("best here");
    options[0].focus();
    await user.keyboard("{Enter}");
    expect(window.localStorage.getItem("omnigent:ae-speak-voice")).toBe("aria");
  });

  it("stores the faster speed", async () => {
    renderButton();
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-speak-rate-faster"));
    expect(window.localStorage.getItem("omnigent:ae-speak-rate")).toBe("1.25");
  });

  it("disables Stop speaking while idle", async () => {
    renderButton();
    await openMenu();
    expect(screen.getByTestId("ae-speak-stop")).toHaveAttribute("data-disabled");
  });
});
