// Natural cloud voices for Speak replies: the voice list, and a speaker that plays
// one server-made mp3 per sentence in order. A sentence the server cannot make is
// read by the device speaker instead, so an outage still speaks.

import type { Speaker, SpeakOptions } from "./aeSpeakReplies";
import { splitForSpeech } from "./aeSpeechText";
import { withBasePath } from "./basePath";
import { authenticatedFetch } from "./identity";

export interface CloudVoice {
  id: string;
  name: string;
}

const LOOKAHEAD = 2;

let voicesCache: Promise<CloudVoice[]> | null = null;

export function resetCloudVoicesCache(): void {
  voicesCache = null;
}

/** The server's natural voices; empty when it offers none or cannot be reached. */
export function fetchCloudVoices(): Promise<CloudVoice[]> {
  voicesCache ??= (async () => {
    try {
      const response = await authenticatedFetch(withBasePath("/v1/ae/tts/voices"));
      if (response.status !== 200) return [];
      const body = (await response.json()) as { voices?: CloudVoice[] };
      return Array.isArray(body.voices) ? body.voices : [];
    } catch {
      return [];
    }
  })();
  return voicesCache;
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
    listeners.forEach((cb) => cb());
  };

  const pump = () => {
    for (const item of queue.slice(0, LOOKAHEAD)) {
      if (inflight >= LOOKAHEAD) return;
      if (item.result) continue;
      const controller = new AbortController();
      item.controller = controller;
      inflight++;
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
        .then((r) => (r.ok ? r.blob() : null))
        .catch(() => null)
        .finally(() => {
          inflight--;
          pump();
        });
    }
  };

  const play = (blob: Blob): Promise<boolean> => {
    audio ??= new Audio();
    const el = audio;
    const url = URL.createObjectURL(blob);
    return new Promise<boolean>((resolve) => {
      const finish = (ok: boolean) => {
        el.onended = null;
        el.onerror = null;
        release = null;
        URL.revokeObjectURL(url);
        resolve(ok);
      };
      release = () => finish(true);
      el.onended = () => finish(true);
      el.onerror = () => finish(false);
      el.src = url;
      try {
        void Promise.resolve(el.play()).catch(() => finish(false));
      } catch {
        finish(false);
      }
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
      return;
    }
    pump();
    const blob = await item.result;
    if (gen !== generation) return;
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
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
      }
      fallback.stop();
      setSpeaking(false);
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
