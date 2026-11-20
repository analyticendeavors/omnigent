// Server-side dictation transport: mic → 16 kHz PCM → WS /v1/dictation/stream.
//
// ComposerMicButton uses this as the fallback when the browser Web Speech API
// has no working backend (Electron, Firefox/Chromium — see
// web/electron/README.md). One DictationSession is one dictation take: it
// owns the microphone stream, an AudioWorklet that downsamples the capture
// rate to 16 kHz mono s16le, and the WebSocket that streams those frames to
// the server and receives transcript events back. The wire protocol is
// documented in omnigent/server/routes/dictation.py; availability is gated
// by the `dictation_available` capability from GET /v1/info.
//
// The WebSocket URL rides the host seam (`resolveWebSocketUrl`) exactly like
// the terminal-attach and session-updates sockets, so embed hosts and the
// Vite dev proxy keep working. Identity rides the ingress/dev proxy on the
// handshake, as with those sockets.

import { getMicStream } from "@/lib/aeAudioDevices";
import { logVoice } from "@/lib/aeVoiceLog";
import { getSharedVoiceAudioContext, isIosDevice } from "@/lib/aeVoiceServerStt";
import { getOmnigentHostConfig, resolveWebSocketUrl } from "@/lib/host";
import { modalHostId } from "@/lib/sessionHost";

/**
 * Build the `ws(s)://` URL for the dictation stream.
 *
 * When a host fetcher is installed, append `?omnigent_slice_key=<modal host>` —
 * the same query-param seam the session-updates and terminal-attach sockets use
 * (a browser WS handshake can't set request headers). Dictation is NOT
 * host-scoped — any replica transcribes a take equally, so correctness is
 * unaffected either way. It's a LOAD-BALANCING lever: without a key, the default
 * route hashes a whole tenant onto one replica, so a busy tenant's mic takes all
 * pile onto a single replica — bad for a CPU-bound engine with a per-replica
 * concurrent-take cap ({@link DictationBusyError} / `OMNIGENT_DICTATION_MAX_STREAMS`).
 * {@link modalHostId} is per-user (the host backing most of THIS user's
 * sessions), so keying by it spreads a tenant's takes across many replicas —
 * finer-grained than per-tenant. Omitted on an unsharded server and until the
 * modal host resolves (→ no key → default route).
 */
function buildDictationUrl(): string {
  const path = "/v1/dictation/stream";
  if (!getOmnigentHostConfig().fetcher) return resolveWebSocketUrl(path);
  const sliceKey = modalHostId();
  return resolveWebSocketUrl(
    sliceKey ? `${path}?omnigent_slice_key=${encodeURIComponent(sliceKey)}` : path,
  );
}

/** A transcript event pushed by the server over the dictation stream. */
export type DictationEvent =
  | { type: "ready" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "stopped"; text: string }
  | { type: "error"; message: string };

export interface DictationSessionEvents {
  /** Revisable in-progress utterance (server-throttled to ~6 Hz). */
  onPartial: (text: string) => void;
  /** An utterance completed by a pause; append it and clear the partial. */
  onFinal: (text: string) => void;
  /** Fatal error after start. The session has already cleaned itself up. */
  onError: (message: string) => void;
  /** Peak level (0..1) of each 100 ms chunk, for a meter that must not open a second capture. */
  onLevel?: (level: number) => void;
  /** The deaf check fired: the take heard only silence (or a muted track) for too long. */
  onDeaf?: (reason: "silent" | "muted") => void;
}

export interface DictationStartOptions {
  /** Watch the take for silence or a muted track and report it through `onDeaf`. */
  deafCheck?: boolean;
}

/** All-zero audio, or a muted track, for this long means the take is deaf. */
export const DEAF_SILENT_MS = 4_000;
const DEAF_TICK_MS = 500;
/** How long start() waits for a resumed AudioContext to run before going on. */
const CTX_RESUME_CAP_MS = 500;

/**
 * The server was reachable but at its concurrent-take cap (WS close 1013).
 * Transient by definition — callers should message "busy, try again",
 * not "unavailable".
 */
export class DictationBusyError extends Error {}

/**
 * Parse one text frame from the dictation socket into a typed event.
 * Returns null for frames that don't match the protocol (ignored for
 * forward compatibility, mirroring the server's posture on control
 * messages it doesn't know).
 */
export function parseDictationEvent(raw: string): DictationEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const frame = data as { type?: unknown; text?: unknown; message?: unknown };
  switch (frame.type) {
    case "ready":
      return { type: "ready" };
    case "partial":
    case "final":
    case "stopped":
      return typeof frame.text === "string" ? { type: frame.type, text: frame.text } : null;
    case "error":
      return typeof frame.message === "string" ? { type: "error", message: frame.message } : null;
    default:
      return null;
  }
}

// Client budgets must exceed the server's own worst cases or takes fail
// spuriously right when they'd have succeeded:
// - ready: engine construction loads model weights on the first take, and
//   the remote-relay path allows the worker 30 s for its own cold load
//   (_REMOTE_READY_TIMEOUT_S in omnigent/server/dictation.py).
// - stop: the relay waits up to 10 s (_REMOTE_STOP_TIMEOUT_S) for the
//   worker to flush the tail; resolving earlier would drop the user's
//   last words even though they were transcribed moments later.
const READY_TIMEOUT_MS = 40_000;
const STOP_TIMEOUT_MS = 15_000;

// How long stop() waits for the worklet to post its final partial chunk
// before tearing the audio graph down. Message-port turnaround is
// milliseconds; this is only a stuck-worklet backstop.
const FLUSH_TIMEOUT_MS = 250;

/** WS close code the server sends when at its concurrent-take cap. */
const WS_CLOSE_TRY_AGAIN_LATER = 1013;

const TARGET_RATE = 16_000;

/** Wait for a context's resume(), but never longer than the cap (iOS may leave it pending). */
async function resumeCapped(ctx: AudioContext): Promise<void> {
  try {
    await Promise.race([
      Promise.resolve(ctx.resume?.()),
      new Promise<void>((resolve) => {
        setTimeout(resolve, CTX_RESUME_CAP_MS);
      }),
    ]);
  } catch {
    // Best effort: the state is logged by the caller.
  }
}

const workletReady = new WeakSet<AudioContext>();

// AudioWorklet processor, inlined as a Blob module so no separate asset has
// to survive the Vite build. Linear-interpolation downsample from the
// context capture rate to 16 kHz, Float32 → Int16, posted in 100 ms chunks.
// (When the context already runs at 16 kHz — we ask for that — the step is
// 1 and the loop degenerates to a plain format conversion.)
//
// Any message on the port means "flush": the partially-filled chunk is
// posted, then a null marker — so stop() can capture trailing speech that
// hasn't crossed the 100 ms boundary before tearing the graph down.
const WORKLET_SOURCE = `
const TARGET_RATE = ${TARGET_RATE};
const CHUNK_SAMPLES = TARGET_RATE / 10; // 100 ms per posted chunk
class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE;
    this.pos = 0; // fractional read position, carried across blocks
    this.pending = new Int16Array(CHUNK_SAMPLES);
    this.filled = 0;
    this.port.onmessage = () => {
      if (this.filled > 0) {
        const out = this.pending.slice(0, this.filled);
        this.filled = 0;
        this.port.postMessage(out, [out.buffer]);
      }
      this.port.postMessage(null);
    };
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;
    let pos = this.pos;
    while (pos < channel.length) {
      const i = Math.floor(pos);
      const s0 = channel[i];
      const s1 = i + 1 < channel.length ? channel[i + 1] : s0;
      const sample = s0 + (s1 - s0) * (pos - i);
      const clamped = Math.max(-1, Math.min(1, sample));
      this.pending[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      if (this.filled === CHUNK_SAMPLES) {
        const out = this.pending;
        this.pending = new Int16Array(CHUNK_SAMPLES);
        this.filled = 0;
        this.port.postMessage(out, [out.buffer]);
      }
      pos += this.step;
    }
    this.pos = pos - channel.length;
    return true;
  }
}
registerProcessor("omnigent-pcm16-downsampler", Pcm16Downsampler);
`;

let cachedWorkletUrl: string | null = null;

function workletUrl(): string {
  if (cachedWorkletUrl === null) {
    cachedWorkletUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
    );
  }
  return cachedWorkletUrl;
}

/**
 * One live dictation take against the server recognizer.
 *
 * Construct via {@link DictationSession.start}, which resolves once the
 * mic, audio graph, and socket handshake are all up — so a resolved
 * session is guaranteed to be streaming. End it with {@link stop} (flushes
 * the tail utterance) or {@link cancel} (immediate teardown, e.g. unmount).
 */
export class DictationSession {
  private readonly events: DictationSessionEvents;
  private readonly ws: WebSocket;
  private readonly mediaStream: MediaStream;
  private readonly audioContext: AudioContext;
  private readonly workletNode: AudioWorkletNode;
  private stopResolve: ((tail: string) => void) | null = null;
  private flushResolve: (() => void) | null = null;
  private closed = false;
  private readonly shared: boolean;
  private readonly graph: AudioNode[];
  private readonly createdAt = Date.now();
  // Take stats, logged at stop.
  private partials = 0;
  private finals = 0;
  private samplesSent = 0;
  private peak = 0;
  private firstSoundAt: number | null = null;
  private mutedSince: number | null = null;
  private deafTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(
    events: DictationSessionEvents,
    ws: WebSocket,
    mediaStream: MediaStream,
    audioContext: AudioContext,
    workletNode: AudioWorkletNode,
    shared: boolean,
    graph: AudioNode[],
    deafCheck: boolean,
  ) {
    this.events = events;
    this.ws = ws;
    this.mediaStream = mediaStream;
    this.audioContext = audioContext;
    this.workletNode = workletNode;
    this.shared = shared;
    this.graph = graph;
    for (const track of mediaStream.getTracks()) {
      track.addEventListener?.("mute", () => {
        logVoice("dictation track mute");
        if (this.mutedSince === null) this.mutedSince = Date.now();
      });
      track.addEventListener?.("unmute", () => {
        logVoice("dictation track unmute");
        this.mutedSince = null;
      });
      if (track.muted) this.mutedSince = Date.now();
    }
    if (deafCheck) this.deafTimer = setInterval(() => this.checkDeaf(), DEAF_TICK_MS);

    workletNode.port.onmessage = (msg: MessageEvent<Int16Array<ArrayBuffer> | null>) => {
      if (msg.data === null) {
        // Flush marker: the worklet has posted everything it had.
        this.flushResolve?.();
        this.flushResolve = null;
        return;
      }
      this.noteChunk(msg.data);
      if (ws.readyState === WebSocket.OPEN) ws.send(msg.data.buffer);
    };
    ws.onmessage = (msg) => {
      if (typeof msg.data !== "string") return;
      const event = parseDictationEvent(msg.data);
      if (event === null) return;
      if (event.type === "partial") {
        this.partials += 1;
        this.events.onPartial(event.text);
      } else if (event.type === "final") {
        this.finals += 1;
        this.events.onFinal(event.text);
      } else if (event.type === "stopped") this.resolveStop(event.text);
      else if (event.type === "error") this.fail(event.message);
    };
    ws.onclose = () => {
      // A close during stop() is the normal end of a take; any other
      // close means the server went away mid-dictation.
      if (this.stopResolve !== null) this.resolveStop("");
      else if (!this.closed) this.fail("Dictation connection closed");
    };
  }

  /**
   * Acquire the mic, open the socket, and wait for the server's ready
   * handshake. Rejects (with everything torn down) when the mic is
   * denied, the socket fails, the server is at capacity
   * ({@link DictationBusyError}), or the engine never comes up.
   */
  static async start(
    events: DictationSessionEvents,
    options: DictationStartOptions = {},
  ): Promise<DictationSession> {
    // The mic and the socket are opened together: each takes a few hundred ms and neither
    // needs the other.
    const t0 = Date.now();
    const micPromise = getMicStream({
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    }).then((stream) => {
      logVoice("dictation mic", `${Date.now() - t0} ms`);
      return stream;
    });
    const ws = new WebSocket(buildDictationUrl());
    ws.binaryType = "arraybuffer";
    const readyPromise = waitForReady(ws).then(() => {
      logVoice("dictation ws ready", `${Date.now() - t0} ms`);
    });
    // Fail fast: the first half to fail ends the start at once; a mic that opens late is
    // stopped as soon as it resolves.
    const failFast = new Promise<never>((_, reject) => {
      micPromise.catch((error) => {
        ws.close();
        reject(error);
      });
      readyPromise.catch((error) => {
        void micPromise.then(
          (stream) => {
            for (const track of stream.getTracks()) track.stop();
          },
          () => {},
        );
        ws.close();
        reject(error);
      });
    });
    const [mediaStream] = await Promise.race([Promise.all([micPromise, readyPromise]), failFast]);

    let audioContext: AudioContext | null = null;
    let shared = false;
    try {
      // Detect a close during the async audio-graph setup below: the
      // handler-swap in the constructor would otherwise never see it and
      // start() would resolve a dead session that silently drops audio.
      let closedDuringSetup = false;
      const markClosed = () => {
        closedDuringSetup = true;
      };
      ws.addEventListener("close", markClosed);

      const ios = isIosDevice();
      // On iOS a Voice tap made one context; reuse it (a new one made now, outside the tap,
      // would start suspended).
      const tapContext = ios ? getSharedVoiceAudioContext() : null;
      if (tapContext) {
        audioContext = tapContext;
        shared = true;
      } else if (ios) {
        // iOS runs at its native rate; the worklet downsamples. The rate hint is not asked for.
        // No Voice tap made a context (an auto-arm or chat switch): this one may stay suspended.
        logVoice("dictation ctx not unlocked", "no shared context, making one");
        audioContext = new AudioContext();
      } else {
        // Ask for the target rate directly — Chrome/Firefox resample the
        // capture for us and the worklet's downsampler becomes a no-op.
        // Some platforms reject the hint; the worklet handles any rate.
        try {
          audioContext = new AudioContext({ sampleRate: TARGET_RATE });
        } catch {
          audioContext = new AudioContext();
        }
      }
      await resumeCapped(audioContext);
      if (ios && audioContext.state !== "running") {
        logVoice("dictation ctx not unlocked", audioContext.state);
      }
      logVoice(
        "dictation ctx",
        `${audioContext.state} ${audioContext.sampleRate} Hz${shared ? " shared" : ""}`,
      );
      if (!workletReady.has(audioContext)) {
        await audioContext.audioWorklet.addModule(workletUrl());
        workletReady.add(audioContext);
      }
      const source = audioContext.createMediaStreamSource(mediaStream);
      const node = new AudioWorkletNode(audioContext, "omnigent-pcm16-downsampler");
      // The worklet only renders while it reaches the destination; route
      // it through a muted gain so nothing is audible.
      const mute = audioContext.createGain();
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute);
      mute.connect(audioContext.destination);

      ws.removeEventListener("close", markClosed);
      if (closedDuringSetup || ws.readyState !== WebSocket.OPEN) {
        throw new Error("dictation connection closed during setup");
      }
      return new DictationSession(
        events,
        ws,
        mediaStream,
        audioContext,
        node,
        shared,
        [source, node, mute],
        options.deafCheck === true,
      );
    } catch (error) {
      for (const track of mediaStream.getTracks()) track.stop();
      if (audioContext && !shared && audioContext.state !== "closed") void audioContext.close();
      ws.close();
      throw error;
    }
  }

  /** The take's microphone stream, for anything that must not open a second capture. */
  get stream(): MediaStream {
    return this.mediaStream;
  }

  /** Counts a worklet chunk: seconds sent, peak level, and the first and latest non-zero audio. */
  private noteChunk(chunk: Int16Array): void {
    this.samplesSent += chunk.length;
    let peak = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      const v = Math.abs(chunk[i]);
      if (v > peak) peak = v;
    }
    if (peak > 0) {
      const now = Date.now();
      if (this.firstSoundAt === null) {
        this.firstSoundAt = now;
        logVoice("dictation first sound", `${now - this.createdAt} ms`);
      }
      if (peak > this.peak) this.peak = peak;
    }
    this.events.onLevel?.(peak / 0x8000);
  }

  private checkDeaf(): void {
    if (this.closed) return;
    const now = Date.now();
    let reason: "silent" | "muted" | null = null;
    if (this.mutedSince !== null && now - this.mutedSince >= DEAF_SILENT_MS) reason = "muted";
    else if (this.firstSoundAt === null && now - this.createdAt >= DEAF_SILENT_MS) {
      // Deaf only while no non-zero sample has ever arrived (this also covers a context that is
      // not running at the check). iOS voice processing can send runs of exact zeros in a quiet
      // room, so a take that heard anything is never deaf for its lifetime.
      reason = "silent";
      if (this.audioContext.state !== "running")
        logVoice("dictation deaf ctx", this.audioContext.state);
    }
    if (reason === null) return;
    this.clearDeafTimer();
    logVoice("dictation deaf", reason);
    this.events.onDeaf?.(reason);
  }

  private clearDeafTimer(): void {
    if (this.deafTimer !== null) clearInterval(this.deafTimer);
    this.deafTimer = null;
  }

  private logStats(): void {
    logVoice(
      "dictation take",
      `partials=${this.partials} finals=${this.finals} sent=${(this.samplesSent / TARGET_RATE).toFixed(1)}s peak=${(this.peak / 0x8000).toFixed(3)}`,
    );
  }

  /**
   * End the take: flush the worklet's trailing samples (so the last words
   * make it to the recognizer), release the mic, ask the server to flush,
   * and resolve with the flushed tail utterance ("" on timeout/close).
   */
  async stop(): Promise<string> {
    if (this.closed) return "";
    this.clearDeafTimer();
    await this.flushWorklet();
    this.logStats();
    this.teardownAudio();
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.closed = true;
      return "";
    }
    return new Promise<string>((resolve) => {
      this.stopResolve = resolve;
      this.ws.send(JSON.stringify({ type: "stop" }));
      setTimeout(() => this.resolveStop(""), STOP_TIMEOUT_MS);
    });
  }

  /** Immediate teardown without waiting for the tail (unmount, disable). */
  cancel(): void {
    this.clearDeafTimer();
    this.logStats();
    this.teardownAudio();
    this.closed = true;
    this.ws.close();
  }

  /** Ask the worklet to post its partial chunk; wait for its marker. */
  private flushWorklet(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.flushResolve = resolve;
      try {
        this.workletNode.port.postMessage("flush");
      } catch {
        resolve();
        return;
      }
      setTimeout(resolve, FLUSH_TIMEOUT_MS);
    });
  }

  private resolveStop(tail: string): void {
    this.closed = true;
    const resolve = this.stopResolve;
    this.stopResolve = null;
    this.ws.close();
    resolve?.(tail);
  }

  private fail(message: string): void {
    this.closed = true;
    this.clearDeafTimer();
    this.teardownAudio();
    this.ws.close();
    this.events.onError(message);
  }

  private teardownAudio(): void {
    for (const track of this.mediaStream.getTracks()) track.stop();
    if (this.shared) {
      // The tap-unlocked context outlives the take: unplug this take's graph and park it.
      for (const node of this.graph) {
        try {
          node.disconnect();
        } catch {
          // Already disconnected.
        }
      }
      if (this.audioContext.state === "running")
        void Promise.resolve(this.audioContext.suspend?.()).catch(() => {});
    } else if (this.audioContext.state !== "closed") {
      void this.audioContext.close();
    }
  }
}

/**
 * Resolve when the server sends its ready frame; reject on error frame,
 * close (typed {@link DictationBusyError} for the 1013 at-capacity close),
 * or timeout.
 */
function waitForReady(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("dictation server did not become ready"));
    }, READY_TIMEOUT_MS);
    ws.onmessage = (msg) => {
      if (typeof msg.data !== "string") return;
      const event = parseDictationEvent(msg.data);
      if (event?.type === "ready") {
        clearTimeout(timer);
        resolve();
      } else if (event?.type === "error") {
        // The engine failed to initialize; surface its message rather
        // than the generic close that follows.
        clearTimeout(timer);
        reject(new Error(event.message));
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("dictation connection failed"));
    };
    ws.onclose = (event) => {
      clearTimeout(timer);
      reject(
        event.code === WS_CLOSE_TRY_AGAIN_LATER
          ? new DictationBusyError("dictation is at capacity")
          : new Error("dictation connection closed"),
      );
    };
  });
}
