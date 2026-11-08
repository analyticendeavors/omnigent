// Reads assistant replies aloud as they stream into the visible chat. Only live
// depth-0 text is spoken: history, sub-agent text and interrupted partials are not.

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  createSpeaker,
  type Speaker,
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
import { type AnyBlock, LIVE_ITEM_PREFIX } from "@/lib/blocks";
import { useChatStore } from "@/store/chatStore";

let sharedSpeaker: Speaker | null = null;
function getSpeaker(): Speaker {
  sharedSpeaker ??= createSpeaker();
  return sharedSpeaker;
}

const CODE_BLOCK_KEY = normalizeSentence(CODE_BLOCK_PHRASE);

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
  voiceURI: string | null;
  rate: number;
}

export function useAeSpeakReplies({ chatId, enabled, voiceURI, rate }: UseAeSpeakRepliesArgs): {
  speaking: boolean;
  stop: () => void;
  readLast: () => void;
} {
  const optsRef = useRef({ voiceURI, rate });
  optsRef.current = { voiceURI, rate };

  const speaking = useSyncExternalStore(
    (cb) => getSpeaker().subscribe(cb),
    () => getSpeaker().speaking(),
    () => false,
  );

  useEffect(() => {
    if (!enabled || !chatId) return;
    const speaker = getSpeaker();
    const handled = new Set<string>();
    const knownResponses = new Set<string>();
    const offsets = new Map<string, number>();
    // Sentences already spoken this turn, so a final never repeats its preview.
    const spoken = new Set<string>();
    let cueTimer: ReturnType<typeof setTimeout> | null = null;
    let spokenThisTurn = false;
    let synced = false;
    let prevStatus: "idle" | "streaming" = "idle";
    let prevPending = 0;
    let prevUserBlocks = 0;

    const clearCue = () => {
      if (cueTimer !== null) clearTimeout(cueTimer);
      cueTimer = null;
    };
    const speakNew = (markdown: string) => {
      // A reply joined mid-sentence leaves the sentence's end mark at the start.
      const text = speechTextFromMarkdown(markdown.replace(/^[.!?\s]+/, ""));
      const fresh: string[] = [];
      for (const sentence of splitSentences(text)) {
        const key = normalizeSentence(sentence);
        if (key === "") continue;
        if (key === CODE_BLOCK_KEY) {
          fresh.push(sentence);
        } else if (!spoken.has(key)) {
          spoken.add(key);
          fresh.push(sentence);
        }
      }
      if (fresh.length === 0) return;
      spokenThisTurn = true;
      clearCue();
      speaker.speak(fresh.join(" "), optsRef.current);
    };
    // Everything already on screen counts as handled so it is never read back.
    const snapshot = (blocks: readonly AnyBlock[]) => {
      handled.clear();
      knownResponses.clear();
      offsets.clear();
      spoken.clear();
      for (const b of blocks) if (b.ctx.itemId) handled.add(b.ctx.itemId);
      const scan = scanBlocks(blocks);
      for (const f of scan.finals) handled.add(f.key);
      for (const [key, source] of scan.sources) {
        knownResponses.add(source.responseId);
        offsets.set(key, source.raw.length);
        const { ready } = completeSentences(stripTldr(source.raw));
        for (const sentence of splitSentences(speechTextFromMarkdown(ready))) {
          spoken.add(normalizeSentence(sentence));
        }
      }
      for (const f of scan.finals) {
        for (const sentence of splitSentences(speechTextFromMarkdown(stripTldr(f.fullText)))) {
          spoken.add(normalizeSentence(sentence));
        }
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
        prevUserBlocks = scan.userBlocks;
        snapshot(state.blocks);
        return;
      }
      // A promoted pending message shrinks the queue as its bubble appears; that is not a send.
      const sent =
        pending > prevPending || (scan.userBlocks > prevUserBlocks && pending >= prevPending);
      prevPending = pending;
      prevUserBlocks = scan.userBlocks;
      if (sent) {
        speaker.stop();
        snapshot(state.blocks);
        spokenThisTurn = false;
        clearCue();
        cueTimer = setTimeout(() => {
          cueTimer = null;
          if (!spokenThisTurn) {
            spokenThisTurn = true;
            speaker.speak(WORKING_CUE_TEXT, optsRef.current);
          }
        }, WORKING_CUE_DELAY_MS);
        prevStatus = state.status;
        return;
      }
      if (state.status === "idle" && prevStatus === "streaming") clearCue();
      prevStatus = state.status;

      for (const [key, source] of scan.sources) {
        knownResponses.add(source.responseId);
        const offset = offsets.get(key) ?? 0;
        const stripped = stripTldr(source.raw);
        const { ready } = completeSentences(stripped.slice(offset));
        if (ready === "") continue;
        offsets.set(key, offset + ready.length);
        speakNew(ready);
      }
      for (const f of scan.finals) {
        if (handled.has(f.key)) continue;
        // A final from a refetch counts only when part of it was streamed live here.
        if (f.fromHistory && !knownResponses.has(f.responseId)) continue;
        handled.add(f.key);
        speakNew(stripTldr(f.fullText));
      }
    };

    const unsubscribe = useChatStore.subscribe(onChange);
    onChange(useChatStore.getState());
    return () => {
      unsubscribe();
      clearCue();
      speaker.stop();
      handled.clear();
      knownResponses.clear();
      offsets.clear();
      spoken.clear();
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
      const speaker = getSpeaker();
      speaker.stop();
      speaker.speak(text, optsRef.current);
      return;
    }
  }, []);

  return { speaking, stop, readLast };
}
