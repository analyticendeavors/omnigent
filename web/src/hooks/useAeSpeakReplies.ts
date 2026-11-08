// Reads assistant replies aloud as they stream into the visible chat. Only live
// depth-0 text is spoken: history, sub-agent text and interrupted partials are not.

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  createSpeaker,
  type Speaker,
  WORKING_CUE_DELAY_MS,
  WORKING_CUE_TEXT,
} from "@/lib/aeSpeakReplies";
import { completeSentences, speechTextFromMarkdown, stripTldr } from "@/lib/aeSpeechText";
import { type AnyBlock, LIVE_ITEM_PREFIX, type TextDone } from "@/lib/blocks";
import { useChatStore } from "@/store/chatStore";

let sharedSpeaker: Speaker | null = null;
function getSpeaker(): Speaker {
  sharedSpeaker ??= createSpeaker();
  return sharedSpeaker;
}

interface ResponseTrack {
  /** Raw markdown characters of this response already handed to the speaker. */
  spokenRawEnd: number;
  raw: string;
  done: boolean;
}

interface ResponseGroup {
  chunks: string[];
  live: TextDone | null;
  finals: TextDone[];
}

function isSpeakable(b: AnyBlock): b is AnyBlock & { type: "text_chunk" | "text_done" } {
  if (b.type !== "text_chunk" && b.type !== "text_done") return false;
  if (b.ctx.depth !== 0 || b.ctx.createdAtS !== undefined) return false;
  return !(b.type === "text_done" && b.interrupted);
}

function groupByResponse(blocks: readonly AnyBlock[]): Map<string, ResponseGroup> {
  const groups = new Map<string, ResponseGroup>();
  for (const b of blocks) {
    if (!isSpeakable(b)) continue;
    let g = groups.get(b.ctx.responseId);
    if (!g) {
      g = { chunks: [], live: null, finals: [] };
      groups.set(b.ctx.responseId, g);
    }
    if (b.type === "text_chunk") g.chunks.push(b.text);
    else if (b.ctx.itemId?.startsWith(LIVE_ITEM_PREFIX)) g.live = b;
    else g.finals.push(b);
  }
  return groups;
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
    let responses = new Map<string, ResponseTrack>();
    let cueTimer: ReturnType<typeof setTimeout> | null = null;
    let spokenThisTurn = false;
    let synced = false;
    let prevStatus: "idle" | "streaming" = "idle";

    const clearCue = () => {
      if (cueTimer !== null) clearTimeout(cueTimer);
      cueTimer = null;
    };
    const say = (markdown: string) => {
      // A reply joined mid-sentence leaves the sentence's end mark at the start.
      const text = speechTextFromMarkdown(markdown.replace(/^[.!?\s]+/, ""));
      if (text === "") return;
      spokenThisTurn = true;
      clearCue();
      speaker.speak(text, optsRef.current);
    };
    // Everything already on screen counts as handled so it is never read back.
    const snapshot = (blocks: readonly AnyBlock[]) => {
      handled.clear();
      responses = new Map();
      for (const b of blocks) if (b.ctx.itemId) handled.add(b.ctx.itemId);
      for (const [rid, g] of groupByResponse(blocks)) {
        const raw = g.live?.fullText ?? g.chunks.join("");
        if (raw !== "") responses.set(rid, { spokenRawEnd: raw.length, raw, done: false });
      }
    };

    const onChange = (state: ReturnType<typeof useChatStore.getState>) => {
      if (state.conversationId !== chatId) {
        synced = false;
        return;
      }
      if (!synced) {
        synced = true;
        prevStatus = state.status;
        snapshot(state.blocks);
        return;
      }
      if (prevStatus === "idle" && state.status === "streaming") {
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
      } else if (prevStatus === "streaming" && state.status === "idle") {
        clearCue();
      }
      prevStatus = state.status;

      for (const [rid, g] of groupByResponse(state.blocks)) {
        const track = responses.get(rid) ?? { spokenRawEnd: 0, raw: "", done: false };
        responses.set(rid, track);
        for (const f of g.finals) {
          const key = f.ctx.itemId ?? `${rid}:final`;
          if (handled.has(key)) continue;
          handled.add(key);
          const stripped = stripTldr(f.fullText);
          const spokenPrefix = track.raw.slice(0, track.spokenRawEnd);
          const continues = track.spokenRawEnd > 0 && f.fullText.startsWith(spokenPrefix);
          say(continues ? stripped.slice(track.spokenRawEnd) : stripped);
          track.done = true;
        }
        if (track.done) continue;
        const raw = g.live?.fullText ?? g.chunks.join("");
        if (raw === "") continue;
        track.raw = raw;
        const { ready } = completeSentences(stripTldr(raw).slice(track.spokenRawEnd));
        if (ready !== "") {
          track.spokenRawEnd += ready.length;
          say(ready);
        }
      }
    };

    const unsubscribe = useChatStore.subscribe(onChange);
    onChange(useChatStore.getState());
    return () => {
      unsubscribe();
      clearCue();
      speaker.stop();
      handled.clear();
      responses = new Map();
    };
  }, [enabled, chatId]);

  const stop = useCallback(() => getSpeaker().stop(), []);

  const readLast = useCallback(() => {
    const blocks = useChatStore.getState().blocks;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.type !== "text_done" || b.ctx.depth !== 0 || b.fullText.trim() === "") continue;
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
