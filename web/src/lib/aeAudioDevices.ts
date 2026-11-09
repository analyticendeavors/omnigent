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
  /** False while the browser hides device ids (no microphone permission yet). */
  inputsKnown: boolean;
  outputsKnown: boolean;
}

export interface SavedAudioDevices {
  mic: string | null;
  speaker: string | null;
}

export const MIC_KEY = "omnigent:ae-mic-device";
export const SPEAKER_KEY = "omnigent:ae-speaker-device";

const EMPTY: AudioDeviceList = { inputs: [], outputs: [], inputsKnown: false, outputsKnown: false };
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
  notifySaved();
}

export function readSpeakerDevice(): string | null {
  return getItem(SPEAKER_KEY) || null;
}

export function writeSpeakerDevice(id: string | null): void {
  setItem(SPEAKER_KEY, id || null);
  notifySaved();
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

/**
 * Lists inputs and outputs; an empty label becomes "Microphone 2" / "Speaker 2" by position.
 * Entries with an empty id (listed before permission) are dropped and the kind is marked not known.
 */
export async function listAudioDevices(): Promise<AudioDeviceList> {
  if (!micDevicesSupported()) return EMPTY;
  let all: MediaDeviceInfo[];
  try {
    all = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return EMPTY;
  }
  const pick = (kind: MediaDeviceKind, fallback: string) => {
    const raw = all.filter((d) => d.kind === kind);
    const devices = raw
      .filter((d) => d.deviceId !== "" && !PSEUDO.has(d.deviceId))
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
    return { devices, known: raw.every((d) => d.deviceId !== "") };
  };
  const inputs = pick("audioinput", "Microphone");
  const outputs = pick("audiooutput", "Speaker");
  return {
    inputs: inputs.devices,
    outputs: outputs.devices,
    inputsKnown: inputs.known,
    outputsKnown: outputs.known,
  };
}

let cache: AudioDeviceList | null = null;
let snapshot: AudioDeviceList = EMPTY;
let version = 0;
let refreshSeq = 0;
const listeners = new Set<() => void>();
let watched: MediaDevices | null = null;

const savedListeners = new Set<() => void>();

function notify(): void {
  version++;
  listeners.forEach((cb) => cb());
}

/** A saved id changed: device subscribers and saved-choice subscribers both hear it. */
function notifySaved(): void {
  notify();
  savedListeners.forEach((cb) => cb());
}

/** "Microphone (Logitech BRIO)" reads as "Logitech BRIO"; other labels are unchanged. */
export function shortDeviceName(label: string): string {
  const m = /^[^(]+\((.*)\)\s*$/.exec(label);
  const inner = m?.[1].trim();
  return inner || label;
}

/** Re-lists the devices; a result that is not the newest request is dropped. */
export async function refreshAudioDevices(): Promise<void> {
  const seq = ++refreshSeq;
  const list = await listAudioDevices();
  if (seq !== refreshSeq) return;
  cache = list;
  snapshot = list;
  notify();
}

function onDeviceChange(): void {
  void refreshAudioDevices();
}

function attach(): void {
  if (!micDevicesSupported() || watched === navigator.mediaDevices) return;
  watched = navigator.mediaDevices;
  watched.addEventListener?.("devicechange", onDeviceChange);
  void refreshAudioDevices();
}

function detach(): void {
  watched?.removeEventListener?.("devicechange", onDeviceChange);
  watched = null;
}

export function subscribeAudioDevices(cb: () => void): () => void {
  listeners.add(cb);
  attach();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) detach();
  };
}

export function useAudioDevices(): AudioDeviceList {
  return useSyncExternalStore(
    subscribeAudioDevices,
    () => snapshot,
    () => EMPTY,
  );
}

let savedSnapshot: SavedAudioDevices = { mic: null, speaker: null };

/** Stable between reads unless a saved id changed. */
function getSavedSnapshot(): SavedAudioDevices {
  const mic = readMicDevice();
  const speaker = readSpeakerDevice();
  if (mic !== savedSnapshot.mic || speaker !== savedSnapshot.speaker) savedSnapshot = { mic, speaker };
  return savedSnapshot;
}

function subscribeSaved(cb: () => void): () => void {
  savedListeners.add(cb);
  return () => {
    savedListeners.delete(cb);
  };
}

/** The two saved ids, shared by every mounted control. */
export function useSavedAudioDevices(): SavedAudioDevices {
  return useSyncExternalStore(subscribeSaved, getSavedSnapshot, () => savedSnapshot);
}

/** Version counter, for tests. */
export function audioDevicesVersion(): number {
  return version;
}

/** Saved id when it is listed. Before a listing, or while the kind is not known, the saved id is trusted. */
function present(saved: string | null, list: AudioDevice[] | undefined, known: boolean): string | null {
  if (!saved) return null;
  if (!list || !known) return saved;
  return list.some((d) => d.id === saved) ? saved : null;
}

let firstListing: Promise<void> | null = null;

/** Starts the first listing once; further calls wait for it to settle. */
function ensureListed(): void {
  if (cache !== null || firstListing || !micDevicesSupported()) return;
  firstListing = refreshAudioDevices().finally(() => {
    firstListing = null;
  });
}

export function micConstraint(): { deviceId: { exact: string } } | undefined {
  ensureListed();
  const id = present(readMicDevice(), cache?.inputs, cache?.inputsKnown ?? false);
  return id ? { deviceId: { exact: id } } : undefined;
}

export function speakerSinkId(): string {
  ensureListed();
  return present(readSpeakerDevice(), cache?.outputs, cache?.outputsKnown ?? false) ?? "";
}

/**
 * getUserMedia with the saved microphone. A missing or over-constrained saved device
 * retries once on the system default. A stream means permission exists, so a list
 * that hid its ids is read again.
 */
export async function getMicStream(audio: MediaTrackConstraints | true): Promise<MediaStream> {
  const wanted = micConstraint();
  const base = audio === true ? {} : audio;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, ...wanted } });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (wanted && (name === "OverconstrainedError" || name === "NotFoundError")) {
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    } else throw err;
  }
  if (!cache?.inputsKnown) void refreshAudioDevices();
  return stream;
}
