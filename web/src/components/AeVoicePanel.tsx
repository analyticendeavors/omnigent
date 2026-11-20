// What Voice mode is doing, on screen (omnigent-ae, 2026-11-10). A bar above the
// input on the desktop, a sheet that replaces the input on a phone. Flat: thin
// borders and the product's muted palette, no gradients or shadows.

import { KeyboardIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useMicLevel } from "@/lib/aeMicLevel";
import type { VoicePhase } from "@/lib/aeVoiceMode";
import { isMacPlatform } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";

export type VoicePhaseKey =
  | "starting"
  | "listening"
  | "paused"
  | "unavailable"
  | "thinking"
  | "speaking"
  | "approval"
  | "preparing"
  | "stalled"
  | "blocked";

/** How long "Starting the mic" may sit before the tap action appears. */
export const MIC_STUCK_MS = 3000;

export interface AeVoicePanelProps {
  layout: "bar" | "sheet";
  phase: VoicePhase;
  /** The browser refused to play the reply. */
  blocked: boolean;
  /** The draft text while listening, interim included. */
  heard: string;
  /** The sentence being spoken. */
  caption: string;
  /** Why the mic is unavailable, when known. */
  micDetail?: string | null;
  /** A yes-or-no card is waiting, even when the mic cannot hear the answer. */
  approvalActive?: boolean;
  /** Run it or Decline from the panel; with approvalActive the two buttons show in every phase. */
  onApproval?: (action: "accept" | "decline") => void;
  /** Turn Voice mode off. */
  onEnd: () => void;
  /** A yes-or-no or question card waits: Enter cannot send, so its hint is hidden. */
  cardPending?: boolean;
  /** Sheet only: send the heard draft now instead of waiting out the send pause. */
  onSendNow?: () => void;
  /** Stop the current reply. */
  onStop: () => void;
  /** Play the refused reply; runs inside the tap. */
  onResume: () => void;
  /** Sheet only: show the text box for one message. */
  onKeyboard?: () => void;
  /** Start the mic again when it is paused or unavailable; runs inside the tap. */
  onRestartMic?: () => void;
  /** Which path the mic start is on; the tap to start shows for the browser path only. */
  micStartPath?: () => "browser" | "server" | null;
  className?: string;
}

/** The panel's state word key: a refused reply wins over every phase. */
export function voicePhaseKey(phase: VoicePhase, blocked: boolean): VoicePhaseKey | "off" {
  if (phase === "off") return "off";
  return blocked ? "blocked" : phase;
}

/** The composer's border colour while Voice mode is on. */
export const AE_VOICE_RING: Record<VoicePhaseKey | "off", string> = {
  off: "border-border",
  starting: "border-border",
  listening: "border-teal-500",
  paused: "border-border",
  unavailable: "border-border",
  thinking: "border-amber-500",
  approval: "border-amber-500",
  preparing: "border-amber-500",
  stalled: "border-border",
  speaking: "border-blue-500",
  blocked: "border-red-500",
};

const TONE: Record<VoicePhaseKey, { text: string; panel: string; ring: string; disc: string }> = {
  listening: {
    text: "text-teal-500",
    panel: "border-teal-500/50 bg-teal-500/10",
    ring: "border-teal-500/40",
    disc: "bg-teal-500",
  },
  thinking: {
    text: "text-amber-500",
    panel: "border-amber-500/50 bg-amber-500/10",
    ring: "border-amber-500/40",
    disc: "bg-amber-500",
  },
  approval: {
    text: "text-amber-500",
    panel: "border-amber-500/50 bg-amber-500/10",
    ring: "border-amber-500/40",
    disc: "bg-amber-500",
  },
  preparing: {
    text: "text-amber-500",
    panel: "border-amber-500/50 bg-amber-500/10",
    ring: "border-amber-500/40",
    disc: "bg-amber-500",
  },
  stalled: {
    text: "text-muted-foreground",
    panel: "border-border bg-muted/40",
    ring: "border-border",
    disc: "bg-muted-foreground",
  },
  speaking: {
    text: "text-blue-500",
    panel: "border-blue-500/50 bg-blue-500/10",
    ring: "border-blue-500/40",
    disc: "bg-blue-500",
  },
  blocked: {
    text: "text-red-500",
    panel: "border-red-500/50 bg-red-500/10",
    ring: "border-red-500/40",
    disc: "bg-red-500",
  },
  starting: {
    text: "text-muted-foreground",
    panel: "border-border bg-muted/40",
    ring: "border-border",
    disc: "bg-muted-foreground",
  },
  paused: {
    text: "text-muted-foreground",
    panel: "border-border bg-muted/40",
    ring: "border-border",
    disc: "bg-muted-foreground",
  },
  unavailable: {
    text: "text-muted-foreground",
    panel: "border-border bg-muted/40",
    ring: "border-border",
    disc: "bg-muted-foreground",
  },
};

/** The sheet draws the reply in the ring's own amber token (darker in light mode for contrast); the bar keeps blue. */
const SHEET_SPEAKING = {
  text: "text-[color:var(--ae-voice-amber)]",
  ring: "border-[color:color-mix(in_srgb,var(--ae-voice-amber)_40%,transparent)]",
  disc: "bg-[color:var(--ae-voice-amber)]",
  panel: "bg-[color:color-mix(in_srgb,var(--ae-voice-amber)_10%,transparent)]",
  top: "border-t-[color:var(--ae-voice-amber)]",
  solid: "bg-[color:var(--ae-voice-amber)] text-white hover:bg-[color:var(--ae-voice-amber)]/90",
  outline:
    "border-[color:var(--ae-voice-amber)] text-[color:var(--ae-voice-amber)] hover:bg-[color:var(--ae-voice-amber)]/10 dark:bg-transparent",
  word: "text-[color:var(--ae-voice-amber)]",
};

/** The sheet's top border and button fills per state colour (static strings so Tailwind sees them). */
const SHEET_COLOURS: Record<string, { top: string; solid: string; outline: string; word: string }> =
  {
    "text-teal-500": {
      top: "border-t-teal-500",
      solid: "bg-teal-500 text-white hover:bg-teal-500/90",
      outline:
        "border-teal-600 text-teal-700 hover:bg-teal-500/10 dark:border-teal-500 dark:bg-transparent dark:text-teal-500",
      word: "text-teal-700 dark:text-teal-500",
    },
    "text-amber-500": {
      top: "border-t-amber-500",
      solid: "bg-amber-500 text-white hover:bg-amber-500/90",
      outline:
        "border-[color:var(--ae-voice-amber)] text-[color:var(--ae-voice-amber)] hover:bg-amber-500/10 dark:bg-transparent",
      word: "text-[color:var(--ae-voice-amber)]",
    },
    "text-blue-500": {
      top: "border-t-blue-500",
      solid: "bg-blue-500 text-white hover:bg-blue-500/90",
      outline:
        "border-blue-600 text-blue-700 hover:bg-blue-500/10 dark:border-blue-500 dark:bg-transparent dark:text-blue-500",
      word: "text-blue-700 dark:text-blue-500",
    },
    "text-red-500": {
      top: "border-t-red-500",
      solid: "bg-red-500 text-white hover:bg-red-500/90",
      outline:
        "border-red-600 text-red-700 hover:bg-red-500/10 dark:border-red-500 dark:bg-transparent dark:text-red-500",
      word: "text-red-700 dark:text-red-500",
    },
    "text-muted-foreground": {
      top: "border-t-border",
      solid: "bg-foreground text-background hover:bg-foreground/90",
      outline:
        "border-foreground/50 text-foreground hover:bg-muted dark:border-foreground/50 dark:bg-transparent",
      word: "text-muted-foreground",
    },
  };

/** The sheet's short state words; the bar keeps `words()`. */
const SHEET_LABEL: Partial<Record<VoicePhaseKey, string>> = {
  thinking: "Working",
  speaking: "Speaking",
};

/** The mic chord as the key chips show it. */
export function micChordKeys(isMac: boolean): string[] {
  return isMac ? ["⌘", "⌥", "V"] : ["Ctrl", "Alt", "V"];
}

/** Key hints on the bar: only keys that do this in the phase. */
export function barHints(
  key: VoicePhaseKey,
  isMac: boolean,
  canSendWithEnter = true,
): { keys: string[]; word: string }[] {
  if (key === "listening") {
    return [
      ...(canSendWithEnter ? [{ keys: ["Enter"], word: "send" }] : []),
      { keys: ["Esc"], word: "end" },
    ];
  }
  if (key === "speaking") {
    return [
      { keys: micChordKeys(isMac), word: "stop" },
      { keys: ["Esc"], word: "end" },
    ];
  }
  return [];
}

const BAR_WEIGHTS = [0.6, 1, 0.8, 1, 0.7];
const BAR_MIN_PX = 4;
const BAR_MAX_PX = 16;

/** Five bars that follow the mic level; still at the baseline when not listening. */
function AeLevelBars({ active, className }: { active: boolean; className?: string }) {
  const level = useMicLevel();
  return (
    <div
      aria-hidden
      data-testid="ae-voice-level"
      className={cn("flex h-4 shrink-0 items-center gap-[3px]", className)}
    >
      {BAR_WEIGHTS.map((weight, i) => {
        // The bars are fixed in number and order, so the position is their identity.
        const height = active
          ? BAR_MIN_PX + (BAR_MAX_PX - BAR_MIN_PX) * Math.min(1, level * weight)
          : BAR_MIN_PX;
        return (
          <span
            // oxlint-disable-next-line react/no-array-index-key
            key={i}
            data-testid="ae-voice-level-bar"
            className="w-[3px] rounded-full bg-current"
            style={{ height: `${Math.round(height)}px` }}
          />
        );
      })}
    </div>
  );
}

function words(
  key: VoicePhaseKey,
  heard: string,
  caption: string,
  micDetail: string | null | undefined,
  approvalActive: boolean,
): { label: string; sub: string; strong?: boolean } {
  switch (key) {
    case "starting":
      return { label: "Starting the mic", sub: "" };
    case "listening":
      return heard.trim()
        ? { label: "Listening", sub: heard.trim(), strong: true }
        : { label: "Listening", sub: "Say something" };
    case "paused":
      return { label: "Mic stopped", sub: "Tap the mic to listen again" };
    case "unavailable":
      return {
        label: "Mic unavailable",
        sub: approvalActive
          ? `${micDetail || "Check the microphone permission"}. Approval waiting: run it, or decline.`
          : micDetail || "Check the microphone permission",
      };
    case "thinking":
      return { label: "Working on it", sub: "Mic muted until the reply ends" };
    case "speaking":
      return { label: "Speaking, tap to stop", sub: caption, strong: true };
    case "approval":
      return { label: "Waiting for your OK", sub: "Say run it, or decline" };
    case "preparing":
      return { label: "Getting the chat ready", sub: "Your message is held" };
    case "stalled":
      return { label: "Chat not ready", sub: "Your message was not sent. Press Start session." };
    case "blocked":
      return {
        label: "Tap to hear the reply",
        sub: "The browser blocked playback that no tap started",
      };
  }
}

export function AeVoicePanel({
  layout,
  phase,
  blocked,
  heard,
  caption,
  micDetail,
  approvalActive = false,
  cardPending = false,
  onApproval,
  onEnd,
  onSendNow,
  onStop,
  onResume,
  onKeyboard,
  onRestartMic,
  micStartPath,
  className,
}: AeVoicePanelProps) {
  const key = voicePhaseKey(phase, blocked);
  // A start that hangs on "starting" gets a tap, so the mic start runs inside a gesture.
  const [startStuck, setStartStuck] = useState(false);
  useEffect(() => {
    setStartStuck(false);
    if (key !== "starting") return;
    const t = setTimeout(() => setStartStuck(true), MIC_STUCK_MS);
    return () => clearTimeout(t);
  }, [key]);
  if (key === "off") return null;
  const tone =
    layout === "sheet" && key === "speaking" ? { ...TONE[key], ...SHEET_SPEAKING } : TONE[key];
  // A server start is a model cold start that can take 40 s; a tap there would only get in its way.
  const tapToStart =
    key === "starting" && startStuck && Boolean(onRestartMic) && micStartPath?.() === "browser";
  const spoken = tapToStart
    ? { label: "Tap to start the mic", sub: "", strong: false }
    : words(key, heard, caption, micDetail, approvalActive);
  const { label, sub, strong } = spoken;
  const restartable = key === "paused" || key === "unavailable" || tapToStart;
  const action =
    key === "speaking"
      ? onStop
      : key === "blocked"
        ? onResume
        : restartable
          ? onRestartMic
          : undefined;
  const actionLabel =
    key === "speaking"
      ? "Stop speaking"
      : key === "blocked"
        ? "Play the reply"
        : tapToStart
          ? "Start the mic"
          : restartable
            ? "Listen again"
            : label;
  const endButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={layout === "sheet" ? "h-11 px-4" : undefined}
      aria-label="End voice mode"
      onClick={onEnd}
    >
      End
    </Button>
  );
  const approvalPending = approvalActive && Boolean(onApproval);

  if (layout === "sheet") {
    const colours = key === "speaking" ? SHEET_SPEAKING : SHEET_COLOURS[tone.text];
    const top = colours.top;
    // The state tint only; the top border carries the full colour.
    const sheetBg = tone.panel
      .split(" ")
      .filter((c) => c.startsWith("bg-"))
      .join(" ");
    const big = "h-14 w-full text-base font-semibold";
    const placeholder = <div aria-hidden className="h-14" />;
    // The big button: one per phase. `sheetButton` is the label shown, `actionLabel` the aria name.
    let button: ReactNode = placeholder;
    if (approvalPending && onApproval) {
      button = (
        <div data-testid="ae-voice-approval" className="flex gap-3">
          <Button
            type="button"
            data-testid="ae-voice-approval-run"
            className="h-14 flex-1 text-base font-semibold"
            onClick={() => onApproval("accept")}
          >
            Run it
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="ae-voice-approval-decline"
            className="h-14 flex-1 text-base font-semibold"
            onClick={() => onApproval("decline")}
          >
            Decline
          </Button>
        </div>
      );
    } else if (key === "listening") {
      button = (
        <Button
          type="button"
          variant="outline"
          data-testid="ae-voice-action"
          className={cn(big, colours.outline)}
          disabled={!heard.trim() || !onSendNow}
          onClick={onSendNow}
        >
          Send now
        </Button>
      );
    } else if (key === "thinking" || key === "preparing") {
      button = (
        <Button
          type="button"
          variant="outline"
          data-testid="ae-voice-action"
          className={cn(big, "opacity-50")}
          aria-disabled="true"
          aria-label="Stop (nothing playing yet)"
          tabIndex={-1}
          onClick={(e) => e.preventDefault()}
        >
          Stop
        </Button>
      );
    } else if (key === "speaking") {
      button = (
        <Button
          type="button"
          data-testid="ae-voice-action"
          aria-label={actionLabel}
          className={cn(big, colours.solid)}
          onClick={onStop}
        >
          Stop
        </Button>
      );
    } else if (key === "blocked") {
      button = (
        <Button
          type="button"
          data-testid="ae-voice-action"
          aria-label={actionLabel}
          className={cn(big, colours.solid)}
          onClick={onResume}
        >
          Play the reply
        </Button>
      );
    } else if (restartable) {
      button = (
        <Button
          type="button"
          variant="outline"
          data-testid="ae-voice-action"
          aria-label={actionLabel}
          className={cn(big, colours.outline)}
          onClick={onRestartMic}
        >
          {tapToStart ? "Start the mic" : "Listen again"}
        </Button>
      );
    }
    const sheetSub =
      approvalPending && key !== "approval" ? `Waiting for your OK${sub ? `. ${sub}` : ""}` : sub;
    return (
      <div
        data-testid="ae-voice-panel"
        data-layout="sheet"
        data-phase={key}
        className={cn(
          "flex flex-col items-stretch gap-3 border-t-[3px] px-4 pt-3 pb-4",
          sheetBg,
          top,
          className,
        )}
      >
        <div className="flex h-11 items-center justify-between">
          {key === "listening" ? (
            <AeLevelBars active className={tone.text} />
          ) : (
            <span aria-hidden className="h-4" />
          )}
          <div className="flex items-center gap-2">
            {onKeyboard ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11 text-muted-foreground hover:text-foreground"
                aria-label="Type instead"
                onClick={onKeyboard}
              >
                <KeyboardIcon className="size-5" />
              </Button>
            ) : null}
            {endButton}
          </div>
        </div>
        <div className={cn("text-[30px] leading-tight font-bold", colours.word)}>
          {SHEET_LABEL[key] && !tapToStart ? SHEET_LABEL[key] : label}
        </div>
        <div className="min-h-10 line-clamp-2 text-sm text-muted-foreground">{sheetSub}</div>
        {button}
      </div>
    );
  }

  const hints = barHints(key, isMacPlatform(), !(cardPending || approvalActive));
  return (
    <div
      data-testid="ae-voice-panel"
      data-layout="bar"
      data-phase={key}
      className={cn(
        "@container mx-3 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2",
        tone.panel,
        className,
      )}
    >
      <AeLevelBars active={key === "listening"} className={tone.text} />
      <button
        type="button"
        aria-label={actionLabel}
        onClick={action}
        className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className={cn("truncate text-sm font-medium", tone.text)}>{label}</div>
        {sub ? (
          <div
            className={cn(
              "line-clamp-2 text-xs",
              strong ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {sub}
          </div>
        ) : null}
      </button>
      {hints.length > 0 ? (
        <div data-testid="ae-voice-hints" className="hidden items-center gap-2 @[560px]:flex">
          {hints.map((hint) => (
            <span key={hint.word} className="flex items-center gap-1">
              <span className="flex gap-0.5">
                {hint.keys.map((k) => (
                  <kbd
                    key={k}
                    className="rounded border border-border bg-background/60 px-1 font-mono text-[10px] text-muted-foreground"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
              <span className="text-[11px] text-muted-foreground">{hint.word}</span>
            </span>
          ))}
        </div>
      ) : null}
      {approvalPending && onApproval ? (
        <div
          data-testid="ae-voice-approval"
          className="relative z-10 order-last flex basis-full flex-wrap items-center justify-end gap-2 @[560px]:order-none @[560px]:basis-auto @[560px]:justify-center"
        >
          {key !== "approval" ? (
            <span className="text-xs font-medium text-amber-500">Waiting for your OK</span>
          ) : null}
          <Button
            type="button"
            size="sm"
            data-testid="ae-voice-approval-run"
            onClick={() => onApproval("accept")}
          >
            Run it
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="ae-voice-approval-decline"
            onClick={() => onApproval("decline")}
          >
            Decline
          </Button>
        </div>
      ) : null}
      {endButton}
    </div>
  );
}
