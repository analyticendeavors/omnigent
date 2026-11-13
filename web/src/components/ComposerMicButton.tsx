"use client";

import { Button } from "@/components/ui/button";
import { showToast } from "@/components/ui/toast";
import { useVoiceDictationHotkey } from "@/hooks/useVoiceDictationHotkey";
import { useServerInfo } from "@/lib/CapabilitiesContext";
import { getMicStream } from "@/lib/aeAudioDevices";
import { publishMicLevel, resetMicLevel } from "@/lib/aeMicLevel";
import { publishVoiceBins, resetVoiceBins } from "@/lib/aeVoiceLevel";
import { logVoice } from "@/lib/aeVoiceLog";
import { DictationBusyError, DictationSession } from "@/lib/dictation";
import { isElectronShell } from "@/lib/nativeBridge";
import { cn } from "@/lib/utils";
import { Loader2Icon, MicIcon, SquareIcon } from "lucide-react";
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import type { AeMicController } from "@/lib/aeVoiceMode";

// Local-only types; speech-input.tsx already augments Window globally.
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  removeEventListener: (type: string, listener: (event: Event) => void) => void;
}

interface SpeechRecognitionEventLike extends Event {
  results: {
    readonly length: number;
    [index: number]: {
      readonly length: number;
      [index: number]: { transcript: string };
      isFinal: boolean;
    };
  };
  resultIndex: number;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

const getRecognitionCtor = (): SpeechRecognitionCtor | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

const getDefaultDictationLang = (): string => {
  if (typeof navigator === "undefined") return "en-US";
  try {
    return navigator.language || "en-US";
  } catch {
    return "en-US";
  }
};

// FFT bin ranges per bar, weighted toward voice frequencies (~100Hz–3kHz).
const BAR_BINS: readonly (readonly [number, number])[] = [
  [1, 3],
  [3, 6],
  [6, 10],
  [10, 16],
];

const BAR_BASELINE = 0.2;
// A Voice mode Web Speech start that fires no start, end or error in this long is given up on.
// The first take of the page gets longer: a permission prompt or a slow Bluetooth route is not stuck.
const MIC_START_WATCHDOG_MS = 4000;
const MIC_FIRST_START_WATCHDOG_MS = 8000;
// A meter track that has stayed live this long earns its reacquire budget back.
const METER_STABLE_MS = 30_000;
const METER_MAX_REACQUIRES = 3;
const METER_RETRY_MS = 1000;
// A browser stop that gets no `end` in this long is given up on: the recognizer is replaced.
const MIC_STOP_WATCHDOG_MS = 4000;
// After a stop watchdog replaced the recognizer, a final result from the old one still counts this long.
const MIC_LATE_FINAL_MS = 1000;
// Voice mode liveness: a take that listens but hears nothing is replaced. Checked this often.
const MIC_LIVENESS_TICK_MS = 500;
// No audiostart, soundstart, speechstart or result this long after the take started (a slow
// Bluetooth route switch can take several seconds).
const MIC_NO_AUDIO_MS = 5000;
// The meter's deaf reasons only count once the recognizer itself showed no activity this long.
const MIC_RECOGNIZER_QUIET_MS = 6000;
// The meter's track stays muted this long.
const MIC_TRACK_MUTED_MS = 2000;
// The meter's AudioContext is not running, or its analyser reads all zeros, this long.
const MIC_METER_STALL_MS = 6000;
// The analyser is only believed while its animation frames keep arriving.
const MIC_METER_FRESH_MS = 1500;

export interface ComposerMicButtonProps {
  onTranscript: (text: string) => void;
  className?: string;
  /**
   * Streaming partial transcripts (server dictation only): called with the
   * revisable in-progress utterance as it forms, and with "" when the take
   * ends without finalizing it. Utterances that do finalize arrive via
   * onTranscript, which supersedes the pending interim. When absent, the
   * server path still works but only finals are inserted — the same
   * behavior the Web Speech path has always had.
   */
  onInterim?: (text: string) => void;
  disabled?: boolean;
  lang?: string;
  /** Bind the global ⌘⌥V dictation hotkey to this mic. Enable on exactly one
   *  mounted mic (the primary composer) so two don't fight for the device. */
  enableHotkey?: boolean;
  /** The hotkey runs this first; true means handled (Voice mode stopped a spoken reply). */
  onHotkeyBarge?: () => boolean;
  /** Fired when dictation begins. The parent should snapshot the composer text
   *  here so {@link onVoiceDiscard} can revert to it. */
  onVoiceStart?: () => void;
  /** Fired when Esc ends dictation. The parent should restore the text it
   *  snapshotted in {@link onVoiceStart}, discarding what was dictated. */
  onVoiceDiscard?: () => void;
  /** Voice mode: filled with start, stop and the listening state. */
  controller?: MutableRefObject<AeMicController | null>;
  /**
   * Voice mode: called when listening starts or stops. `reason` is "deaf" when the take was
   * listening but the mic went quiet (the recognizer was replaced); Voice mode retries once.
   */
  onListeningChange?: (listening: boolean, reason?: "deaf") => void;
}

/** getUserMedia permission failures, distinct from transport failures. */
const isPermissionError = (error: unknown): boolean =>
  error instanceof DOMException &&
  (error.name === "NotAllowedError" || error.name === "SecurityError");

export const ComposerMicButton = ({
  onTranscript,
  className,
  onInterim,
  disabled,
  lang = getDefaultDictationLang(),
  enableHotkey = false,
  onHotkeyBarge,
  onVoiceStart,
  onVoiceDiscard,
  controller,
  onListeningChange,
}: ComposerMicButtonProps) => {
  // Web Speech is primary whenever the browser has the constructor
  // (Chrome/Safari, unchanged behavior); with no constructor at all
  // (Firefox) takes use server dictation when GET /v1/info advertises it.
  // A constructor is no guarantee of a backend — Electron and plain
  // Chromium error at runtime with "network" — so a failed Web Speech
  // take falls back to the server per take (see handleError). Per-take,
  // not sticky: a transient blip in real Chrome must not permanently
  // downgrade the page to the local model.
  const [Ctor] = useState(getRecognitionCtor);
  const serverInfo = useServerInfo();
  const serverAvailable = serverInfo !== "loading" && serverInfo.dictation_available;
  // Mirrored into a ref so the mount-time recognition handlers (closed
  // over [Ctor, lang]) see the current probe result.
  const serverAvailableRef = useRef(serverAvailable);
  serverAvailableRef.current = serverAvailable;
  const [isListening, setIsListening] = useState(false);
  // Server-path only: the take has started but audio isn't flowing yet (the
  // first take cold-loads the model, up to ~40s). Shows a spinner so the click
  // isn't a dead-looking button until it flips to listening.
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const sessionRef = useRef<DictationSession | null>(null);
  // Refs so handlers aren't re-attached on every parent re-render.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onInterimRef = useRef(onInterim);
  onInterimRef.current = onInterim;
  // Voice mode: a start asked for but not yet listening, and a stop that arrived meanwhile.
  const requestedRef = useRef(false);
  const withdrawRef = useRef(false);
  // Set by the controller's start so the server start knows the withdraw flag is its own.
  const controllerStartRef = useRef(false);
  const onListeningChangeRef = useRef(onListeningChange);
  onListeningChangeRef.current = onListeningChange;
  // Synced refs so the mount-time listeners call the latest callbacks.
  const onVoiceStartRef = useRef(onVoiceStart);
  onVoiceStartRef.current = onVoiceStart;
  const onVoiceDiscardRef = useRef(onVoiceDiscard);
  onVoiceDiscardRef.current = onVoiceDiscard;
  // Set by the Esc handler so late results after a discard don't repopulate the
  // composer the parent just reverted. Cleared on the next start.
  const discardingRef = useRef(false);
  // Synced prop ref so the recognition result handler (closure over the
  // mount-time effect) can drop late events when the composer goes
  // disabled mid-utterance.
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  // Click guard: true between toggle() and the matching start/end event.
  // Prevents rapid double-clicks from calling recognition.start() twice,
  // which throws InvalidStateError in Chrome.
  const transitionRef = useRef(false);
  // Browser-path start bookkeeping for Voice mode: whether the current take ever fired
  // `start`, whether a Web Speech start is still waiting on its first event, the watchdog
  // that gives up on it, and an `end` still owed by a recognizer we aborted ourselves.
  const startSeenRef = useRef(false);
  const browserStartPendingRef = useRef(false);
  const startWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Browser stop: the watchdog that replaces a recognizer whose `end` never came.
  const stopWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Voice mode take liveness (browser path): the take was started by Voice mode, the interval
  // that checks it, and what this take has shown so far.
  const voiceTakeRef = useRef(false);
  const livenessTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const takeStartRef = useRef(0);
  const audioStartSeenRef = useRef(false);
  // When the recognizer last showed any life (audiostart, soundstart, speechstart, a result),
  // and whether it ever heard sound or produced a result this take.
  const lastRecognizerActivityRef = useRef(0);
  const recognizerSoundSeenRef = useRef(false);
  // A result arrived since the last stop(): the stop watchdog waits instead of replacing.
  const resultSinceStopRef = useRef(false);
  // Written by the meter: since when its track is muted, its context stalled, its analyser
  // all zeros, and when its last frame ran. null means "not so".
  const meterMutedSinceRef = useRef<number | null>(null);
  const ctxStallSinceRef = useRef<number | null>(null);
  const silentSinceRef = useRef<number | null>(null);
  const meterTickRef = useRef(0);
  // The next listening change was made by us (a deaf replace or a forced restart): Voice mode
  // was told another way, or needs no word.
  const quietStopRef = useRef(false);
  const armLivenessRef = useRef<() => void>(() => {});
  const listeningRef = useRef(false);
  // Mic permission as the Permissions API reports it; "unknown" when it cannot say.
  const permissionRef = useRef<"granted" | "other" | "unknown">("unknown");
  // True once any take on this page fired `start` (the first take gets the longer window).
  const startedOnceRef = useRef(false);
  const permissionWatchedRef = useRef(false);
  // Which path the controller's start would take right now.
  const pathRef = useRef<"browser" | "server">("browser");
  pathRef.current = !Ctor || (serverAvailable && isElectronShell()) ? "server" : "browser";
  // Swaps the recognizer for a fresh one (set by the mount effect).
  const replaceRecognitionRef = useRef<(keepLateFinal?: boolean) => void>(() => {});
  const clearStartWatchdog = useCallback(() => {
    if (startWatchdogRef.current !== null) clearTimeout(startWatchdogRef.current);
    startWatchdogRef.current = null;
    browserStartPendingRef.current = false;
  }, []);
  const clearStopWatchdog = useCallback(() => {
    if (stopWatchdogRef.current !== null) clearTimeout(stopWatchdogRef.current);
    stopWatchdogRef.current = null;
  }, []);
  const clearLiveness = useCallback(() => {
    if (livenessTimerRef.current !== null) clearInterval(livenessTimerRef.current);
    livenessTimerRef.current = null;
  }, []);
  // Server-take guard, deliberately separate from transitionRef: a failed
  // Web Speech attempt fires a late "end" event that resets transitionRef,
  // which must not unlock a second server take mid-handshake.
  const serverBusyRef = useRef(false);
  // Lets the mount-time Web Speech error handler start the fallback take
  // without closing over toggleServer's identity.
  const toggleServerRef = useRef<() => Promise<void>>(async () => {});
  // Latest server partial for the current take, so a crash can preserve what
  // was spoken instead of blanking it. Set on each partial, cleared on final,
  // and reset when a take starts so a stale partial can't resurrect.
  const interimRef = useRef("");

  // Surface a failure both in the button (tooltip + red tint) and as a toast,
  // so a failed take is an explained error rather than a silent flash back to
  // the idle mic. Stable identity: only setError/showToast, both stable.
  const reportError = useCallback((message: string) => {
    setError(message);
    showToast(message);
  }, []);

  // Written via .style.transform from rAF — avoids 60Hz React re-renders.
  const barRefs = useRef<(HTMLSpanElement | null)[]>(BAR_BINS.map(() => null));

  useEffect(() => {
    if (!Ctor) return;

    // A dead recognizer keeps firing start/end/error after the take has
    // fallen back to the server; those stale events must not clobber the
    // server session's isListening/transition state.
    const serverTakeOwnsState = () => sessionRef.current !== null || serverBusyRef.current;

    // Each recognizer is one generation. A discarded one (restart, watchdog) is detached
    // and its events are ignored entirely: no watchdog clear, no report, no flag change.
    const detachers = new Map<SpeechRecognitionLike, () => void>();

    // Tells Voice mode a start never reached listening, at most once per take.
    const failPendingStart = (reason?: "deaf") => {
      if (!requestedRef.current) return;
      requestedRef.current = false;
      controllerStartRef.current = false;
      if (reason) onListeningChangeRef.current?.(false, reason);
      else onListeningChangeRef.current?.(false);
    };

    // The take is listening but the mic is deaf: swap the recognizer and tell Voice mode the
    // take failed, so it retries once and then shows a mic it can restart by tap.
    const reportDeaf = (reason: string) => {
      logVoice("mic deaf", reason);
      clearLiveness();
      clearStartWatchdog();
      clearStopWatchdog();
      voiceTakeRef.current = false;
      replace();
      transitionRef.current = false;
      listeningRef.current = false;
      quietStopRef.current = true;
      setIsListening(false);
      requestedRef.current = true;
      failPendingStart("deaf");
    };

    const checkLiveness = () => {
      if (!voiceTakeRef.current || !listeningRef.current) return;
      const now = Date.now();
      // Recognizer activity first: no audiostart counts only when nothing else showed life.
      if (
        !audioStartSeenRef.current &&
        !recognizerSoundSeenRef.current &&
        now - takeStartRef.current >= MIC_NO_AUDIO_MS
      ) {
        reportDeaf("no audiostart");
        return;
      }
      // The meter never decides alone: it counts only after the recognizer itself has shown
      // no activity for a while (an early soundstart does not switch the checks off for good).
      if (now - lastRecognizerActivityRef.current < MIC_RECOGNIZER_QUIET_MS) return;
      const muted = meterMutedSinceRef.current;
      if (muted !== null && now - muted >= MIC_TRACK_MUTED_MS) {
        reportDeaf("track muted");
        return;
      }
      const stall = ctxStallSinceRef.current;
      if (stall !== null && now - stall >= MIC_METER_STALL_MS) {
        reportDeaf("context not running");
        return;
      }
      const silent = silentSinceRef.current;
      if (
        silent !== null &&
        now - silent >= MIC_METER_STALL_MS &&
        now - meterTickRef.current <= MIC_METER_FRESH_MS
      ) {
        reportDeaf("analyser silent");
      }
    };

    // Armed once a Voice mode take has started and the mic permission is not in doubt.
    const armLiveness = () => {
      if (!voiceTakeRef.current || livenessTimerRef.current !== null) return;
      if (permissionRef.current === "other") {
        logVoice("mic liveness skipped", "permission");
        return;
      }
      takeStartRef.current = Date.now();
      lastRecognizerActivityRef.current = takeStartRef.current;
      livenessTimerRef.current = setInterval(checkLiveness, MIC_LIVENESS_TICK_MS);
    };
    armLivenessRef.current = armLiveness;

    const build = (): SpeechRecognitionLike => {
      const recognition = new Ctor();
      // Keep listening until the user clicks stop — no auto-stop on silence.
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = lang;
      const current = () => recognitionRef.current === recognition;

      const handleStart = () => {
        if (!current() || serverTakeOwnsState()) return;
        logVoice("mic event start");
        startSeenRef.current = true;
        startedOnceRef.current = true;
        quietStopRef.current = false;
        clearStartWatchdog();
        armLiveness();
        transitionRef.current = false;
        discardingRef.current = false;
        setError(null);
        setIsListening(true);
        // Snapshot point: let the parent record the text so Esc can revert to it.
        onVoiceStartRef.current?.();
      };
      const handleEnd = () => {
        if (!current() || serverTakeOwnsState()) return;
        logVoice("mic event end");
        clearStartWatchdog();
        clearStopWatchdog();
        clearLiveness();
        voiceTakeRef.current = false;
        transitionRef.current = false;
        if (requestedRef.current && !startSeenRef.current) {
          // The recognizer ended without ever starting (a Bluetooth route change on iOS):
          // say so now, so Voice mode retries instead of waiting out its backstop.
          logVoice("mic ended before start");
          failPendingStart();
        }
        setIsListening(false);
      };
      const handleError = (event: Event) => {
        if (!current() || serverTakeOwnsState()) return;
        clearStartWatchdog();
        clearStopWatchdog();
        clearLiveness();
        voiceTakeRef.current = false;
        transitionRef.current = false;
        // Only a start still waiting is reported here; a live take's end is reported by
        // the listening effect, so the hook never sees two false answers for one take.
        failPendingStart();
        const err = (event as SpeechRecognitionErrorEventLike).error;
        logVoice("mic error", String(err));
        // "network" means the recognizer's cloud backend refused us —
        // always the case in Electron/plain Chromium, occasionally a
        // transient blip in real Chrome. Serve THIS take from the server
        // instead; the next take tries Web Speech again.
        if (err === "network" && serverAvailableRef.current && !disabledRef.current) {
          logVoice("mic server fallback");
          setIsListening(false);
          void toggleServerRef.current();
          return;
        }
        // "no-speech" / "aborted" are routine (silence timeout, user stop).
        if (err === "not-allowed" || err === "service-not-allowed") {
          reportError("Microphone access denied. Allow access and try again.");
        } else if (err && err !== "no-speech" && err !== "aborted") {
          reportError("Voice input isn't available on this device.");
        }
        setIsListening(false);
      };
      const handleAudioStart = () => {
        if (!current()) return;
        logVoice("mic event audiostart");
        audioStartSeenRef.current = true;
        lastRecognizerActivityRef.current = Date.now();
      };
      const handleSoundStart = () => {
        if (!current()) return;
        logVoice("mic event soundstart");
        recognizerSoundSeenRef.current = true;
        lastRecognizerActivityRef.current = Date.now();
      };
      const handleSpeechStart = () => {
        if (!current()) return;
        logVoice("mic event speechstart");
        recognizerSoundSeenRef.current = true;
        lastRecognizerActivityRef.current = Date.now();
      };
      const handleAudioEnd = () => {
        if (!current()) return;
        logVoice("mic event audioend");
      };
      const handleResult = (event: Event) => {
        if (!current()) return;
        recognizerSoundSeenRef.current = true;
        resultSinceStopRef.current = true;
        lastRecognizerActivityRef.current = Date.now();
        // Drop late events that arrive after the composer went disabled, or after
        // an Esc discard the parent has already reverted.
        if (disabledRef.current || discardingRef.current) return;
        const speechEvent = event as SpeechRecognitionEventLike;
        let finalTranscript = "";
        for (let i = speechEvent.resultIndex; i < speechEvent.results.length; i += 1) {
          const result = speechEvent.results[i];
          if (result.isFinal) {
            finalTranscript += result[0]?.transcript ?? "";
          }
        }
        const trimmed = finalTranscript.trim();
        if (trimmed) onTranscriptRef.current(trimmed);
      };

      recognition.addEventListener("start", handleStart);
      recognition.addEventListener("end", handleEnd);
      recognition.addEventListener("error", handleError);
      recognition.addEventListener("result", handleResult);
      recognition.addEventListener("audiostart", handleAudioStart);
      recognition.addEventListener("soundstart", handleSoundStart);
      recognition.addEventListener("speechstart", handleSpeechStart);
      recognition.addEventListener("audioend", handleAudioEnd);
      detachers.set(recognition, () => {
        recognition.removeEventListener("start", handleStart);
        recognition.removeEventListener("end", handleEnd);
        recognition.removeEventListener("error", handleError);
        recognition.removeEventListener("result", handleResult);
        recognition.removeEventListener("audiostart", handleAudioStart);
        recognition.removeEventListener("soundstart", handleSoundStart);
        recognition.removeEventListener("speechstart", handleSpeechStart);
        recognition.removeEventListener("audioend", handleAudioEnd);
      });
      return recognition;
    };

    // WebKit stays in Aborting until the old recognizer's end, so start() on it throws.
    // A new instance can start inside the same tap: discard the old one, abort it, build anew.
    // `keepLateFinal` (the stop watchdog): the old recognizer was already stopped, so it is
    // not aborted, and a final result it still delivers within a second is passed on once.
    const replace = (keepLateFinal = false) => {
      clearLiveness();
      clearStopWatchdog();
      const old = recognitionRef.current;
      if (old) {
        detachers.get(old)?.();
        detachers.delete(old);
        if (keepLateFinal) {
          let lateDone = false;
          const onLate = (event: Event) => {
            if (lateDone) return;
            const speechEvent = event as SpeechRecognitionEventLike;
            let finalTranscript = "";
            for (let i = speechEvent.resultIndex; i < speechEvent.results.length; i += 1) {
              const result = speechEvent.results[i];
              if (result.isFinal) finalTranscript += result[0]?.transcript ?? "";
            }
            const trimmed = finalTranscript.trim();
            if (!trimmed) return;
            lateDone = true;
            old.removeEventListener("result", onLate);
            clearTimeout(lateTimer);
            if (!disabledRef.current && !discardingRef.current) {
              logVoice("mic late final delivered");
              onTranscriptRef.current(trimmed);
            }
          };
          const lateTimer = setTimeout(() => {
            lateDone = true;
            old.removeEventListener("result", onLate);
          }, MIC_LATE_FINAL_MS);
          old.addEventListener("result", onLate);
        } else {
          try {
            old.abort();
          } catch {
            // Nothing to abort.
          }
        }
      }
      recognitionRef.current = build();
    };

    recognitionRef.current = build();
    replaceRecognitionRef.current = replace;

    return () => {
      const old = recognitionRef.current;
      if (old) {
        detachers.get(old)?.();
        detachers.delete(old);
        old.stop();
      }
      recognitionRef.current = null;
      replaceRecognitionRef.current = () => {};
    };
  }, [Ctor, lang, reportError, clearStartWatchdog, clearStopWatchdog, clearLiveness]);

  // Auto-stop if the composer goes disabled mid-dictation. Stops the
  // recognizer; the disabledRef guard in handleResult catches any final
  // events still queued before the end event fires. A server session is
  // cancelled outright (no tail flush) — the take is moot once the
  // composer can't accept text.
  useEffect(() => {
    if (!(disabled && isListening)) return;
    if (sessionRef.current) {
      sessionRef.current.cancel();
      sessionRef.current = null;
      setIsListening(false);
      onInterimRef.current?.("");
      return;
    }
    try {
      recognitionRef.current?.stop();
    } catch {
      // .stop() on an already-stopped recognizer can throw in some
      // browsers; safe to ignore — the end event will reconcile state.
    }
  }, [disabled, isListening]);

  // Release the mic if the component unmounts mid-take (e.g. the
  // new-chat dialog closes while dictating).
  useEffect(
    () => () => {
      sessionRef.current?.cancel();
      sessionRef.current = null;
      if (startWatchdogRef.current !== null) clearTimeout(startWatchdogRef.current);
      if (stopWatchdogRef.current !== null) clearTimeout(stopWatchdogRef.current);
      if (livenessTimerRef.current !== null) clearInterval(livenessTimerRef.current);
    },
    [],
  );

  // Second getUserMedia stream just for visualization — Web Speech API
  // hides its audio buffer. Chrome batches the permission to one prompt.
  useEffect(() => {
    if (!isListening) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let rafId: number | null = null;
    // Snapshot so cleanup doesn't read a stale .current (exhaustive-deps).
    const bars = barRefs.current;

    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let reacquires = 0;
    let reacquiring = false;
    let stableTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const resumeCtx = () => {
      try {
        void Promise.resolve(audioCtx?.resume?.()).catch(() => {});
      } catch {
        // Resuming is best effort.
      }
    };

    const connect = (next: MediaStream) => {
      stream = next;
      if (!audioCtx || !analyser) return;
      source = audioCtx.createMediaStreamSource(next);
      source.connect(analyser);
      for (const track of next.getTracks()) {
        track.addEventListener?.("ended", onTrackEnded);
        track.addEventListener?.("mute", onTrackMute);
        track.addEventListener?.("unmute", onTrackUnmute);
        if (track.muted) {
          logVoice("meter track mute", "at connect");
          if (meterMutedSinceRef.current === null) meterMutedSinceRef.current = Date.now();
        }
      }
      // A track that stays live for a while earns the reacquire budget back.
      if (stableTimer !== null) clearTimeout(stableTimer);
      stableTimer = setTimeout(() => {
        stableTimer = null;
        reacquires = 0;
      }, METER_STABLE_MS);
    };

    // A muted track delivers silence: Voice mode's liveness check decides if it stays that way.
    const onTrackMute = () => {
      if (cancelled) return;
      logVoice("meter track mute");
      if (meterMutedSinceRef.current === null) meterMutedSinceRef.current = Date.now();
    };
    const onTrackUnmute = () => {
      if (cancelled) return;
      logVoice("meter track unmute");
      meterMutedSinceRef.current = null;
    };

    // The route changed under the stream (Bluetooth, a call): take a fresh one.
    const onTrackEnded = () => {
      if (cancelled || reacquiring) return;
      logVoice("meter track ended");
      meterMutedSinceRef.current = null;
      if (stableTimer !== null) clearTimeout(stableTimer);
      stableTimer = null;
      if (reacquires >= METER_MAX_REACQUIRES) return;
      reacquires += 1;
      reacquiring = true;
      const old = stream;
      try {
        source?.disconnect();
      } catch {
        // Already disconnected.
      }
      if (old) for (const track of old.getTracks()) track.stop();
      const attach = (next: MediaStream) => {
        reacquiring = false;
        if (cancelled) {
          for (const track of next.getTracks()) track.stop();
          return;
        }
        logVoice("meter re-acquired");
        connect(next);
        resumeCtx();
      };
      const fail = (err: unknown) => {
        logVoice("meter mic failed", String((err as { name?: string } | null)?.name));
      };
      void getMicStream(true)
        .then(attach)
        .catch((err: unknown) => {
          fail(err);
          // One more try after a second: the route is often still settling.
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (cancelled) {
              reacquiring = false;
              return;
            }
            void getMicStream(true)
              .then(attach)
              .catch((err2: unknown) => {
                reacquiring = false;
                fail(err2);
              });
          }, METER_RETRY_MS);
        });
    };

    const start = async () => {
      let first: MediaStream;
      try {
        first = await getMicStream(true);
      } catch (err) {
        // Mic permission denied just for the visualization stream: leave the bars at
        // baseline. The speech recognition error handler surfaces the user-facing message.
        logVoice("meter mic failed", String((err as { name?: string } | null)?.name));
        return;
      }
      if (cancelled) {
        for (const track of first.getTracks()) track.stop();
        return;
      }
      audioCtx = new AudioContext();
      logVoice("meter ctx", String(audioCtx.state));
      const ctx = audioCtx;
      const noteCtx = () => {
        if (ctx.state === "running") ctxStallSinceRef.current = null;
        else if (ctxStallSinceRef.current === null) ctxStallSinceRef.current = Date.now();
      };
      noteCtx();
      // iOS starts (or later parks) the context suspended or interrupted; wake it.
      ctx.addEventListener?.("statechange", () => {
        logVoice("meter ctx", String(ctx.state));
        noteCtx();
        if (!cancelled && (ctx.state === "suspended" || (ctx.state as string) === "interrupted")) {
          resumeCtx();
        }
      });
      resumeCtx();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      // Built-in temporal smoothing so bars don't jitter frame-to-frame.
      analyser.smoothingTimeConstant = 0.75;
      connect(first);
      const node = analyser;
      const data = new Uint8Array(node.frequencyBinCount);

      const tick = () => {
        node.getByteFrequencyData(data);
        let signal = false;
        for (let i = 0; i < data.length; i += 1) {
          if (data[i] > 0) {
            signal = true;
            break;
          }
        }
        const frameAt = Date.now();
        meterTickRef.current = frameAt;
        if (signal) silentSinceRef.current = null;
        else if (silentSinceRef.current === null) silentSinceRef.current = frameAt;
        let total = 0;
        for (let i = 0; i < BAR_BINS.length; i += 1) {
          const [lo, hi] = BAR_BINS[i];
          let sum = 0;
          for (let j = lo; j < hi; j += 1) sum += data[j];
          const avg = sum / (hi - lo) / 255;
          total += avg;
          // 1.6x headroom for quiet speech; clamp at 1 to fit the button.
          const scale = Math.max(BAR_BASELINE, Math.min(1, avg * 1.6));
          const el = bars[i];
          if (el) el.style.transform = `scaleY(${scale})`;
        }
        publishMicLevel((total / BAR_BINS.length) * 1.6);
        publishVoiceBins(data);
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    };

    start();

    return () => {
      cancelled = true;
      meterMutedSinceRef.current = null;
      ctxStallSinceRef.current = null;
      silentSinceRef.current = null;
      meterTickRef.current = 0;
      if (stableTimer !== null) clearTimeout(stableTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
      resetMicLevel();
      resetVoiceBins();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
      }
      if (audioCtx && audioCtx.state !== "closed") {
        audioCtx.close();
      }
      // Reset for the next session.
      for (const el of bars) {
        if (el) el.style.transform = `scaleY(${BAR_BASELINE})`;
      }
    };
  }, [isListening]);

  // Server-dictation toggle. Start resolves only once the mic + socket
  // handshake are up, so isListening flips exactly when audio flows.
  const toggleServer = useCallback(async () => {
    if (serverBusyRef.current) return;
    serverBusyRef.current = true;
    const session = sessionRef.current;
    if (session) {
      sessionRef.current = null;
      const tail = (await session.stop()).trim();
      if (!disabledRef.current) {
        // A non-empty tail supersedes the pending interim via
        // onTranscript; an empty one just clears the interim region.
        if (tail) onTranscriptRef.current(tail);
        else onInterimRef.current?.("");
      }
      setIsListening(false);
      serverBusyRef.current = false;
      return;
    }
    logVoice("mic start server");
    try {
      // Snapshot point: let the parent record the text so Esc can revert to it.
      discardingRef.current = false;
      // A manual click or the shortcut owns this start: a withdraw left over from an
      // earlier Voice mode start must not cancel it.
      if (!controllerStartRef.current) withdrawRef.current = false;
      controllerStartRef.current = false;
      interimRef.current = "";
      setConnecting(true);
      onVoiceStartRef.current?.();
      const next = await DictationSession.start({
        onPartial: (text) => {
          // Drop late partials after an Esc discard — they'd repopulate the
          // composer the parent just reverted.
          if (!disabledRef.current && !discardingRef.current) {
            interimRef.current = text;
            onInterimRef.current?.(text);
          }
        },
        onFinal: (text) => {
          interimRef.current = "";
          const trimmed = text.trim();
          if (trimmed && !disabledRef.current && !discardingRef.current) {
            onTranscriptRef.current(trimmed);
          }
        },
        onError: () => {
          sessionRef.current = null;
          // Preserve anything spoken but not yet finalized: pin the pending
          // partial as a final rather than blanking it, so a crash mid-take
          // doesn't discard the user's words.
          const pending = interimRef.current.trim();
          interimRef.current = "";
          if (pending && !disabledRef.current && !discardingRef.current) {
            onTranscriptRef.current(pending);
          } else {
            onInterimRef.current?.("");
          }
          reportError("Voice input failed. Please try again.");
          setIsListening(false);
          requestedRef.current = false;
        },
      });
      if (withdrawRef.current) {
        // Voice mode stopped the mic while it was still connecting: drop the stream at once.
        withdrawRef.current = false;
        next.cancel();
        setIsListening(false);
      } else {
        sessionRef.current = next;
        setError(null);
        setIsListening(true);
      }
    } catch (startError) {
      logVoice("mic error", `${(startError as Error)?.name}: ${(startError as Error)?.message}`);
      requestedRef.current = false;
      onListeningChangeRef.current?.(false);
      reportError(
        startError instanceof DictationBusyError
          ? "Voice input is busy. Please try again shortly."
          : isPermissionError(startError)
            ? "Microphone access denied. Allow access and try again."
            : "Voice input isn't available on this device.",
      );
      setIsListening(false);
    }
    // Reached only by the start path (the stop branch returns earlier), so this
    // clears the handshake spinner on both success and failure.
    setConnecting(false);
    withdrawRef.current = false;
    serverBusyRef.current = false;
  }, [reportError]);
  toggleServerRef.current = toggleServer;

  // A browser stop that gets no `end`: swap the recognizer and call the take over.
  const armStopWatchdog = useCallback(
    (extended = false): void => {
      clearStopWatchdog();
      resultSinceStopRef.current = false;
      stopWatchdogRef.current = setTimeout(() => {
        stopWatchdogRef.current = null;
        // A result since the stop means the recognizer is still delivering: give it one more
        // window instead of replacing it under a final that is on its way.
        if (resultSinceStopRef.current && !extended) {
          logVoice("mic stop watchdog", "result seen, waiting");
          armStopWatchdog(true);
          return;
        }
        logVoice("mic stop watchdog");
        clearLiveness();
        voiceTakeRef.current = false;
        replaceRecognitionRef.current(true);
        transitionRef.current = false;
        listeningRef.current = false;
        setIsListening(false);
      }, MIC_STOP_WATCHDOG_MS);
    },
    [clearStopWatchdog, clearLiveness],
  );

  // Returns whether anything began: false when a guard turned the call away.
  const toggle = useCallback((): boolean => {
    // An active (or starting) server take is owned by the server path,
    // whichever mode started it.
    if (sessionRef.current || serverBusyRef.current) {
      const busy = serverBusyRef.current;
      void toggleServer();
      return !busy;
    }
    // In Electron the SpeechRecognition constructor exists but has no backend,
    // so a Web Speech take always fails with "network" and only THEN falls back
    // to the server — a visible ~1s "fail then recover" on every first take.
    // When the server can serve, go straight to it and skip the doomed attempt.
    // (Real browsers keep Web Speech primary; it genuinely works there.)
    if (pathRef.current === "server") {
      if (!serverAvailable) return false;
      void toggleServer();
      return true;
    }
    // Guard against rapid clicks landing before start/end event fires.
    if (transitionRef.current) {
      if (listeningRef.current) logVoice("mic stop refused");
      return false;
    }
    const recognition = recognitionRef.current;
    if (!recognition) return false;
    transitionRef.current = true;
    // The Web Speech path has no server start to consume the controller's flag.
    controllerStartRef.current = false;
    try {
      if (listeningRef.current) {
        logVoice("mic stop");
        recognition.stop();
        armStopWatchdog();
      } else {
        logVoice("mic start browser");
        startSeenRef.current = false;
        audioStartSeenRef.current = false;
        recognizerSoundSeenRef.current = false;
        lastRecognizerActivityRef.current = 0;
        browserStartPendingRef.current = true;
        recognition.start();
      }
    } catch {
      // InvalidStateError from a double-call — drop the guard so the
      // user can try again, and let the next event reconcile state.
      transitionRef.current = false;
      browserStartPendingRef.current = false;
      return false;
    }
    return true;
  }, [serverAvailable, toggleServer, armStopWatchdog]);

  // Voice mode drives the mic through this handle; the button keeps working alone.
  listeningRef.current = isListening;
  useEffect(() => {
    if (!controller) return;
    // Reads the mic permission once per page, and keeps it current. The query is not
    // supported everywhere (older iOS Safari); then the state stays "unknown".
    const watchPermission = () => {
      if (permissionWatchedRef.current) return;
      permissionWatchedRef.current = true;
      try {
        const query = navigator.permissions?.query?.({ name: "microphone" as PermissionName });
        void Promise.resolve(query)
          .then((status) => {
            if (!status) return;
            const apply = () => {
              permissionRef.current = status.state === "granted" ? "granted" : "other";
              // A prompt just answered: the recognizer gets a fresh window to start.
              if (
                status.state === "granted" &&
                browserStartPendingRef.current &&
                !startSeenRef.current
              ) {
                armWatchdog();
              }
              // A take already listening on a prompt now answered gets its liveness check.
              if (status.state === "granted" && listeningRef.current) armLivenessRef.current();
            };
            apply();
            status.addEventListener?.("change", apply);
          })
          .catch(() => {});
      } catch {
        // Unsupported: the state stays "unknown".
      }
    };

    // A Web Speech start that never answers (no start, end or error) is given up on, so
    // Voice mode retries. Not while the permission prompt may be open, and not before the
    // permission is known to be granted (unknown counts as granted once a take has started).
    const armWatchdog = () => {
      if (startWatchdogRef.current !== null) clearTimeout(startWatchdogRef.current);
      const windowMs = startedOnceRef.current ? MIC_START_WATCHDOG_MS : MIC_FIRST_START_WATCHDOG_MS;
      startWatchdogRef.current = setTimeout(() => {
        startWatchdogRef.current = null;
        if (!browserStartPendingRef.current || startSeenRef.current) return;
        const permission = permissionRef.current;
        if (permission !== "granted" && !(permission === "unknown" && startedOnceRef.current)) {
          // Possibly a permission prompt; its answer re-arms the watchdog.
          logVoice("mic start watchdog skipped", permission);
          return;
        }
        browserStartPendingRef.current = false;
        logVoice("mic start watchdog");
        // A fresh recognizer, so the retry's start() is not refused by one still aborting.
        replaceRecognitionRef.current();
        transitionRef.current = false;
        if (requestedRef.current) {
          requestedRef.current = false;
          controllerStartRef.current = false;
          onListeningChangeRef.current?.(false);
        }
      }, windowMs);
    };

    const start = () => {
      if (listeningRef.current || requestedRef.current) return;
      requestedRef.current = true;
      controllerStartRef.current = true;
      if (toggle()) {
        // A new start replaces any earlier withdrawn one.
        withdrawRef.current = false;
        voiceTakeRef.current = true;
        if (browserStartPendingRef.current) {
          watchPermission();
          armWatchdog();
        }
      } else {
        // Nothing began (a start still connecting, a guard): say so, so Voice mode retries.
        requestedRef.current = false;
        controllerStartRef.current = false;
        onListeningChangeRef.current?.(false);
      }
    };
    controller.current = {
      start,
      startPath: () => (serverBusyRef.current || sessionRef.current ? "server" : pathRef.current),
      // A tap on a stuck "starting": discard the pending browser start, then start again
      // inside the tap. A server start still connecting is never withdrawn: it is healthy.
      restart: () => {
        if (serverBusyRef.current || sessionRef.current) return;
        if (listeningRef.current && pathRef.current !== "browser") return;
        if (pathRef.current === "browser") {
          logVoice("mic restart", listeningRef.current ? "while listening" : undefined);
          clearStartWatchdog();
          clearStopWatchdog();
          clearLiveness();
          requestedRef.current = false;
          controllerStartRef.current = false;
          transitionRef.current = false;
          startSeenRef.current = false;
          if (listeningRef.current) {
            // A take that says it listens may be deaf: drop it, and start a new one below.
            listeningRef.current = false;
            quietStopRef.current = true;
            setIsListening(false);
          }
          // WebKit refuses start() on a recognizer still aborting: use a new one.
          replaceRecognitionRef.current();
        }
        start();
      },
      stop: () => {
        voiceTakeRef.current = false;
        clearLiveness();
        if (listeningRef.current) {
          requestedRef.current = false;
          toggle();
        } else if (requestedRef.current) {
          // Still connecting: cancel the start, or drop the stream the moment it connects.
          requestedRef.current = false;
          clearStartWatchdog();
          // Only a server start still connecting needs the flag; nothing clears it otherwise.
          if (serverBusyRef.current) withdrawRef.current = true;
          try {
            recognitionRef.current?.stop();
          } catch {
            // Not started yet; nothing to stop.
          }
        }
      },
      isListening: () => listeningRef.current,
    };
    return () => {
      controller.current = null;
    };
  }, [controller, toggle, clearStartWatchdog, clearStopWatchdog, clearLiveness]);
  const prevListening = useRef(isListening);
  useEffect(() => {
    if (isListening) requestedRef.current = false;
    if (prevListening.current === isListening) return;
    prevListening.current = isListening;
    logVoice(isListening ? "mic listening" : "mic stopped");
    if (!isListening && quietStopRef.current) {
      // Our own replace: Voice mode was told (a deaf take) or restarts the mic itself.
      quietStopRef.current = false;
      return;
    }
    onListeningChangeRef.current?.(isListening);
  }, [isListening]);

  // ⌘⌥V toggles dictation from anywhere — same as clicking the button. Enabled
  // whenever dictation could run (Web Speech OR the server path) and the
  // composer isn't disabled, so the chord is inert when it can't do anything.
  useVoiceDictationHotkey(
    toggle,
    enableHotkey && (Boolean(Ctor) || serverAvailable) && !disabled,
    undefined,
    onHotkeyBarge,
  );

  // While listening, Enter commits (end the take, keep the text) and Esc
  // cancels (end the take, discard back to the pre-dictation snapshot). Bound in
  // the capture phase so it preempts the composer's own Enter-sends / Esc-stops.
  // Path-aware: a live server take is torn down via the DictationSession, a Web
  // Speech take via the recognizer.
  useEffect(() => {
    if (!isListening) return;
    const handler = (e: globalThis.KeyboardEvent): void => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter" && !e.shiftKey) {
        // Commit: end the take and keep the text. toggle() routes to the right
        // path — Web Speech stop, or a server stop that flushes the tail.
        e.preventDefault();
        e.stopPropagation();
        toggle();
      } else if (e.key === "Escape") {
        // Cancel: flag the discard so trailing results are dropped, revert the
        // composer, then tear the take down immediately (no tail flush).
        e.preventDefault();
        e.stopPropagation();
        discardingRef.current = true;
        onVoiceDiscardRef.current?.();
        const session = sessionRef.current;
        if (session) {
          sessionRef.current = null;
          serverBusyRef.current = false;
          session.cancel();
          setIsListening(false);
        } else {
          try {
            recognitionRef.current?.stop();
          } catch {
            // Already stopping — the end event will reconcile state.
          }
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [isListening, toggle]);

  if (!Ctor && !serverAvailable) return null;

  // Stable accessible name with aria-pressed signals toggle state to
  // screen readers. Error text takes over the tooltip when set.
  const a11yLabel = "Voice dictation";
  const tooltip = error ?? (connecting ? "Starting voice input…" : a11yLabel);

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      disabled={disabled}
      onClick={toggle}
      aria-pressed={isListening}
      aria-busy={connecting}
      aria-label={a11yLabel}
      title={tooltip}
      className={cn(
        "size-9 md:size-8",
        isListening &&
          "bg-muted/60 text-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive",
        error && "text-destructive",
        className,
      )}
    >
      {connecting ? (
        <Loader2Icon className="size-4 animate-spin" data-icon-size="16" aria-hidden />
      ) : isListening ? (
        // Bars fade out and stop icon fades in on hover OR keyboard focus,
        // so keyboard users get the stop affordance without needing hover.
        <span className="relative flex size-4 items-center justify-center" aria-hidden>
          <span className="flex h-full items-center gap-[2px] transition-opacity group-hover/button:opacity-0 group-focus-visible/button:opacity-0">
            {BAR_BINS.map(([lo, hi], i) => (
              <span
                key={`${lo}-${hi}`}
                ref={(el) => {
                  barRefs.current[i] = el;
                }}
                className="block h-3 w-[2px] origin-center rounded-full bg-current"
                style={{ transform: `scaleY(${BAR_BASELINE})` }}
              />
            ))}
          </span>
          <SquareIcon className="absolute size-3 fill-current opacity-0 transition-opacity group-hover/button:opacity-100 group-focus-visible/button:opacity-100" />
        </span>
      ) : (
        <MicIcon className="size-4" data-icon-size="16" />
      )}
    </Button>
  );
};
