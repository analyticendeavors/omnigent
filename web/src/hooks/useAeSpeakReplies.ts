// Reads assistant replies aloud as they stream into the visible chat. Only live
// depth-0 text is spoken: history, sub-agent text and interrupted partials are not.

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { createCloudSpeaker } from "@/lib/aeCloudVoice";
import {
  createSpeaker,
  primeCloudPlayback,
  registerCloudPrimer,
  setCaptionHandler,
  setPlaybackHandler,
  type Speaker,
  type VoiceChoice,
  WORKING_CUE_DELAY_MS,
  WORKING_CUE_TEXT,
} from "@/lib/aeSpeakReplies";
import {
  CODE_BLOCK_PHRASE,
  completeSentences,
  normalizeSentence,
  speechTextFromMarkdown,
  splitSentences,
  stripTldr,
} from "@/lib/aeSpeechText";
import {
  getVoiceSnapshot,
  setVoiceBarged,
  setVoiceBlocked,
  setVoiceCaption,
  setVoicePlaying,
} from "@/lib/aeVoiceMode";
import { recordSpoken, resetEcho } from "@/lib/aeVoiceEcho";
import { logVoice } from "@/lib/aeVoiceLog";
import { usePlaybackBlocked } from "@/lib/aeVoicePlayback";
import { type AnyBlock, LIVE_ITEM_PREFIX } from "@/lib/blocks";
import { useChatStore } from "@/store/chatStore";

// The device speaker, and the cloud speaker that falls back to it for a sentence the server fails.
let deviceSpeaker: Speaker | null = null;
let cloudSpeaker: Speaker | null = null;
function getDevice(): Speaker {
  deviceSpeaker ??= createSpeaker();
  return deviceSpeaker;
}
function getCloud(): Speaker {
  cloudSpeaker ??= createCloudSpeaker(getDevice());
  return cloudSpeaker;
}

// primeVoicePlayback (lib/aeSpeakReplies.ts) reaches the cloud speaker through this.
registerCloudPrimer(() => getCloud().prime?.());

/** One speaker face over both: `speak` goes to the voice's engine, `stop` to both. */
function getSpeaker(): Speaker {
  return {
    speak: () => {},
    stop: () => {
      getCloud().stop();
      getDevice().stop();
    },
    speaking: () => getCloud().speaking() || getDevice().speaking(),
    retained: () => getDevice().retained(),
    subscribe: (cb) => {
      const a = getCloud().subscribe(cb);
      const b = getDevice().subscribe(cb);
      return () => {
        a();
        b();
      };
    },
  };
}

function say(text: string, voice: VoiceChoice | null, rate: number, shortFirst = false): void {
  if (voice?.kind === "cloud") {
    getCloud().speak(text, { voiceURI: null, rate, cloudVoiceId: voice.id, shortFirst });
  } else {
    getDevice().speak(text, { voiceURI: voice?.id ?? null, rate, shortFirst });
  }
}

const CODE_BLOCK_KEY = normalizeSentence(CODE_BLOCK_PHRASE);
const MESSAGE_START = "^";
const CUE_LOCK = "\0cue";

interface FinalText {
  key: string;
  responseId: string;
  fullText: string;
  fromHistory: boolean;
}

interface Scan {
  /** Streaming sources: a native live preview, or a run of SDK chunks after the last final. */
  sources: Map<string, { responseId: string; raw: string }>;
  finals: FinalText[];
  userBlocks: number;
}

function scanBlocks(blocks: readonly AnyBlock[]): Scan {
  const sources: Scan["sources"] = new Map();
  const finals: FinalText[] = [];
  const lastFinalAt = new Map<string, number>();
  let userBlocks = 0;
  blocks.forEach((b, index) => {
    if (b.type === "user_message") {
      if (b.ctx.depth === 0 && b.ctx.createdAtS === undefined) userBlocks++;
      return;
    }
    if (b.type !== "text_chunk" && b.type !== "text_done") return;
    if (b.ctx.depth !== 0) return;
    const rid = b.ctx.responseId;
    if (b.type === "text_chunk") {
      if (b.ctx.createdAtS !== undefined) return;
      const key = `${rid}#${lastFinalAt.get(rid) ?? -1}`;
      const source = sources.get(key);
      if (source) source.raw += b.text;
      else sources.set(key, { responseId: rid, raw: b.text });
      return;
    }
    if (b.interrupted) return;
    if (b.ctx.itemId?.startsWith(LIVE_ITEM_PREFIX)) {
      if (b.ctx.createdAtS === undefined) {
        sources.set(b.ctx.itemId, { responseId: rid, raw: b.fullText });
      }
      return;
    }
    lastFinalAt.set(rid, index);
    finals.push({
      key: b.ctx.itemId ?? `${rid}:final:${index}`,
      responseId: rid,
      fullText: b.fullText,
      fromHistory: b.ctx.createdAtS !== undefined,
    });
  });
  return { sources, finals, userBlocks };
}

export interface UseAeSpeakRepliesArgs {
  chatId: string | null;
  enabled: boolean;
  voice: VoiceChoice | null;
  /** Voice mode is on: a change here drops the per-response voice lock. */
  voiceMode?: boolean;
  rate: number;
}

export function useAeSpeakReplies({
  chatId,
  enabled,
  voice,
  voiceMode = false,
  rate,
}: UseAeSpeakRepliesArgs): {
  speaking: boolean;
  stop: () => void;
  readLast: () => void;
  /** Speaks one line in the chosen voice (Voice mode reads question cards with it). */
  speak: (text: string) => void;
} {
  const optsRef = useRef({ voice, rate, voiceMode });
  optsRef.current = { voice, rate, voiceMode };

  const speaking = useSyncExternalStore(
    (cb) => getSpeaker().subscribe(cb),
    () => getSpeaker().speaking(),
    () => false,
  );

  // The Voice panel reads the refused-playback flag and the spoken sentence from the chat's snapshot.
  const blocked = usePlaybackBlocked();
  useEffect(() => {
    if (chatId) setVoiceBlocked(chatId, blocked);
  }, [chatId, blocked]);
  useEffect(() => {
    if (!chatId) return;
    setCaptionHandler((text) => {
      setVoiceCaption(chatId, text);
      recordSpoken(text);
    });
    setPlaybackHandler((playing) => setVoicePlaying(chatId, playing));
    return () => {
      setCaptionHandler(null);
      setPlaybackHandler(null);
      setVoiceCaption(chatId, "");
      // A chat change or an unmount mid-reply must not leave the echo window open.
      setVoicePlaying(chatId, false);
      resetEcho();
    };
  }, [chatId]);

  useEffect(() => {
    if (!enabled || !chatId) return;
    const speaker = getSpeaker();
    const handled = new Set<string>();
    const knownResponses = new Set<string>();
    const offsets = new Map<string, number>();
    const trails = new Map<string, { last: string }>();
    // Responses still streaming when the user sent: their late finals are old-turn text.
    const staleResponses = new Set<string>();
    // Sentences already spoken this turn, so a final never repeats its preview.
    const spoken = new Set<string>();
    let cueTimer: ReturnType<typeof setTimeout> | null = null;
    // The Working on it cue is playing (it always uses the device voice): the real reply cuts it.
    let cueActive = false;
    let cueUnsub: (() => void) | null = null;
    // The cue is over (cut, replaced or finished on its own): stop watching the device speaker.
    const endCue = () => {
      cueActive = false;
      cueUnsub?.();
      cueUnsub = null;
    };
    // Responses whose first chunk was spoken: later text of a response keeps the normal chunking.
    const started = new Set<string>();
    let spokenThisTurn = false;
    let synced = false;
    let prevStatus: "idle" | "streaming" = "idle";
    let prevPending = 0;
    let prevIds: string[] = [];
    let prevUserBlocks = 0;

    const clearCue = () => {
      if (cueTimer !== null) clearTimeout(cueTimer);
      cueTimer = null;
    };
    // `trail.last` is the key of the sentence before the next one in the same message,
    // so a code block phrase is keyed by its place in the message, not by its text.
    const sentenceKeys = (markdown: string, start: string) => {
      let last = start;
      const text = speechTextFromMarkdown(markdown.replace(/^[.!?\s]+/, ""));
      return splitSentences(text).flatMap((sentence) => {
        const norm = normalizeSentence(sentence);
        if (norm === "") return [];
        const key = norm === CODE_BLOCK_KEY ? `code@${last}` : norm;
        last = key;
        return [{ sentence, key }];
      });
    };
    // One engine per response: its first spoken sentence locks the voice for the rest of it
    // (and its final), so a late cloud list or a menu pick never overlaps the two queues.
    // A lock made in another Voice mode state is dropped, so the next chunk uses the voice that
    // now applies (the Voice chat voice only speaks while Voice mode is on).
    const locks = new Map<string, VoiceChoice | null>();
    const lockModes = new Map<string, boolean>();
    const lockFor = (responseId: string): VoiceChoice | null => {
      for (const [id, mode] of lockModes) {
        if (mode !== optsRef.current.voiceMode) {
          locks.delete(id);
          lockModes.delete(id);
        }
      }
      if (!locks.has(responseId)) {
        lockModes.set(responseId, optsRef.current.voiceMode);
        const cue = locks.get(CUE_LOCK);
        const first = [...locks.keys()].every((k) => k === CUE_LOCK);
        locks.set(responseId, first && cue !== undefined ? cue : optsRef.current.voice);
      }
      return locks.get(responseId) ?? null;
    };
    const speakNew = (markdown: string, trail: { last: string }, responseId: string) => {
      const fresh: string[] = [];
      for (const { sentence, key } of sentenceKeys(markdown, trail.last)) {
        trail.last = key;
        if (spoken.has(key)) continue;
        spoken.add(key);
        fresh.push(sentence);
      }
      if (fresh.length === 0) return;
      // A tap on the speaker silenced this turn: the sentences count as read, none is spoken.
      if (getVoiceSnapshot(chatId).barged) return;
      spokenThisTurn = true;
      clearCue();
      // The cue must not delay the real reply, nor queue ahead of its first chunk.
      if (cueActive) {
        endCue();
        getDevice().stop();
      }
      // The first speech of a reply opens with a short phrase so the voice starts sooner.
      const shortFirst = !started.has(responseId);
      started.add(responseId);
      say(fresh.join(" "), lockFor(responseId), optsRef.current.rate, shortFirst);
    };
    // Existing finals are handled and in-flight sources start at their current length, so
    // nothing already on screen is read back. Only a live source seeds the spoken set, and
    // only when tracking starts or reconnects: a send must not carry the old turn over.
    const snapshot = (blocks: readonly AnyBlock[], seedLive: boolean) => {
      handled.clear();
      knownResponses.clear();
      offsets.clear();
      trails.clear();
      spoken.clear();
      locks.clear();
      lockModes.clear();
      started.clear();
      for (const b of blocks) if (b.ctx.itemId) handled.add(b.ctx.itemId);
      const scan = scanBlocks(blocks);
      for (const f of scan.finals) handled.add(f.key);
      for (const [key, source] of scan.sources) {
        knownResponses.add(source.responseId);
        offsets.set(key, source.raw.length);
        const { ready } = completeSentences(stripTldr(source.raw));
        const trail = { last: MESSAGE_START };
        for (const { key: k } of sentenceKeys(ready, trail.last)) {
          trail.last = k;
          if (seedLive) spoken.add(k);
        }
        trails.set(key, trail);
        if (!seedLive) staleResponses.add(source.responseId);
      }
    };

    const onChange = (state: ReturnType<typeof useChatStore.getState>) => {
      if (state.conversationId !== chatId) {
        synced = false;
        return;
      }
      const scan = scanBlocks(state.blocks);
      const pending = state.pendingUserMessages.length;
      if (!synced) {
        synced = true;
        prevStatus = state.status;
        prevPending = pending;
        prevIds = state.pendingUserMessages.map((m) => m.tempId);
        prevUserBlocks = scan.userBlocks;
        staleResponses.clear();
        snapshot(state.blocks, true);
        return;
      }
      // A promoted pending message shrinks the queue as its bubble appears; that is not a send.
      // A real send adds one entry and keeps the others; a rebuilt queue is not a send.
      const ids = state.pendingUserMessages.map((m) => m.tempId);
      const grew = pending > prevPending;
      const rebuilt =
        grew && (pending - prevPending > 1 || prevIds.some((id) => !ids.includes(id)));
      const sent =
        (grew && !rebuilt) || (scan.userBlocks > prevUserBlocks && pending >= prevPending);
      prevIds = ids;
      prevPending = pending;
      prevUserBlocks = scan.userBlocks;
      if (sent) {
        setVoiceBarged(chatId, false);
        speaker.stop();
        snapshot(state.blocks, false);
        spokenThisTurn = false;
        endCue();
        clearCue();
        cueTimer = setTimeout(() => {
          cueTimer = null;
          if (!spokenThisTurn) {
            spokenThisTurn = true;
            if (!locks.has(CUE_LOCK)) {
              locks.set(CUE_LOCK, optsRef.current.voice);
              lockModes.set(CUE_LOCK, optsRef.current.voiceMode);
            }
            // A cloud voice may take seconds to make the cue: the device voice says it at once.
            const cueVoice = locks.get(CUE_LOCK) ?? null;
            cueActive = true;
            cueUnsub?.();
            // The device speaker going idle means the cue finished on its own.
            cueUnsub = getDevice().subscribe(() => {
              if (!getDevice().speaking()) endCue();
            });
            say(
              WORKING_CUE_TEXT,
              cueVoice?.kind === "cloud" ? null : cueVoice,
              optsRef.current.rate,
            );
          }
        }, WORKING_CUE_DELAY_MS);
        prevStatus = state.status;
        return;
      }
      if (state.status === "idle" && prevStatus === "streaming") clearCue();
      prevStatus = state.status;

      for (const key of [...offsets.keys()]) if (!scan.sources.has(key)) offsets.delete(key);
      for (const key of [...trails.keys()]) if (!scan.sources.has(key)) trails.delete(key);
      for (const [key, source] of scan.sources) {
        knownResponses.add(source.responseId);
        const offset = offsets.get(key) ?? 0;
        const stripped = stripTldr(source.raw);
        const { ready } = completeSentences(stripped.slice(offset));
        if (ready === "") continue;
        offsets.set(key, offset + ready.length);
        let trail = trails.get(key);
        if (!trail) {
          trail = { last: MESSAGE_START };
          trails.set(key, trail);
        }
        speakNew(ready, trail, source.responseId);
      }
      for (const f of scan.finals) {
        if (handled.has(f.key)) continue;
        // A final from a refetch counts only when part of it was streamed live here.
        if (f.fromHistory && !knownResponses.has(f.responseId)) continue;
        handled.add(f.key);
        if (staleResponses.has(f.responseId)) continue;
        speakNew(stripTldr(f.fullText), { last: MESSAGE_START }, f.responseId);
      }
    };

    const unsubscribe = useChatStore.subscribe(onChange);
    onChange(useChatStore.getState());
    return () => {
      unsubscribe();
      clearCue();
      endCue();
      speaker.stop();
      handled.clear();
      knownResponses.clear();
      offsets.clear();
      trails.clear();
      staleResponses.clear();
      spoken.clear();
      locks.clear();
      lockModes.clear();
      started.clear();
    };
  }, [enabled, chatId]);

  const stop = useCallback(() => getSpeaker().stop(), []);

  const readLast = useCallback(() => {
    const blocks = useChatStore.getState().blocks;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.type !== "text_done" || b.ctx.depth !== 0 || b.interrupted) continue;
      if (b.ctx.itemId?.startsWith(LIVE_ITEM_PREFIX) || b.fullText.trim() === "") continue;
      const text = speechTextFromMarkdown(stripTldr(b.fullText));
      if (text === "") continue;
      const { voice: picked, rate: pickedRate } = optsRef.current;
      // The voice log shows which voice a manual read used, to compare with the spoken replies.
      logVoice("read last", picked ? `${picked.kind}:${picked.id} x${pickedRate}` : "default");
      getSpeaker().stop();
      // After stop(), which pauses and clears a primed element; still synchronous inside the tap.
      if (picked?.kind === "cloud") primeCloudPlayback();
      say(text, picked, pickedRate);
      return;
    }
  }, []);

  const speak = useCallback(
    (text: string) => say(text, optsRef.current.voice, optsRef.current.rate),
    [],
  );

  return { speaking, stop, readLast, speak };
}
