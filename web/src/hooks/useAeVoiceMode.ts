// The Voice mode loop: the mic listens while idle, a finished sentence plus a short
// grace sends the draft, the mic is muted from send until the reply has been spoken,
// and a pending question card is read aloud and answered by voice.

import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import {
  type AeMicController,
  GRACE_MS,
  isPendingElicitation,
  matchSpokenOption,
  matchSpokenOptions,
  questionKey,
  questionsOf,
  questionSpeech,
  RESUME_MS,
  setVoicePhase,
  splitDone,
  type VoicePhase,
  useVoiceSnapshot,
} from "@/lib/aeVoiceMode";
import { useChatStore } from "@/store/chatStore";

/** If the chat never starts streaming after a send, stop waiting for it. */
const SEND_WAIT_MS = 5000;

export interface UseAeVoiceModeArgs {
  chatId: string | null;
  controller: MutableRefObject<AeMicController | null>;
  status: string;
  /** The composer draft. */
  value: string;
  /** Sends the draft exactly as the Send button does. */
  submit: () => void;
}

export interface AeVoiceMode {
  on: boolean;
  phase: VoicePhase;
  /** A final sentence arrived; true when Voice mode used it (the draft should not take it). */
  onFinal: (text: string) => boolean;
  /** A partial arrived; true when Voice mode is answering a card and the draft should not take it. */
  onPartial: (text: string) => boolean;
}

interface CardState {
  id: string;
  index: number;
  answers: Record<string, string | string[]>;
  picked: string[];
  custom: string;
}

export function useAeVoiceMode({
  chatId,
  controller,
  status,
  value,
  submit,
}: UseAeVoiceModeArgs): AeVoiceMode {
  const voice = useVoiceSnapshot(chatId);
  const { on, speaking } = voice;
  const block = useChatStore((s) =>
    s.blocks.find((b) => isPendingElicitation(b, s.conversationId)),
  );
  const questions = on ? questionsOf(block?.type === "elicitation" ? block : undefined) : null;
  const cardActive = questions !== null;

  const [awaiting, setAwaiting] = useState(false);
  const [ready, setReady] = useState(true);
  const sawStreaming = useRef(false);
  const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const card = useRef<CardState | null>(null);

  const waiting = !cardActive && (awaiting || status === "streaming");
  const muted = on && (speaking || waiting);
  const wantListen = on && !muted && ready;

  const latest = useRef({ value, submit, muted, questions, speak: voice.speak, block });
  latest.current = {
    value,
    submit,
    muted,
    questions,
    speak: voice.speak,
    block: block?.type === "elicitation" ? block : undefined,
  };
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const clearGrace = useCallback(() => {
    if (graceTimer.current !== null) clearTimeout(graceTimer.current);
    graceTimer.current = null;
  }, []);

  // A send is in flight until the chat has streamed and gone idle again.
  useEffect(() => {
    if (!awaiting) return;
    if (status === "streaming") sawStreaming.current = true;
    else if (sawStreaming.current) {
      setAwaiting(false);
      sawStreaming.current = false;
    }
  }, [awaiting, status]);
  useEffect(
    () => () => {
      if (sendTimer.current !== null) clearTimeout(sendTimer.current);
      clearGrace();
    },
    [clearGrace],
  );

  // The mic comes back RESUME_MS after the chat goes quiet.
  useEffect(() => {
    if (muted) {
      setReady(false);
      return;
    }
    if (readyRef.current) return;
    const t = setTimeout(() => setReady(true), RESUME_MS);
    return () => clearTimeout(t);
  }, [muted]);

  const wasOn = useRef(on);
  useEffect(() => {
    const mic = controller.current;
    if (!on) {
      clearGrace();
      // Turning the switch off hands the mic back, quiet.
      if (wasOn.current && mic?.isListening()) mic.stop();
      wasOn.current = false;
      return;
    }
    wasOn.current = true;
    if (!mic) return;
    if (wantListen && !mic.isListening()) mic.start();
    else if (!wantListen && mic.isListening()) mic.stop();
  }, [on, wantListen, controller, clearGrace]);

  useEffect(() => {
    if (!chatId) return;
    const phase: VoicePhase = !on
      ? "off"
      : speaking
        ? "speaking"
        : waiting
          ? "thinking"
          : "listening";
    setVoicePhase(chatId, phase);
  }, [chatId, on, speaking, waiting]);

  const send = useCallback(() => {
    setAwaiting(true);
    sawStreaming.current = false;
    if (sendTimer.current !== null) clearTimeout(sendTimer.current);
    sendTimer.current = setTimeout(() => {
      if (!sawStreaming.current) setAwaiting(false);
    }, SEND_WAIT_MS);
    latest.current.submit();
  }, []);

  // A new question card: read it aloud, one question at a time.
  const cardId = block?.type === "elicitation" ? block.elicitationId : null;
  useEffect(() => {
    if (!on || !cardId) {
      card.current = null;
      return;
    }
    const qs = latest.current.questions;
    if (!qs || card.current?.id === cardId) return;
    card.current = { id: cardId, index: 0, answers: {}, picked: [], custom: "" };
    const q = qs[0];
    latest.current.speak?.(
      questionSpeech(
        q.question,
        q.options.map((o) => o.label),
      ),
    );
  }, [on, cardId, voice.speak]);

  const answerCard = useCallback((state: CardState, answer: string | string[]) => {
    const qs = latest.current.questions;
    if (!qs) return;
    state.answers[questionKey(qs[state.index])] = answer;
    state.index += 1;
    state.picked = [];
    state.custom = "";
    if (state.index < qs.length) {
      const next = qs[state.index];
      latest.current.speak?.(
        questionSpeech(
          next.question,
          next.options.map((o) => o.label),
        ),
      );
      return;
    }
    void useChatStore.getState().submitApproval(state.id, "accept", state.answers);
  }, []);

  const onCardFinal = useCallback(
    (state: CardState, text: string) => {
      const qs = latest.current.questions;
      const q = qs?.[state.index];
      if (!q) return;
      const labels = q.options.map((o) => o.label);
      if (q.multiSelect) {
        const { done, rest } = splitDone(text);
        const hits = matchSpokenOptions(rest, labels).map((i) => labels[i]);
        if (hits.length === 0 && rest.trim() !== "")
          state.custom = `${state.custom} ${rest}`.trim();
        for (const h of hits) if (!state.picked.includes(h)) state.picked.push(h);
        if (done && (state.picked.length > 0 || state.custom !== "")) {
          answerCard(state, state.custom ? [...state.picked, state.custom] : [...state.picked]);
        }
        return;
      }
      const index = matchSpokenOption(text, labels);
      if (index !== null) {
        state.custom = "";
        answerCard(state, labels[index]);
        return;
      }
      // No option matched: after the grace the words go in as the card's own answer.
      state.custom = `${state.custom} ${text}`.trim();
      clearGrace();
      graceTimer.current = setTimeout(() => {
        graceTimer.current = null;
        if (card.current === state && state.custom !== "") answerCard(state, state.custom);
      }, GRACE_MS);
    },
    [answerCard, clearGrace],
  );

  const onFinal = useCallback(
    (text: string): boolean => {
      if (!on) return false;
      const state = card.current;
      if (state && latest.current.questions) {
        if (!latest.current.muted) onCardFinal(state, text);
        return true;
      }
      if (latest.current.muted) return false;
      clearGrace();
      graceTimer.current = setTimeout(() => {
        graceTimer.current = null;
        const now = latest.current;
        if (now.muted || now.value.trim() === "") return;
        send();
      }, GRACE_MS);
      return false;
    },
    [on, onCardFinal, clearGrace, send],
  );

  const onPartial = useCallback(
    (_text: string): boolean => {
      clearGrace();
      return on && card.current !== null && latest.current.questions !== null;
    },
    [on, clearGrace],
  );

  return { on, phase: voice.phase, onFinal, onPartial };
}
