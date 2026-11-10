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

export function useAeVoiceSnips(args: UseAeVoiceSnipsArgs): { active: boolean; pending: boolean } {
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
  const held = useRef(false);
  const noteSet = useRef(false);
  const prevFiles = useRef(files);

  const stopClock = () => {
    if (clock.current !== null) clearTimeout(clock.current);
    clock.current = null;
  };

  const cancel = () => {
    stopClock();
    held.current = false;
    noteSet.current = false;
    setPending(false);
  };

  // Send the note when every condition holds; otherwise hold for the next re-check.
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
    noteSet.current = true;
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

  // A new picture: say "Got it." once and (re)start the clock.
  useEffect(() => {
    const prev = prevFiles.current;
    prevFiles.current = files;
    if (!activeRef.current || files === prev) return;
    if (countImageFiles(files) <= countImageFiles(prev)) return;
    const id = latest.current.chatId;
    if (id) getVoiceSnapshot(id).speak?.(SNIP_ACK);
    startClock();
  }, [files]);

  // Either switch off, or no picture left: nothing to send.
  useEffect(() => {
    if (!active || imageCount === 0) cancel();
  }, [active, imageCount]);

  // The chat changed or the hook unmounted.
  useEffect(
    () => () => {
      cancel();
      if (submitTimer.current !== null) clearTimeout(submitTimer.current);
      submitTimer.current = null;
    },
    [chatId],
  );

  // Held because the phase was not listening: send as soon as it is.
  useEffect(() => {
    if (held.current) attempt();
  }, [phase, cardActive, canSend, value]);

  // Submit on the tick after the render that carries the note.
  useEffect(() => {
    if (!noteSet.current || value !== SNIP_NOTE) return;
    noteSet.current = false;
    submitTimer.current = setTimeout(() => {
      submitTimer.current = null;
      const l = latest.current;
      if (l.value === SNIP_NOTE && l.canSend) l.submit();
    }, 0);
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

  return { active, pending };
}
