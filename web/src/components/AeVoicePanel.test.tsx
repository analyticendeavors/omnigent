import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishMicLevel, resetMicLevel } from "@/lib/aeMicLevel";
import type { VoicePhase } from "@/lib/aeVoiceMode";
import { AE_VOICE_RING, AeVoicePanel, type AeVoicePanelProps, voicePhaseKey } from "./AeVoicePanel";

afterEach(() => resetMicLevel());

function panel(props: Partial<AeVoicePanelProps> = {}) {
  const handlers = { onEnd: vi.fn(), onStop: vi.fn(), onResume: vi.fn() };
  const utils = render(
    <AeVoicePanel
      layout="bar"
      phase="listening"
      blocked={false}
      heard=""
      caption=""
      {...handlers}
      {...props}
    />,
  );
  return { ...utils, ...handlers };
}

const WORDS: [VoicePhase, string, string][] = [
  ["starting", "Starting the mic", ""],
  ["listening", "Listening", "Say something"],
  ["paused", "Mic stopped", "Tap the mic to listen again"],
  ["unavailable", "Mic unavailable", "Check the microphone permission"],
  ["thinking", "Working on it", "Mic muted until the reply ends"],
  ["speaking", "Speaking, tap to stop", "Hello there."],
];

describe("AeVoicePanel", () => {
  it("renders nothing when Voice mode is off", () => {
    panel({ phase: "off" });
    expect(screen.queryByTestId("ae-voice-panel")).toBeNull();
  });

  for (const layout of ["bar", "sheet"] as const) {
    it.each(WORDS)(`${layout}: %s shows its words and data-phase`, (phase, label, sub) => {
      panel({ layout, phase, caption: "Hello there." });
      const root = screen.getByTestId("ae-voice-panel");
      expect(root).toHaveAttribute("data-phase", phase);
      expect(root).toHaveAttribute("data-layout", layout);
      expect(root).toHaveTextContent(label);
      if (sub) expect(root).toHaveTextContent(sub);
    });
  }

  it("listening shows what was heard, and unavailable shows the detail", () => {
    const { rerender, onEnd, onStop, onResume } = panel({ heard: "open the file" });
    expect(screen.getByTestId("ae-voice-panel")).toHaveTextContent("open the file");
    rerender(
      <AeVoicePanel
        layout="bar"
        phase="unavailable"
        blocked={false}
        heard=""
        caption=""
        micDetail="No microphone found"
        onEnd={onEnd}
        onStop={onStop}
        onResume={onResume}
      />,
    );
    expect(screen.getByTestId("ae-voice-panel")).toHaveTextContent("No microphone found");
  });

  it("blocked wins over speaking", () => {
    panel({ phase: "speaking", blocked: true, caption: "Hello" });
    const root = screen.getByTestId("ae-voice-panel");
    expect(root).toHaveAttribute("data-phase", "blocked");
    expect(root).toHaveTextContent("Tap to hear the reply");
    expect(root).toHaveTextContent("The browser blocked playback that no tap started");
    expect(voicePhaseKey("speaking", true)).toBe("blocked");
    expect(voicePhaseKey("off", true)).toBe("off");
  });

  it("the middle button stops while speaking and resumes while blocked", async () => {
    const user = userEvent.setup();
    const speaking = panel({ phase: "speaking", caption: "Hi" });
    await user.click(screen.getByRole("button", { name: "Stop speaking" }));
    expect(speaking.onStop).toHaveBeenCalledTimes(1);
    expect(speaking.onResume).not.toHaveBeenCalled();
    speaking.unmount();
    const blocked = panel({ phase: "speaking", blocked: true });
    await user.click(screen.getByRole("button", { name: "Play the reply" }));
    expect(blocked.onResume).toHaveBeenCalledTimes(1);
    expect(blocked.onStop).not.toHaveBeenCalled();
  });

  it("the middle button does nothing in other phases", async () => {
    const { onStop, onResume } = panel({ phase: "listening" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Listening" }));
    expect(onStop).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("End calls onEnd", async () => {
    const { onEnd } = panel();
    await userEvent.setup().click(screen.getByRole("button", { name: "End voice mode" }));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("the sheet shows the keyboard button only with onKeyboard", async () => {
    const first = panel({ layout: "sheet" });
    expect(screen.queryByRole("button", { name: "Type instead" })).toBeNull();
    first.unmount();
    const onKeyboard = vi.fn();
    panel({ layout: "sheet", onKeyboard });
    await userEvent.setup().click(screen.getByRole("button", { name: "Type instead" }));
    expect(onKeyboard).toHaveBeenCalledTimes(1);
  });

  it("the sheet disc is flat: no gradient or shadow classes", () => {
    panel({ layout: "sheet", phase: "thinking" });
    const html = screen.getByTestId("ae-voice-panel").innerHTML;
    expect(html).toContain("animate-pulse");
    expect(html).not.toMatch(/gradient|shadow/);
  });

  it("the level bars read the mic level store", () => {
    panel({ phase: "listening" });
    const heights = () =>
      screen
        .getAllByTestId("ae-voice-level-bar")
        .map((b) => parseInt((b as HTMLElement).style.height));
    expect(heights()).toEqual([4, 4, 4, 4, 4]);
    act(() => publishMicLevel(1));
    const loud = heights();
    expect(loud[1]).toBe(16);
    expect(loud[0]).toBeLessThan(loud[1]);
  });

  it("the level bars stay still when not listening", () => {
    panel({ phase: "thinking" });
    act(() => publishMicLevel(1));
    expect(
      screen.getAllByTestId("ae-voice-level-bar").map((b) => (b as HTMLElement).style.height),
    ).toEqual(["4px", "4px", "4px", "4px", "4px"]);
  });

  it("maps phases to flat border colours", () => {
    expect(AE_VOICE_RING.listening).toBe("border-teal-500");
    expect(AE_VOICE_RING.thinking).toBe("border-amber-500");
    expect(AE_VOICE_RING.speaking).toBe("border-blue-500");
    expect(AE_VOICE_RING.blocked).toBe("border-red-500");
    expect(AE_VOICE_RING.paused).toBe("border-border");
  });

  for (const layout of ["bar", "sheet"] as const) {
    it.each(["paused", "unavailable"] as const)(
      `${layout}: a tap while %s restarts the mic`,
      async (phase) => {
        const onRestartMic = vi.fn();
        panel({ layout, phase, onRestartMic });
        await userEvent.click(screen.getByRole("button", { name: "Listen again" }));
        expect(onRestartMic).toHaveBeenCalledTimes(1);
      },
    );
  }
});

describe("AeVoicePanel (stuck start)", () => {
  afterEach(() => vi.useRealTimers());

  it("offers a tap to start the mic after 3 s of starting, and the tap restarts", () => {
    vi.useFakeTimers();
    const onRestartMic = vi.fn();
    panel({ phase: "starting", onRestartMic });
    expect(screen.getByText("Starting the mic")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(screen.getByText("Tap to start the mic")).toBeTruthy();
    act(() => screen.getByRole("button", { name: "Start the mic" }).click());
    expect(onRestartMic).toHaveBeenCalledTimes(1);
  });

  it("does not offer the tap when the phase moves on first", () => {
    vi.useFakeTimers();
    const { rerender, onEnd, onStop, onResume } = panel({
      phase: "starting",
      onRestartMic: vi.fn(),
    });
    rerender(
      <AeVoicePanel
        layout="bar"
        phase="listening"
        blocked={false}
        heard=""
        caption=""
        onEnd={onEnd}
        onStop={onStop}
        onResume={onResume}
        onRestartMic={vi.fn()}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText("Tap to start the mic")).toBeNull();
  });
});
