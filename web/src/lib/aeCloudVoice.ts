// Natural cloud voices for Speak replies: the voice list, and a speaker that plays
// one server-made mp3 per sentence in order. A sentence the server cannot make is
// read by the device speaker instead, so an outage still speaks.

import { emitCaption, emitPlaying, type Speaker, type SpeakOptions } from "./aeSpeakReplies";
import { splitForSpeech } from "./aeSpeechText";
import { speakerSinkId } from "./aeAudioDevices";
import { clearPlaybackBlocked, markPlaybackBlocked } from "./aeVoicePlayback";
import { logVoice } from "./aeVoiceLog";
import { withBasePath } from "./basePath";
import { authenticatedFetch } from "./identity";

export interface CloudVoice {
  id: string;
  name: string;
}

const LOOKAHEAD = 2;

/** A 44-byte WAV header and 8 silent 8-bit samples; playing it in a tap unlocks the audio element. */
function silentWavUri(): string {
  const samples = 8;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  tag(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return `data:audio/wav;base64,${btoa(binary)}`;
}
const SILENT_WAV = silentWavUri();

// Only a successful list is kept; a failure is retried by the next call, one request at a time.
let voicesCache: CloudVoice[] | null = null;
let voicesInflight: Promise<CloudVoice[]> | null = null;

export function resetCloudVoicesCache(): void {
  voicesCache = null;
  voicesInflight = null;
}

/** The server's natural voices; empty when it offers none or cannot be reached. */
export function fetchCloudVoices(): Promise<CloudVoice[]> {
  if (voicesCache) return Promise.resolve(voicesCache);
  voicesInflight ??= (async () => {
    try {
      const response = await authenticatedFetch(withBasePath("/v1/ae/tts/voices"));
      if (response.status !== 200) return [];
      const body = (await response.json()) as { voices?: CloudVoice[] };
      const list = Array.isArray(body.voices) ? body.voices : [];
      voicesCache = list;
      return list;
    } catch {
      return [];
    } finally {
      voicesInflight = null;
    }
  })();
  return voicesInflight;
}

interface Item {
  text: string;
  opts: SpeakOptions;
  controller: AbortController | null;
  result: Promise<Blob | null> | null;
}

export function createCloudSpeaker(fallback: Speaker): Speaker {
  const listeners = new Set<() => void>();
  // Bumped by stop() so a cancelled run and its late responses are ignored.
  let generation = 0;
  let queue: Item[] = [];
  let running = false;
  let isSpeaking = false;
  let inflight = 0;
  let audio: HTMLAudioElement | null = null;
  // Releases whatever the run is waiting on (the audio, or the device speaker).
  let release: (() => void) | null = null;

  const setSpeaking = (next: boolean) => {
    if (isSpeaking === next) return;
    isSpeaking = next;
    if (!next) emitPlaying(false);
    listeners.forEach((cb) => cb());
  };

  const pump = () => {
    for (const item of queue.slice(0, LOOKAHEAD)) {
      if (inflight >= LOOKAHEAD) return;
      if (item.result) continue;
      const controller = new AbortController();
      item.controller = controller;
      inflight++;
      const t0 = Date.now();
      logVoice("tts fetch");
      item.result = authenticatedFetch(withBasePath("/v1/ae/tts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: item.text,
          voice: item.opts.cloudVoiceId,
          rate: item.opts.rate,
        }),
        signal: controller.signal,
      })
        .then((r) => {
          if (r.ok) logVoice("tts ok", `${Date.now() - t0} ms`);
          else logVoice("tts fail", String(r.status));
          return r.ok ? r.blob() : null;
        })
        .catch(() => null)
        .finally(() => {
          inflight--;
          pump();
        });
    }
  };

  // Route to the saved speaker; a sink failure falls back to the default and never drops a sentence.
  const applySink = async (el: HTMLAudioElement): Promise<void> => {
    if (typeof el.setSinkId !== "function") return;
    const want = speakerSinkId();
    if (want === el.sinkId) return;
    try {
      await el.setSinkId(want);
    } catch {
      try {
        await el.setSinkId("");
      } catch {
        // Keep playing on whatever sink the element has.
      }
    }
  };

  let playToken = 0;
  const play = (blob: Blob): Promise<boolean> => {
    audio ??= new Audio();
    const el = audio;
    const url = URL.createObjectURL(blob);
    const token = ++playToken;
    return new Promise<boolean>((resolve) => {
      // A late call from a stopped playback must not touch the next one's handlers.
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (token === playToken) {
          el.onended = null;
          el.onerror = null;
          el.onplaying = null;
          release = null;
        }
        URL.revokeObjectURL(url);
        resolve(ok);
      };
      release = () => finish(true);
      el.onended = () => {
        logVoice("play end");
        finish(true);
      };
      el.onerror = () => {
        logVoice("play error", `media ${el.error?.code}`);
        finish(false);
      };
      // The audio is really playing now, not just queued or still being made.
      el.onplaying = () => emitPlaying(true);
      el.src = url;
      logVoice("play start");
      // A refused play() is not a failure: the item stays current until a tap plays it again.
      const refuse = (e: unknown): boolean => {
        // A late rejection after stop() must not mark blocked again with a dead resume.
        if (settled) return true;
        const name = (e as { name?: string } | null)?.name;
        if (name !== "NotAllowedError") {
          logVoice("play error", String(name));
          return false;
        }
        logVoice("play blocked");
        markPlaybackBlocked(() => {
          void Promise.resolve(el.play())
            .then(clearPlaybackBlocked)
            .catch(() => {});
        });
        return true;
      };
      void applySink(el).then(() => {
        if (settled) return;
        try {
          void Promise.resolve(el.play()).catch((e: unknown) => {
            if (!refuse(e)) finish(false);
          });
        } catch (e) {
          if (!refuse(e)) finish(false);
        }
      });
    });
  };

  const readByDevice = (item: Item): Promise<void> =>
    new Promise<void>((resolve) => {
      let unsubscribe: () => void = () => {};
      const done = () => {
        unsubscribe();
        release = null;
        resolve();
      };
      release = done;
      unsubscribe = fallback.subscribe(() => {
        if (!fallback.speaking()) done();
      });
      fallback.speak(item.text, { ...item.opts, cloudVoiceId: null });
      if (!fallback.speaking()) done();
    });

  // Plays the head of the queue, then the next; a stop() or newer run ends this one.
  const step = async (gen: number): Promise<void> => {
    if (gen !== generation) return;
    const item = queue[0];
    if (!item) {
      running = false;
      setSpeaking(false);
      emitCaption("");
      return;
    }
    pump();
    const blob = await item.result;
    if (gen !== generation) return;
    if (blob !== null) emitCaption(item.text);
    const played = blob !== null && (await play(blob));
    if (gen !== generation) return;
    if (!played) {
      await readByDevice(item);
      if (gen !== generation) return;
    }
    queue.shift();
    pump();
    return step(gen);
  };

  return {
    speak(text, opts) {
      const chunks = splitForSpeech(text);
      if (chunks.length === 0) return;
      for (const chunk of chunks) {
        queue.push({ text: chunk, opts, controller: null, result: null });
      }
      setSpeaking(true);
      pump();
      if (!running) {
        running = true;
        void step(generation);
      }
    },
    stop() {
      generation++;
      for (const item of queue) item.controller?.abort();
      queue = [];
      running = false;
      release?.();
      release = null;
      clearPlaybackBlocked();
      emitCaption("");
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
      }
      fallback.stop();
      setSpeaking(false);
    },
    // Plays a silent clip inside a tap so later replies may play without one.
    prime() {
      // A sentence is queued or refused: its own play() is the unlock, and the element holds it.
      if (isSpeaking) return;
      try {
        audio ??= new Audio();
        const el = audio;
        el.src = SILENT_WAV;
        void Promise.resolve(el.play())
          .then(() => {
            // A real sentence may have taken the element over since the tap.
            if (el.src === SILENT_WAV) el.pause();
          })
          .catch(() => {});
      } catch {
        // Priming is best effort.
      }
    },
    speaking: () => isSpeaking,
    retained: () => fallback.retained(),
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
