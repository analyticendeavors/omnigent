// Send snips loop: while Voice mode and the Send snips switch are both on, a picture
// pasted anywhere in the window is attached, acknowledged by voice, and sent with the
// next sentence, or alone as "Note this." when nothing is said for SNIP_WAIT_MS.

import { useEffect, useRef, useState } from "react";
import { getVoiceSnapshot, type VoicePhase } from "@/lib/aeVoiceMode";
import {
  countImageFiles,
  imageFilesFromClipboard,
  isComposerPasteTarget,
  SNIP_ACK,
  SNIP_NOTE,
  SNIP_WAIT_MS,
  useSendSnips,
} from "@/lib/aeVoiceSnips";

export interface UseAeVoiceSnipsArgs {
  chatId: string | null;
  voiceOn: boolean;
  phase: VoicePhase;
  cardActive: boolean;
  files: File[];
  addFiles: (files: File[]) => void;
  value: string;
  setValue: (value: string) => void;
  submit: () => void;
  canSend: boolean;
}

export interface AeVoiceSnips {
  active: boolean;
  pending: boolean;
  /** Wire to the attachments hook's onAccepted: fires only for files the user just added. */
  onAccepted: (accepted: File[]) => void;
}

export function useAeVoiceSnips(args: UseAeVoiceSnipsArgs): AeVoiceSnips {
  const { chatId, voiceOn, phase, cardActive, files, value, canSend } = args;
  const snips = useSendSnips();
  const active = voiceOn && snips;
  const imageCount = countImageFiles(files);
  const [pending, setPending] = useState(false);

  const latest = useRef(args);
  latest.current = args;
  const activeRef = useRef(active);
  activeRef.current = active;
  const imageCountRef = useRef(imageCount);
  imageCountRef.current = imageCount;

  const clock = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The clock fired but the phase, a card or canSend said wait.
  const held = useRef(false);
  // The hook itself wrote "Note this." and owes a submit; typed text never arms.
  const noteArmed = useRef(false);
  // The armed submit found canSend, the phase or a card in the way.
  const submitHeld = useRef(false);

  const stopClock = () => {
    if (clock.current !== null) clearTimeout(clock.current);
    clock.current = null;
  };

  const stopSubmit = () => {
    if (submitTimer.current !== null) clearTimeout(submitTimer.current);
    submitTimer.current = null;
  };

  const cancel = () => {
    stopClock();
    stopSubmit();
    held.current = false;
    submitHeld.current = false;
    // Only a draft this hook wrote while armed is ever cleared.
    if (noteArmed.current && latest.current.value === SNIP_NOTE) latest.current.setValue("");
    noteArmed.current = false;
    setPending(false);
  };

  // Submit the armed note when every condition holds; otherwise hold for the next re-check.
  const trySubmit = () => {
    if (!noteArmed.current) return;
    const l = latest.current;
    if (!activeRef.current || imageCountRef.current === 0) {
      cancel();
      return;
    }
    if (l.value !== SNIP_NOTE) {
      // The draft was changed by someone else: leave it alone.
      noteArmed.current = false;
      submitHeld.current = false;
      return;
    }
    if (l.phase !== "listening" || l.cardActive || !l.canSend) {
      submitHeld.current = true;
      return;
    }
    submitHeld.current = false;
    noteArmed.current = false;
    l.submit();
  };

  const scheduleSubmit = () => {
    stopSubmit();
    submitTimer.current = setTimeout(() => {
      submitTimer.current = null;
      trySubmit();
    }, 0);
  };

  // Write the note when every condition holds; otherwise hold for the next re-check.
  const attempt = () => {
    const l = latest.current;
    if (!activeRef.current || imageCountRef.current === 0 || l.value.trim() !== "") {
      cancel();
      return;
    }
    if (l.phase !== "listening" || l.cardActive || !l.canSend) {
      held.current = true;
      return;
    }
    held.current = false;
    setPending(false);
    noteArmed.current = true;
    l.setValue(SNIP_NOTE);
  };

  const startClock = () => {
    stopClock();
    held.current = false;
    setPending(true);
    clock.current = setTimeout(() => {
      clock.current = null;
      // A sentence is being dictated: voice mode's own send carries the files.
      if (latest.current.value.trim() !== "") {
        cancel();
        return;
      }
      attempt();
    }, SNIP_WAIT_MS);
  };

  // The user just attached a picture: say "Got it." once and (re)start the clock.
  const onAccepted = (accepted: File[]) => {
    if (!activeRef.current || countImageFiles(accepted) === 0) return;
    const id = latest.current.chatId;
    if (id) getVoiceSnapshot(id).speak?.(SNIP_ACK);
    startClock();
  };

  // Either switch off, or no picture left: nothing to send.
  useEffect(() => {
    if (!active || imageCount === 0) cancel();
  }, [active, imageCount]);

  // The chat changed or the hook unmounted.
  useEffect(
    () => () => {
      cancel();
    },
    [chatId],
  );

  // Held because the phase was not listening, a card was open or sending was refused.
  useEffect(() => {
    if (held.current) attempt();
    if (submitHeld.current) scheduleSubmit();
  }, [phase, cardActive, canSend, value]);

  // Submit on the tick after the render that carries the note the hook wrote.
  useEffect(() => {
    if (noteArmed.current && value === SNIP_NOTE) scheduleSubmit();
  }, [value]);

  // A picture pasted anywhere outside the composer's own fields.
  useEffect(() => {
    if (!active) return;
    const onPaste = (e: ClipboardEvent) => {
      if (isComposerPasteTarget(e.target)) return;
      const images = imageFilesFromClipboard(e.clipboardData);
      if (images.length === 0) return;
      e.preventDefault();
      latest.current.addFiles(images);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [active]);

  return { active, pending, onAccepted };
}
