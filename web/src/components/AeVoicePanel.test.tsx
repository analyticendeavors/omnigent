import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as hotkeys from "@/lib/hotkeys";
import { publishMicLevel, resetMicLevel } from "@/lib/aeMicLevel";
import type { VoicePhase } from "@/lib/aeVoiceMode";
import {
  AE_VOICE_RING,
  AeVoicePanel,
  type AeVoicePanelProps,
  barHints,
  micChordKeys,
  voicePhaseKey,
} from "./AeVoicePanel";

const platform = vi.hoisted(() => ({ mac: false }));
vi.mock("@/lib/hotkeys", async (importOriginal) => ({
  ...(await importOriginal<typeof hotkeys>()),
  isMacPlatform: () => platform.mac,
}));

afterEach(() => {
  resetMicLevel();
  platform.mac = false;
});

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

const SHEET_WORDS: Partial<Record<VoicePhase, string>> = {
  thinking: "Working",
  speaking: "Speaking",
};

describe("AeVoicePanel", () => {
  it("offers the restart and still names the approval when the mic went quiet during one", async () => {
    const onRestartMic = vi.fn();
    panel({
      phase: "unavailable",
      micDetail: "Mic went quiet, tap to restart",
      approvalActive: true,
      onRestartMic,
    });
    expect(screen.getByText("Mic unavailable")).toBeTruthy();
    expect(screen.getByText(/Mic went quiet, tap to restart\. Approval waiting/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Listen again" }));
    expect(onRestartMic).toHaveBeenCalledTimes(1);
  });

  it.each(["bar", "sheet"] as const)(
    "%s: shows Run it and Decline while the line is speaking, and they answer the card",
    async (layout) => {
      const onApproval = vi.fn();
      panel({
        layout,
        phase: "speaking",
        caption: "Slots full.",
        approvalActive: true,
        onApproval,
      });
      expect(
        screen.getByText(layout === "sheet" ? "Speaking" : "Speaking, tap to stop"),
      ).toBeTruthy();
      expect(screen.getByText(/Waiting for your OK/)).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "Run it" }));
      expect(onApproval).toHaveBeenLastCalledWith("accept");
      await userEvent.click(screen.getByRole("button", { name: "Decline" }));
      expect(onApproval).toHaveBeenLastCalledWith("decline");
    },
  );

  it("the approval phase word is not repeated beside the buttons", () => {
    panel({ phase: "approval", approvalActive: true, onApproval: vi.fn() });
    expect(screen.getAllByText("Waiting for your OK")).toHaveLength(1);
    expect(screen.getByTestId("ae-voice-approval-run")).toBeTruthy();
  });

  it("shows no approval buttons without a pending approval or without a handler", () => {
    const { unmount } = panel({ phase: "speaking", approvalActive: false, onApproval: vi.fn() });
    expect(screen.queryByTestId("ae-voice-approval")).toBeNull();
    unmount();
    panel({ phase: "speaking", approvalActive: true });
    expect(screen.queryByTestId("ae-voice-approval")).toBeNull();
  });

  it("the sheet's approval pair replaces the big button and keyboard and End stay on the top row", () => {
    panel({
      layout: "sheet",
      phase: "approval",
      approvalActive: true,
      onApproval: vi.fn(),
      onKeyboard: vi.fn(),
    });
    expect(screen.queryByTestId("ae-voice-action")).toBeNull();
    const row = screen.getByTestId("ae-voice-approval");
    const names = Array.from(row.querySelectorAll("button")).map((b) => b.textContent);
    expect(names).toEqual(["Run it", "Decline"]);
    expect(screen.getByTestId("ae-voice-approval-run").className).toContain("h-14");
    expect(screen.getByLabelText("Type instead")).toBeTruthy();
    expect(screen.getByLabelText("End voice mode")).toBeTruthy();
  });

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
      expect(root).toHaveTextContent(layout === "sheet" ? (SHEET_WORDS[phase] ?? label) : label);
      if (sub) expect(root).toHaveTextContent(sub);
    });
  }

  it("listening shows the heard words (not the prompt), and unavailable shows the detail", () => {
    const { rerender, onEnd, onStop, onResume } = panel({ heard: "open the file" });
    const root = screen.getByTestId("ae-voice-panel");
    expect(root).toHaveTextContent("open the file");
    expect(root).not.toHaveTextContent("Say something");
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

  it("the sheet is flat: no gradient or shadow classes, and no orb", () => {
    panel({ layout: "sheet", phase: "thinking" });
    const html = screen.getByTestId("ae-voice-panel").innerHTML;
    expect(html).not.toMatch(/gradient|shadow/);
    expect(screen.queryByTestId("ae-voice-ring")).toBeNull();
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
    panel({ phase: "starting", onRestartMic, micStartPath: () => "browser" });
    expect(screen.getByText("Starting the mic")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(screen.getByText("Tap to start the mic")).toBeTruthy();
    act(() => screen.getByRole("button", { name: "Start the mic" }).click());
    expect(onRestartMic).toHaveBeenCalledTimes(1);
  });

  it("offers no tap while the start is on the server path", () => {
    vi.useFakeTimers();
    panel({ phase: "starting", onRestartMic: vi.fn(), micStartPath: () => "server" });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.queryByText("Tap to start the mic")).toBeNull();
    expect(screen.getByText("Starting the mic")).toBeTruthy();
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

describe("AeVoicePanel (sheet controls)", () => {
  it("the sheet without an approval shows the keyboard and End as before", async () => {
    const onKeyboard = vi.fn();
    const { onEnd } = panel({ layout: "sheet", onKeyboard });
    expect(screen.queryByTestId("ae-voice-approval")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Type instead" }));
    expect(onKeyboard).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "End voice mode" }));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("the sheet's keyboard and End share one row with 44 px tap targets", () => {
    panel({ layout: "sheet", onKeyboard: vi.fn() });
    const keyboard = screen.getByRole("button", { name: "Type instead" });
    const end = screen.getByRole("button", { name: "End voice mode" });
    expect(keyboard.parentElement).toBe(end.parentElement);
    expect(keyboard.parentElement?.className).toContain("items-center");
    expect(keyboard.className).toContain("size-11");
    expect(end.className).toContain("h-11");
  });

  it("an undefined onKeyboard hides the keyboard button, with and without an approval", () => {
    panel({ layout: "sheet" });
    expect(screen.queryByRole("button", { name: "Type instead" })).toBeNull();
    expect(screen.getByRole("button", { name: "End voice mode" })).toBeTruthy();
    cleanup();
    panel({ layout: "sheet", approvalActive: true, onApproval: vi.fn() });
    expect(screen.queryByRole("button", { name: "Type instead" })).toBeNull();
    expect(screen.getByTestId("ae-voice-approval-run")).toBeTruthy();
  });
});

describe("AeVoicePanel car-mode sheet", () => {
  const sheet = (props: Partial<AeVoicePanelProps> = {}) => panel({ layout: "sheet", ...props });
  const button = () => screen.getByTestId("ae-voice-action");

  it("listening: Send now is disabled until something is heard, then sends at once", async () => {
    const onSendNow = vi.fn();
    const { rerender, onEnd, onStop, onResume } = sheet({ onSendNow });
    expect(button()).toHaveTextContent("Send now");
    expect(button()).toBeDisabled();
    rerender(
      <AeVoicePanel
        layout="sheet"
        phase="listening"
        blocked={false}
        heard="open the file"
        caption=""
        onSendNow={onSendNow}
        onEnd={onEnd}
        onStop={onStop}
        onResume={onResume}
      />,
    );
    expect(button()).toBeEnabled();
    await userEvent.click(button());
    expect(onSendNow).toHaveBeenCalledTimes(1);
  });

  it.each(["thinking", "preparing"] as const)(
    "%s: Stop stays visible, dimmed, aria-disabled and out of the tab order",
    async (phase) => {
      const { onStop } = sheet({ phase });
      expect(button()).toHaveTextContent("Stop");
      expect(button()).toHaveAttribute("aria-disabled", "true");
      expect(button()).toHaveAccessibleName("Stop (nothing playing yet)");
      expect(button()).toHaveAttribute("tabindex", "-1");
      expect(button()).not.toBeDisabled();
      const cls = button().className;
      expect(cls).toContain("h-14 w-full");
      expect(cls).toContain("bg-amber-500/30");
      expect(cls).toContain("text-amber-900");
      expect(cls).toContain("dark:text-amber-200");
      expect(cls).not.toContain("bg-background");
      await userEvent.click(button());
      expect(onStop).not.toHaveBeenCalled();
    },
  );

  it("speaking: Stop is solid and calls onStop", async () => {
    const { onStop } = sheet({ phase: "speaking", caption: "Hello." });
    expect(button()).toHaveTextContent("Stop");
    expect(button()).toHaveAccessibleName("Stop speaking");
    expect(button().className).toContain("dark:text-amber-950");
    expect(button().className).toContain("h-14 w-full");
    await userEvent.click(button());
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("blocked: Play the reply calls onResume", async () => {
    const { onResume } = sheet({ blocked: true });
    expect(screen.getByText("Tap to hear the reply")).toBeTruthy();
    expect(button()).toHaveAccessibleName("Play the reply");
    await userEvent.click(button());
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it.each(["paused", "unavailable"] as const)(
    "%s: Listen again calls onRestartMic",
    async (phase) => {
      const onRestartMic = vi.fn();
      sheet({ phase, onRestartMic });
      expect(button()).toHaveTextContent("Listen again");
      await userEvent.click(button());
      expect(onRestartMic).toHaveBeenCalledTimes(1);
    },
  );

  it("stalled has no button but keeps the row height", () => {
    sheet({ phase: "stalled" });
    expect(screen.queryByTestId("ae-voice-action")).toBeNull();
    expect(screen.getByText("Chat not ready")).toBeTruthy();
  });

  it("the state word is large and the top border carries the state colour", () => {
    sheet({ phase: "listening" });
    const root = screen.getByTestId("ae-voice-panel");
    expect(root.className).toContain("border-t-[3px]");
    expect(root.className).toContain("border-t-teal-500");
    expect(screen.getByText("Listening").className).toContain("text-[30px]");
  });

  it("the state word and outline buttons use light-safe shades, with dark mode kept", () => {
    sheet({ phase: "listening" });
    expect(screen.getByText("Listening").className).toContain("text-teal-700");
    expect(screen.getByText("Listening").className).toContain("dark:text-teal-500");
    expect(button().className).toContain("dark:border-teal-500");
    expect(button().className).toContain("dark:bg-transparent");
    cleanup();
    sheet({ phase: "thinking" });
    expect(screen.getByText("Working").className).toContain("var(--ae-voice-amber)");
    cleanup();
    sheet({ phase: "paused", onRestartMic: vi.fn() });
    expect(button().className).toContain("border-foreground/50");
  });

  it("the level bars show only while listening", () => {
    const { unmount } = sheet({ phase: "listening" });
    expect(screen.getByTestId("ae-voice-level")).toBeTruthy();
    unmount();
    sheet({ phase: "thinking" });
    expect(screen.queryByTestId("ae-voice-level")).toBeNull();
  });
});

describe("AeVoicePanel bar words and keys", () => {
  it("lists only true hints per phase", () => {
    expect(barHints("listening", false)).toEqual([
      { keys: ["Enter"], word: "send" },
      { keys: ["Esc"], word: "end" },
    ]);
    expect(barHints("speaking", false)).toEqual([
      { keys: ["Ctrl", "Alt", "V"], word: "stop" },
      { keys: ["Esc"], word: "end" },
    ]);
    for (const key of ["thinking", "starting", "paused", "approval", "blocked"] as const) {
      expect(barHints(key, false)).toEqual([]);
    }
  });

  it("uses the Mac chord label on a Mac", () => {
    expect(micChordKeys(true)).toEqual(["⌘", "⌥", "V"]);
    platform.mac = true;
    panel({ phase: "speaking", caption: "Hi." });
    expect(screen.getByTestId("ae-voice-hints")).toHaveTextContent("⌘⌥Vstop");
  });

  it("renders the hints in a group hidden below the container width", () => {
    panel({ phase: "listening" });
    const hints = screen.getByTestId("ae-voice-hints");
    expect(hints).toHaveTextContent("Entersend");
    expect(hints).toHaveTextContent("Escend");
    expect(hints.className).toContain("hidden");
    expect(hints.className).toContain("@[560px]:flex");
    expect(screen.getByTestId("ae-voice-panel").className).toContain("@container");
  });

  it("hides the Enter hint while an approval or question card is pending", () => {
    expect(barHints("listening", false, false)).toEqual([{ keys: ["Esc"], word: "end" }]);
    const { unmount } = panel({ phase: "listening", cardPending: true });
    expect(screen.getByTestId("ae-voice-hints")).not.toHaveTextContent("Enter");
    expect(screen.getByTestId("ae-voice-hints")).toHaveTextContent("Escend");
    unmount();
    panel({ phase: "listening", approvalActive: true, onApproval: vi.fn() });
    expect(screen.getByTestId("ae-voice-hints")).not.toHaveTextContent("Enter");
  });

  it("puts the approval buttons on their own row below the container width", () => {
    panel({ phase: "speaking", caption: "Slots full.", approvalActive: true, onApproval: vi.fn() });
    const approval = screen.getByTestId("ae-voice-approval");
    expect(approval.className).toContain("basis-full");
    expect(approval.className).toContain("order-last");
    expect(approval.className).toContain("@[560px]:basis-auto");
    expect(screen.getByTestId("ae-voice-panel").className).toContain("flex-wrap");
    expect(screen.getByText("Speaking, tap to stop").className).toContain("truncate");
    expect(screen.getByText("Slots full.").className).toContain("line-clamp-2");
  });

  it("shows no hints while thinking", () => {
    panel({ phase: "thinking" });
    expect(screen.queryByTestId("ae-voice-hints")).toBeNull();
  });

  it("wraps the sub line to two lines; words in the foreground colour, hints muted", () => {
    const { unmount } = panel({ phase: "listening", heard: "open the file" });
    const sub = screen.getByText("open the file");
    expect(sub.className).toContain("line-clamp-2");
    expect(sub.className).not.toContain("truncate");
    expect(sub.className).toContain("text-foreground");
    unmount();
    panel({ phase: "thinking" });
    expect(screen.getByText("Mic muted until the reply ends").className).toContain(
      "text-muted-foreground",
    );
  });
});
