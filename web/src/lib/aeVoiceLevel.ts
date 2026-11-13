// The mic's frequency bins for the Voice ring (omnigent-ae). The composer's mic
// meter already reads an AnalyserNode every frame; it writes the bins here and the
// ring reads them in its own animation frame, so there is one mic stream only.
// Not throttled and not a React store: the ring pulls, nothing re-renders.

/** The analyser runs fftSize 64, so 32 bins. */
export const VOICE_BIN_COUNT = 32;

const bins = new Float32Array(VOICE_BIN_COUNT);
const listeners = new Set<() => void>();

/** Write one frame of byte frequency data (0 to 255 per bin); stored as 0 to 1. */
export function publishVoiceBins(data: ArrayLike<number>): void {
  for (let i = 0; i < VOICE_BIN_COUNT; i += 1) {
    const v = i < data.length ? data[i] / 255 : 0;
    bins[i] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  }
  listeners.forEach((cb) => cb());
}

/** The mic stopped: every bin back to zero. */
export function resetVoiceBins(): void {
  bins.fill(0);
  listeners.forEach((cb) => cb());
}

/** The live bins. Read-only by convention; copy before keeping. */
export function getVoiceBins(): Readonly<Float32Array> {
  return bins;
}

export function subscribeVoiceBins(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
