// What Voice mode is doing, on screen (omnigent-ae, 2026-11-10). A bar above the
// input on the desktop, a sheet that replaces the input on a phone. Flat: thin
// borders and the product's muted palette, no gradients or shadows.

import { KeyboardIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useMicLevel } from "@/lib/aeMicLevel";
import type { VoicePhase } from "@/lib/aeVoiceMode";
import { cn } from "@/lib/utils";

export type VoicePhaseKey =
  "starting" | "listening" | "paused" | "unavailable" | "thinking" | "speaking" | "blocked";

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
  /** Turn Voice mode off. */
  onEnd: () => void;
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
): { label: string; sub: string } {
  switch (key) {
    case "starting":
      return { label: "Starting the mic", sub: "" };
    case "listening":
      return { label: "Listening", sub: heard.trim() || "Say something" };
    case "paused":
      return { label: "Mic stopped", sub: "Tap the mic to listen again" };
    case "unavailable":
      return { label: "Mic unavailable", sub: micDetail || "Check the microphone permission" };
    case "thinking":
      return { label: "Working on it", sub: "Mic muted until the reply ends" };
    case "speaking":
      return { label: "Speaking, tap to stop", sub: caption };
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
  onEnd,
  onStop,
  onResume,
  onKeyboard,
  onRestartMic,
  micStartPath,
  className,
}: AeVoicePanelProps) {
  const level = useMicLevel();
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
  const tone = TONE[key];
  // A server start is a model cold start that can take 40 s; a tap there would only get in its way.
  const tapToStart =
    key === "starting" && startStuck && Boolean(onRestartMic) && micStartPath?.() === "browser";
  const { label, sub } = tapToStart
    ? { label: "Tap to start the mic", sub: "" }
    : words(key, heard, caption, micDetail);
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
    <Button type="button" variant="outline" size="sm" aria-label="End voice mode" onClick={onEnd}>
      End
    </Button>
  );

  if (layout === "sheet") {
    return (
      <div
        data-testid="ae-voice-panel"
        data-layout="sheet"
        data-phase={key}
        className={cn("flex flex-col items-center px-4 pt-5 pb-3 text-center", className)}
      >
        <div className={cn("text-sm font-medium", tone.text)}>{label}</div>
        <button
          type="button"
          aria-label={actionLabel}
          onClick={action}
          className="my-3 flex size-24 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            data-testid="ae-voice-ring"
            className={cn(
              "flex size-24 items-center justify-center rounded-full border",
              tone.ring,
            )}
            style={{
              transform: `scale(${1 + (key === "listening" ? level : 0) * 0.12})`,
              transition: "transform 80ms",
            }}
          >
            <span
              className={cn(
                "size-20 rounded-full",
                tone.disc,
                key === "thinking" && "animate-pulse",
              )}
            />
          </span>
        </button>
        <div className="min-h-10 line-clamp-2 text-sm text-muted-foreground">{sub}</div>
        <div className="mt-3 flex gap-3">
          {onKeyboard ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Type instead"
              onClick={onKeyboard}
            >
              <KeyboardIcon className="size-4" />
            </Button>
          ) : null}
          {endButton}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="ae-voice-panel"
      data-layout="bar"
      data-phase={key}
      className={cn(
        "mx-3 mt-3 flex items-center gap-3 rounded-lg border px-3 py-2",
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
        <div className={cn("text-sm font-medium", tone.text)}>{label}</div>
        {sub ? <div className="truncate text-xs text-muted-foreground">{sub}</div> : null}
      </button>
      {endButton}
    </div>
  );
}
