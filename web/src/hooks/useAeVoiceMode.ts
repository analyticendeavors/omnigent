// The Voice mode loop: the mic listens while idle, a finished sentence plus a short
// grace sends the draft, the mic is muted from send until the reply has been spoken,
// and a pending question card is read aloud and answered by voice.

import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import {
  type AeMicController,
  customAllowed,
  GRACE_MS,
  isPendingElicitation,
  matchSpokenOption,
  matchSpokenOptions,
  questionKey,
  questionsOf,
  questionSpeech,
  RESUME_MS,
  setVoiceBarged,
  setVoicePhase,
  splitDone,
  stopVoice,
  syncVoiceLabel,
  useVoiceSnapshot,
  type VoicePhase,
} from "@/lib/aeVoiceMode";
import { activeEchoWords, resetEcho, splitEcho } from "@/lib/aeVoiceEcho";
import { logVoice } from "@/lib/aeVoiceLog";
import { useMicWhileSpeaking } from "@/lib/aeVoiceMic";
import { useChatStore } from "@/store/chatStore";

/** If the chat never shows a turn after a send, stop waiting for it. */
const SEND_WAIT_MS = 5000;
/** One retry of a mic start that failed. */
const MIC_RETRY_MS = 1000;
/**
 * Backstop for a start that produced no report at all. Long on purpose: the first server
 * take cold-loads the speech model, which can take about 40 s, and that is not a failure.
 */
export const MIC_START_NET_MS = 60_000;
const LABEL_KEY = "ae.voice";

export interface UseAeVoiceModeArgs {
  chatId: string | null;
  controller: MutableRefObject<AeMicController | null>;
  status: string;
  /** The composer draft. */
  value: string;
  /** Sends the draft exactly as the Send button does. */
  submit: () => void;
  /** False while the composer would refuse a send (locked, disabled, a card pending). */
  canSend: boolean;
  /** The session's labels once loaded; the server's `ae.voice` is compared with the switch. */
  labels?: Record<string, string> | null;
}

export interface AeVoiceMode {
  on: boolean;
  phase: VoicePhase;
  /** A question card Voice mode is answering; the mic stays live for it. */
  cardActive: boolean;
  /** A final sentence arrived; true when Voice mode used it (the draft should not take it). */
  onFinal: (text: string) => boolean;
  /** A partial arrived; true when Voice mode used it (the draft should not take it). */
  onPartial: (text: string) => boolean;
  /**
   * Heard text with the speaker's own echo removed ("" when it is all echo, or held while a
   * reply plays until it is clearly the person). Their own words heard while audio plays
   * barge in when the mic stays open while speaking. `kind` is whether it is an interim or
   * a final result.
   */
  filterHeard: (text: string, kind: "interim" | "final") => string;
  /** Stops the reply being spoken (the hotkey); true when it did. The mic stays on. */
  bargeIn: () => boolean;
  /** The mic reports it started or stopped listening (or failed to start). */
  onListening: (listening: boolean) => void;
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
  canSend,
  labels,
}: UseAeVoiceModeArgs): AeVoiceMode {
  const voice = useVoiceSnapshot(chatId);
  const { on, speaking, barged, playing } = voice;
  const micMode = useMicWhileSpeaking();
  const block = useChatStore((s) =>
    s.blocks.find((b) => isPendingElicitation(b, s.conversationId)),
  );
  const sessionRunning = useChatStore((s) => s.sessionStatus === "running");
  const queued = useChatStore((s) => s.pendingUserMessages.length > 0);
  const questions = on ? questionsOf(block?.type === "elicitation" ? block : undefined) : null;
  const cardActive = questions !== null;

  const [awaiting, setAwaiting] = useState(false);
  const [ready, setReady] = useState(true);
  const [micListening, setMicListening] = useState(false);
  const [micFailed, setMicFailed] = useState(false);
  const [micStopped, setMicStopped] = useState(false);
  const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const netTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onListeningRef = useRef<(listening: boolean) => void>(() => {});
  const card = useRef<CardState | null>(null);
  // The mic's own report of a start in flight, our stop, and failures so far this cycle.
  const startPending = useRef(false);
  const stopAsked = useRef(false);
  const failures = useRef(0);
  // Echo guard: the spoken words in force when this utterance began, and interims in a row
  // that held two or more new words.
  const utteranceWords = useRef<readonly string[] | null>(null);
  const personInterims = useRef(0);

  // A turn is under way once the chat streams, the session runs, or the message is queued.
  const busy = status === "streaming" || sessionRunning || queued;
  const waiting = !cardActive && !barged && (awaiting || busy);
  // The mic is muted while a reply is queued or made, and while it plays in "wait"; it opens
  // in "always" only once audio really plays. Thinking stays muted in both.
  const muted = on && (speaking ? micMode === "wait" || !playing : waiting);
  const quiet = muted || !ready;
  const wantListen = on && !quiet;

  const latest = useRef({
    value,
    submit,
    canSend,
    muted,
    quiet,
    wantListen,
    micListening,
    questions,
    speak: voice.speak,
    speaking,
    playing,
    micMode,
  });
  latest.current = {
    value,
    submit,
    canSend,
    muted,
    quiet,
    wantListen,
    micListening,
    questions,
    speak: voice.speak,
    speaking,
    playing,
    micMode,
  };
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const clearGrace = useCallback(() => {
    if (graceTimer.current !== null) clearTimeout(graceTimer.current);
    graceTimer.current = null;
  }, []);

  // Another chat: nothing started for the old one may fire for the new one.
  useEffect(
    () => () => {
      clearGrace();
      if (sendTimer.current !== null) clearTimeout(sendTimer.current);
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
      if (netTimer.current !== null) clearTimeout(netTimer.current);
      sendTimer.current = null;
      retryTimer.current = null;
      netTimer.current = null;
      card.current = null;
      startPending.current = false;
      stopAsked.current = false;
      failures.current = 0;
      resetEcho();
      utteranceWords.current = null;
      personInterims.current = 0;
      setAwaiting(false);
      setMicFailed(false);
      setMicStopped(false);
    },
    [chatId, clearGrace],
  );

  // Make the server's label agree with this browser's switch, once per chat.
  const labelValue = labels ? labels[LABEL_KEY] : undefined;
  const labelKnown = labels !== undefined && labels !== null;
  useEffect(() => {
    if (chatId && labelKnown) syncVoiceLabel(chatId, labelValue === "on");
    // Once per chat: later label refreshes follow the switch, they do not lead it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, labelKnown]);

  // A send hands over to the chat's own status the moment a turn shows; it lets go by
  // itself only when no turn ever showed (the send did not happen).
  useEffect(() => {
    if (awaiting && busy) {
      setAwaiting(false);
      if (sendTimer.current !== null) clearTimeout(sendTimer.current);
      sendTimer.current = null;
    }
  }, [awaiting, busy]);

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

  const clearNet = useCallback(() => {
    if (netTimer.current !== null) clearTimeout(netTimer.current);
    netTimer.current = null;
  }, []);

  const startMic = useCallback(() => {
    const mic = controller.current;
    if (!mic || mic.isListening()) return;
    startPending.current = true;
    stopAsked.current = false;
    clearNet();
    // If the mic never answers, call it a failed start so the retry path runs.
    netTimer.current = setTimeout(() => {
      netTimer.current = null;
      if (!startPending.current) return;
      controller.current?.stop();
      onListeningRef.current(false);
    }, MIC_START_NET_MS);
    mic.start();
  }, [controller, clearNet]);

  const wasOn = useRef(on);
  useEffect(() => {
    const mic = controller.current;
    if (!on) {
      clearGrace();
      // Turning the switch off hands the mic back, quiet.
      if (wasOn.current && mic) {
        stopAsked.current = mic.isListening() || startPending.current;
        startPending.current = false;
        mic.stop();
      }
      wasOn.current = false;
      failures.current = 0;
      setMicFailed(false);
      setMicStopped(false);
      return;
    }
    wasOn.current = true;
    if (!mic) return;
    if (wantListen) {
      // A new listening cycle: an earlier failure or hand-stop is forgotten.
      setMicStopped(false);
      if (!mic.isListening() && !startPending.current) {
        failures.current = 0;
        setMicFailed(false);
        startMic();
      }
    } else {
      stopAsked.current = mic.isListening() || startPending.current;
      startPending.current = false;
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
      retryTimer.current = null;
      clearNet();
      // A start still connecting is withdrawn too, not only a live stream.
      mic.stop();
    }
  }, [on, wantListen, chatId, controller, clearGrace, clearNet, startMic]);

  const onListening = useCallback(
    (listening: boolean) => {
      // A mic start or stop ends the utterance: an interim with no final leaves no pin behind.
      utteranceWords.current = null;
      personInterims.current = 0;
      if (listening) {
        clearNet();
        startPending.current = false;
        failures.current = 0;
        setMicFailed(false);
        setMicStopped(false);
        setMicListening(true);
        return;
      }
      setMicListening(false);
      clearNet();
      if (startPending.current) {
        // The start never reached listening: try once more, then say so.
        startPending.current = false;
        failures.current += 1;
        if (failures.current === 1) {
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            logVoice("mic retry");
            if (latest.current.wantListen && !latest.current.micListening) startMic();
          }, MIC_RETRY_MS);
        } else {
          logVoice("mic failed");
          setMicFailed(true);
        }
      } else if (stopAsked.current) {
        // Our own stop finished. If the mic is wanted again by now (stop and start inside
        // a second), the start that was turned away is made again.
        stopAsked.current = false;
        if (latest.current.wantListen) startMic();
        return;
      } else if (latest.current.wantListen) {
        // Stopped from outside (the mic button, the hotkey): leave it stopped.
        setMicStopped(true);
      }
      stopAsked.current = false;
    },
    [startMic, clearNet],
  );
  onListeningRef.current = onListening;

  useEffect(() => {
    if (!chatId) return;
    const phase: VoicePhase = !on
      ? "off"
      : speaking
        ? "speaking"
        : waiting
          ? "thinking"
          : micListening
            ? "listening"
            : micFailed
              ? "unavailable"
              : micStopped
                ? "paused"
                : "starting";
    logVoice(`phase ${phase}`);
    setVoicePhase(chatId, phase);
  }, [chatId, on, speaking, waiting, micListening, micFailed, micStopped]);

  const send = useCallback(() => {
    const now = latest.current;
    if (!now.canSend) return;
    logVoice("send");
    setAwaiting(true);
    if (sendTimer.current !== null) clearTimeout(sendTimer.current);
    sendTimer.current = setTimeout(() => {
      sendTimer.current = null;
      setAwaiting(false);
    }, SEND_WAIT_MS);
    now.submit();
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
    logVoice("card read");
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
      const names = q.options.map((o) => o.label);
      const mayCustom = customAllowed(q);
      if (q.multiSelect) {
        // An option literally called "Done" is a pick, not the end of picking.
        const whole = matchSpokenOption(text, names);
        if (whole !== null && splitDone(names[whole]).done) {
          if (!state.picked.includes(names[whole])) state.picked.push(names[whole]);
          return;
        }
        const { done, rest, raw } = splitDone(text);
        // The whole remainder first ("merge it done" for a "Merge it" option); filler is
        // trimmed only when nothing matched.
        // Both are tried and the one with more picks wins, the whole remainder on a tie:
        // "one and three, I'm done" keeps both picks, "merge it done" keeps "Merge it".
        const fromRaw = matchSpokenOptions(raw, names).map((i) => names[i]);
        const fromRest = matchSpokenOptions(rest, names).map((i) => names[i]);
        const hits = fromRest.length > fromRaw.length ? fromRest : fromRaw;
        if (hits.length === 0 && rest.trim() !== "" && mayCustom) {
          state.custom = `${state.custom} ${rest}`.trim();
        }
        for (const h of hits) if (!state.picked.includes(h)) state.picked.push(h);
        if (done && (state.picked.length > 0 || state.custom !== "")) {
          answerCard(state, state.custom ? [...state.picked, state.custom] : [...state.picked]);
        }
        return;
      }
      const index = matchSpokenOption(text, names);
      if (index !== null) {
        state.custom = "";
        clearGrace();
        answerCard(state, names[index]);
        return;
      }
      // A card that takes no words of the person's own keeps listening for an option.
      if (!mayCustom) return;
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

  const bargeIn = useCallback((): boolean => {
    if (!chatId || !on || !latest.current.speaking) return false;
    logVoice("barge");
    clearGrace();
    setVoiceBarged(chatId, true);
    stopVoice(chatId);
    return true;
  }, [chatId, on, clearGrace]);

  const filterHeard = useCallback(
    (text: string, kind: "interim" | "final"): string => {
      if (!on) return text;
      // An utterance that began inside the window stays filtered however late its final lands.
      const live = activeEchoWords();
      // An interim after the window closed is a new utterance: an old pin is stale.
      if (kind === "interim" && live === null) utteranceWords.current = null;
      const words = live ?? utteranceWords.current;
      if (kind === "interim") {
        if (live !== null) utteranceWords.current = live;
      } else {
        utteranceWords.current = null;
      }
      if (!words) {
        personInterims.current = 0;
        return text;
      }
      const { fresh, person } = splitEcho(text, words);
      const now = latest.current;
      // Audio is playing and the mic is open: only clearly the person's words get through.
      if (now.speaking && now.playing && now.micMode === "always") {
        let confirmed = person;
        if (kind === "interim") {
          personInterims.current = person ? personInterims.current + 1 : 0;
          confirmed = personInterims.current >= 2;
        } else {
          personInterims.current = 0;
        }
        if (!confirmed) {
          logVoice("echo dropped");
          return "";
        }
        personInterims.current = 0;
        bargeIn();
      }
      return fresh.join(" ");
    },
    [on, bargeIn],
  );

  const onFinal = useCallback(
    (text: string): boolean => {
      if (!on) return false;
      logVoice("final", text.slice(0, 60));
      const now = latest.current;
      const state = card.current;
      if (state && now.questions) {
        if (!now.quiet) onCardFinal(state, text);
        return true;
      }
      // Sound heard while the chat is busy or the voice is talking never reaches the draft.
      if (now.quiet) {
        clearGrace();
        return true;
      }
      clearGrace();
      graceTimer.current = setTimeout(() => {
        graceTimer.current = null;
        const current = latest.current;
        if (current.quiet || current.value.trim() === "") return;
        send();
      }, GRACE_MS);
      return false;
    },
    [on, onCardFinal, clearGrace, send],
  );

  const onPartial = useCallback(
    (_text: string): boolean => {
      clearGrace();
      if (!on) return false;
      return latest.current.quiet || (card.current !== null && latest.current.questions !== null);
    },
    [on, clearGrace],
  );

  return {
    on,
    phase: voice.phase,
    cardActive,
    filterHeard,
    bargeIn,
    onFinal,
    onPartial,
    onListening,
  };
}
