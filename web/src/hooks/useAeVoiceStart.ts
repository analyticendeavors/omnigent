// Start a spoken chat from the new-chat page (omnigent-ae, 2026-11-10). The Voice button arms
// the page, the mic listens, and the first finished sentence plus a short grace starts the
// chat; the created chat then opens with Voice mode on (see takeVoiceArm).

import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { primeVoicePlayback } from "@/lib/aeSpeakReplies";
import { logVoice } from "@/lib/aeVoiceLog";
import {
  type AeMicController,
  armVoiceForNextChat,
  disarmVoiceForNextChat,
  GRACE_MS,
  type VoicePhase,
} from "@/lib/aeVoiceMode";

/** How often a spoken message that is waiting for the chat to be ready checks again. */
export const READY_POLL_MS = 500;
/** How long it waits before it says the chat was not ready. */
export const READY_WAIT_MS = 10_000;

export interface UseAeVoiceStartArgs {
  controller: MutableRefObject<AeMicController | null>;
  /** The message draft, with the latest final already appended. */
  value: string;
  /** The Start session button would work right now. */
  canSubmit: boolean;
  /** Starts the session exactly as the Start session button does. */
  submit: () => void;
}

export interface AeVoiceStart {
  armed: boolean;
  phase: VoicePhase;
  toggle: () => void;
  /** Listen again after the mic paused or was unavailable. */
  restart: () => void;
  onListening: (listening: boolean) => void;
  onFinal: (text: string) => void;
  disarm: () => void;
}

export function useAeVoiceStart({
  controller,
  value,
  canSubmit,
  submit,
}: UseAeVoiceStartArgs): AeVoiceStart {
  const [armed, setArmed] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>("off");
  const everListened = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ value, canSubmit, submit });
  latest.current = { value, canSubmit, submit };

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  // After a submit the module flag stays set: the session is created asynchronously and
  // takeVoiceArm reads it once the id is known.
  const release = useCallback(() => {
    clearTimer();
    setArmed(false);
    setPhase("off");
    everListened.current = false;
    controller.current?.stop();
  }, [clearTimer, controller]);

  const disarm = useCallback(() => {
    disarmVoiceForNextChat();
    release();
  }, [release]);

  const onListening = useCallback(
    (listening: boolean) => {
      if (!armed) return;
      if (listening) {
        everListened.current = true;
        setPhase("listening");
      } else setPhase(everListened.current ? "paused" : "unavailable");
    },
    [armed],
  );

  // start() returns early on a mic that is already listening, so no event follows.
  const reportIfListening = useCallback(() => {
    if (!controller.current?.isListening()) return;
    everListened.current = true;
    setPhase("listening");
  }, [controller]);

  const toggle = useCallback(() => {
    if (armed) {
      disarm();
      return;
    }
    // Inside the tap, so the browser lets the reply play later.
    primeVoicePlayback();
    armVoiceForNextChat();
    everListened.current = false;
    setArmed(true);
    setPhase("starting");
    controller.current?.start();
    // A mic that was already listening fires no event; report it.
    reportIfListening();
  }, [armed, controller, disarm, reportIfListening]);

  const restart = useCallback(() => {
    // A fresh recognizer inside the tap: a start that is stuck (iOS) ignores a second start().
    const c = controller.current;
    if (c?.restart) c.restart();
    else c?.start();
    reportIfListening();
  }, [controller, reportIfListening]);

  const onFinal = useCallback(
    (_text: string) => {
      if (!armed) return;
      clearTimer();
      // Something new was said: the held message is not waiting any more.
      setPhase((p) => (p === "preparing" || p === "stalled" ? "listening" : p));
      // A pause after the sentence means it is finished; anything said sooner extends it.
      // A message that cannot go yet (the host or folder is still loading) is held and sent the
      // moment the chat is ready; after the window it says so instead of dropping it.
      const tryNow = (waited: number) => {
        timer.current = null;
        const now = latest.current;
        if (!now.value.trim()) return;
        if (now.canSubmit) {
          logVoice("start send");
          now.submit();
          release();
          return;
        }
        if (waited >= READY_WAIT_MS) {
          logVoice("start gave up", "chat not ready");
          setPhase("stalled");
          return;
        }
        if (waited === 0) {
          logVoice("start waiting", "chat not ready");
          setPhase("preparing");
        }
        timer.current = setTimeout(() => tryNow(waited + READY_POLL_MS), READY_POLL_MS);
      };
      timer.current = setTimeout(() => tryNow(0), GRACE_MS);
    },
    [armed, clearTimer, release],
  );

  // Leaving the page must not leave the next chat armed.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      disarmVoiceForNextChat();
    },
    [],
  );

  return { armed, phase, toggle, restart, onListening, onFinal, disarm };
}
