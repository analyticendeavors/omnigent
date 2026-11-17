import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCloudVoicesCache } from "@/lib/aeCloudVoice";
import { resetVoiceLog } from "@/lib/aeVoiceLog";
import { installFakeSpeech, makeVoice, removeFakeSpeech } from "@/test/fakeSpeech";
import { AeVoiceStartButton } from "./AeVoiceStartButton";

function serveFetch() {
  resetCloudVoicesCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ voices: [] }), { status: 200 }))),
  );
}

async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("ae-voice-start-menu"));
  return user;
}

beforeEach(() => {
  window.localStorage.clear();
  resetVoiceLog();
  serveFetch();
  installFakeSpeech().voices = [makeVoice({ name: "Plain", lang: "en-US", default: true })];
});
afterEach(() => {
  vi.unstubAllGlobals();
  removeFakeSpeech();
});

describe("AeVoiceStartButton", () => {
  it("renders the button and reports a tap", async () => {
    const onToggle = vi.fn();
    render(<AeVoiceStartButton armed={false} onToggle={onToggle} />);
    const btn = screen.getByTestId("ae-voice-start");
    expect(btn.getAttribute("aria-label")).toBe("Voice mode");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("is pressed while armed", () => {
    render(<AeVoiceStartButton armed onToggle={() => {}} />);
    expect(screen.getByTestId("ae-voice-start").getAttribute("aria-pressed")).toBe("true");
  });

  it("renders nothing when speech is unsupported", () => {
    removeFakeSpeech();
    render(<AeVoiceStartButton armed={false} onToggle={() => {}} />);
    expect(screen.queryByTestId("ae-voice-start")).toBeNull();
    expect(screen.queryByTestId("ae-voice-start-menu")).toBeNull();
  });

  it("has a menu chevron with the speaker menu's touch sizing, and the visible hint icon for touch users", () => {
    render(<AeVoiceStartButton armed={false} onToggle={() => {}} />);
    const chevron = screen.getByTestId("ae-voice-start-menu");
    expect(chevron.getAttribute("aria-label")).toBe("Voice mode menu");
    expect(chevron.className).toContain("pointer-coarse:h-11");
    expect(chevron.className).toContain("pointer-coarse:w-9");
    expect(screen.getByTestId("ae-hint-voice.start")).toBeTruthy();
  });

  it("disables the chevron with the button", () => {
    render(<AeVoiceStartButton armed={false} onToggle={() => {}} disabled />);
    expect(screen.getByTestId("ae-voice-start-menu")).toBeDisabled();
  });

  it("opens a menu with the chat-free rows, each with its hint, and none that need a chat", async () => {
    render(<AeVoiceStartButton armed={false} onToggle={() => {}} />);
    await openMenu();
    const toggle = screen.getByTestId("ae-voice-start-toggle");
    expect(toggle).toHaveTextContent("Voice mode");
    // The voice.start hint moved into the Voice mode row.
    expect(within(toggle).getByTestId("ae-hint-voice.start")).toBeInTheDocument();
    for (const id of [
      "ae-voice-mic-while-speaking",
      "ae-voice-meter",
      "ae-speak-voice-trigger",
      "ae-voice-chat-voice-trigger",
      "ae-speak-rate-trigger",
      "ae-voice-log-send",
    ]) {
      const row = screen.getByTestId(id);
      expect(row, id).toBeInTheDocument();
      expect(row.querySelector("[data-slot=tooltip-trigger]"), id).not.toBeNull();
    }
    for (const id of [
      "ae-speak-fast",
      "ae-voice-model-trigger",
      "ae-speak-read-last",
      "ae-voice-log",
      "ae-speak-toggle",
    ]) {
      expect(screen.queryByTestId(id), id).toBeNull();
    }
  });

  it("has a Level meter row in the new-chat voice menu, with a hint, saved per device", async () => {
    render(<AeVoiceStartButton armed={false} onToggle={() => {}} />);
    const user = await openMenu();
    const row = screen.getByTestId("ae-voice-meter");
    // The test browser is not WebKit, so the default is on.
    expect(row).toHaveAttribute("aria-checked", "true");
    expect(within(row).getByTestId("ae-hint-voice.meter")).toBeInTheDocument();
    await user.click(row);
    expect(screen.getByTestId("ae-voice-meter")).toHaveAttribute("aria-checked", "false");
    expect(window.localStorage.getItem("omnigent:ae-voice-meter")).toBe("off");
  });

  it("lists the microphone and speaker rows when the browser can choose them", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: () => Promise.resolve([]),
        addEventListener: () => {},
        removeEventListener: () => {},
        getUserMedia: () => Promise.resolve({ getTracks: () => [] }),
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      configurable: true,
      writable: true,
      value: () => Promise.resolve(),
    });
    try {
      render(<AeVoiceStartButton armed={false} onToggle={() => {}} />);
      await openMenu();
      expect(screen.getByTestId("ae-speak-mic-trigger")).toBeInTheDocument();
      expect(screen.getByTestId("ae-speak-speaker-trigger")).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(navigator, "mediaDevices");
      Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
    }
  });

  it("the Voice mode row toggles and reflects the armed state", async () => {
    const onToggle = vi.fn();
    const { rerender } = render(<AeVoiceStartButton armed={false} onToggle={onToggle} />);
    const user = await openMenu();
    expect(screen.getByTestId("ae-voice-start-toggle")).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByTestId("ae-voice-start-toggle"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<AeVoiceStartButton armed onToggle={onToggle} />);
    expect(screen.getByTestId("ae-voice-start-toggle")).toHaveAttribute("aria-checked", "true");
  });

  it("Send voice log uploads without a chat id and says so", async () => {
    const toastSpy = vi.spyOn(toast, "success").mockImplementation(() => "");
    render(<AeVoiceStartButton armed={false} onToggle={() => {}} />);
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-voice-log-send"));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith("Voice log sent"));
    const post = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).includes("/v1/ae/voice-log"));
    const body = JSON.parse(String(((post as unknown[])[1] as RequestInit).body));
    expect(body.reason).toBe("manual");
    expect(body.chat_id).toBeUndefined();
    toastSpy.mockRestore();
  });
});
