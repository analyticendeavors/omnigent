// Start a spoken chat from the new-chat page (omnigent-ae, 2026-11-10). The Voice button arms
// the page, the mic listens, and the first finished sentence plus a short grace starts the
// chat; the created chat then opens with Voice mode on (see takeVoiceArm).

import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { primeVoicePlayback } from "@/lib/aeSpeakReplies";
import {
  type AeMicController,
  armVoiceForNextChat,
  disarmVoiceForNextChat,
  GRACE_MS,
  type VoicePhase,
} from "@/lib/aeVoiceMode";

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
  }, [armed, controller, disarm]);

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

  const onFinal = useCallback(
    (_text: string) => {
      if (!armed) return;
      clearTimer();
      // A pause after the sentence means it is finished; anything said sooner extends it.
      timer.current = setTimeout(() => {
        timer.current = null;
        const now = latest.current;
        if (!now.canSubmit || !now.value.trim()) return;
        now.submit();
        release();
      }, GRACE_MS);
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

  return { armed, phase, toggle, onListening, onFinal, disarm };
}
