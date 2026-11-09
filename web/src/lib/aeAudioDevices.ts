// Microphone and speaker choice for the Speak replies menu: the device list (re-listed on
// devicechange), the two saved ids, and the helpers dictation and cloud voice read.

import { useSyncExternalStore } from "react";

export interface AudioDevice {
  id: string;
  label: string;
}

export interface AudioDeviceList {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
}

export const MIC_KEY = "omnigent:ae-mic-device";
export const SPEAKER_KEY = "omnigent:ae-speaker-device";

const EMPTY: AudioDeviceList = { inputs: [], outputs: [] };
const PSEUDO = new Set(["default", "communications"]);

function getItem(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setItem(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // A storage failure must not break the composer.
  }
}

export function readMicDevice(): string | null {
  return getItem(MIC_KEY) || null;
}

export function writeMicDevice(id: string | null): void {
  setItem(MIC_KEY, id || null);
  notify();
}

export function readSpeakerDevice(): string | null {
  return getItem(SPEAKER_KEY) || null;
}

export function writeSpeakerDevice(id: string | null): void {
  setItem(SPEAKER_KEY, id || null);
  notify();
}

export function micDevicesSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.enumerateDevices;
}

export function speakerSelectionSupported(): boolean {
  return (
    micDevicesSupported() &&
    typeof HTMLMediaElement !== "undefined" &&
    typeof HTMLMediaElement.prototype.setSinkId === "function"
  );
}

/** Lists inputs and outputs; an empty label becomes "Microphone 2" / "Speaker 2" by position. */
export async function listAudioDevices(): Promise<AudioDeviceList> {
  if (!micDevicesSupported()) return EMPTY;
  let all: MediaDeviceInfo[];
  try {
    all = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return EMPTY;
  }
  const pick = (kind: MediaDeviceKind, fallback: string): AudioDevice[] =>
    all
      .filter((d) => d.kind === kind && !PSEUDO.has(d.deviceId))
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
  return { inputs: pick("audioinput", "Microphone"), outputs: pick("audiooutput", "Speaker") };
}

let cache: AudioDeviceList | null = null;
let snapshot: AudioDeviceList = EMPTY;
let version = 0;
const listeners = new Set<() => void>();
let watched: MediaDevices | null = null;

function notify(): void {
  version++;
  listeners.forEach((cb) => cb());
}

export async function refreshAudioDevices(): Promise<void> {
  cache = await listAudioDevices();
  snapshot = cache;
  notify();
}

function watch(): void {
  if (!micDevicesSupported() || watched === navigator.mediaDevices) return;
  watched = navigator.mediaDevices;
  watched.addEventListener?.("devicechange", () => void refreshAudioDevices());
  void refreshAudioDevices();
}

export function subscribeAudioDevices(cb: () => void): () => void {
  listeners.add(cb);
  watch();
  return () => {
    listeners.delete(cb);
  };
}

export function useAudioDevices(): AudioDeviceList {
  return useSyncExternalStore(
    subscribeAudioDevices,
    () => snapshot,
    () => EMPTY,
  );
}

/** Version counter, for tests. */
export function audioDevicesVersion(): number {
  return version;
}

/** Saved id when it is in the list. Before the first listing the saved id is trusted (callers retry). */
function present(saved: string | null, list: AudioDevice[] | undefined): string | null {
  if (!saved) return null;
  if (!list) return saved;
  return list.some((d) => d.id === saved) ? saved : null;
}

export function micConstraint(): { deviceId: { exact: string } } | undefined {
  watch();
  const id = present(readMicDevice(), cache?.inputs);
  return id ? { deviceId: { exact: id } } : undefined;
}

export function speakerSinkId(): string {
  watch();
  return present(readSpeakerDevice(), cache?.outputs) ?? "";
}

/**
 * getUserMedia with the saved microphone. A missing or over-constrained saved device
 * retries once on the system default.
 */
export async function getMicStream(audio: MediaTrackConstraints | true): Promise<MediaStream> {
  const wanted = micConstraint();
  const base = audio === true ? {} : audio;
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { ...base, ...wanted } });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (wanted && (name === "OverconstrainedError" || name === "NotFoundError")) {
      return navigator.mediaDevices.getUserMedia({ audio });
    }
    throw err;
  }
}
