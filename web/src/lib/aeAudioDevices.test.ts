import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMicStream,
  listAudioDevices,
  micConstraint,
  readMicDevice,
  readSpeakerDevice,
  refreshAudioDevices,
  speakerSinkId,
  subscribeAudioDevices,
  writeMicDevice,
  writeSpeakerDevice,
} from "./aeAudioDevices";

const dev = (kind: MediaDeviceKind, deviceId: string, label: string) =>
  ({ kind, deviceId, label, groupId: "" }) as MediaDeviceInfo;

const DEVICES = [
  dev("audioinput", "default", "Default - Mic"),
  dev("audioinput", "communications", "Communications - Mic"),
  dev("audioinput", "mic1", "USB Mic"),
  dev("audioinput", "mic2", ""),
  dev("audiooutput", "default", "Default - Speaker"),
  dev("audiooutput", "spk1", "Desk Speaker"),
  dev("audiooutput", "spk2", ""),
];

let listeners: Record<string, () => void>;
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  listeners = {};
  getUserMedia = vi.fn(() => Promise.resolve({} as MediaStream));
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(() => Promise.resolve(DEVICES)),
      getUserMedia,
      addEventListener: (name: string, cb: () => void) => {
        listeners[name] = cb;
      },
    },
  });
});

afterEach(() => {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("listAudioDevices", () => {
  it("skips pseudo entries and names unlabeled devices by position", async () => {
    const list = await listAudioDevices();
    expect(list.inputs).toEqual([
      { id: "mic1", label: "USB Mic" },
      { id: "mic2", label: "Microphone 2" },
    ]);
    expect(list.outputs).toEqual([
      { id: "spk1", label: "Desk Speaker" },
      { id: "spk2", label: "Speaker 2" },
    ]);
  });

  it("returns nothing without the api", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    expect(await listAudioDevices()).toEqual({ inputs: [], outputs: [] });
  });
});

describe("saved ids", () => {
  it("round-trips and clears", () => {
    writeMicDevice("mic1");
    writeSpeakerDevice("spk1");
    expect(window.localStorage.getItem("omnigent:ae-mic-device")).toBe("mic1");
    expect(readMicDevice()).toBe("mic1");
    expect(readSpeakerDevice()).toBe("spk1");
    writeMicDevice(null);
    expect(window.localStorage.getItem("omnigent:ae-mic-device")).toBeNull();
  });
});

describe("constraints", () => {
  it("uses a saved device that exists, else the system default, keeping the saved value", async () => {
    await refreshAudioDevices();
    writeMicDevice("mic1");
    writeSpeakerDevice("spk1");
    expect(micConstraint()).toEqual({ deviceId: { exact: "mic1" } });
    expect(speakerSinkId()).toBe("spk1");
    writeMicDevice("gone");
    writeSpeakerDevice("gone");
    expect(micConstraint()).toBeUndefined();
    expect(speakerSinkId()).toBe("");
    expect(readMicDevice()).toBe("gone");
  });

  it("re-lists on devicechange", async () => {
    const cb = vi.fn();
    const off = subscribeAudioDevices(cb);
    await refreshAudioDevices();
    cb.mockClear();
    listeners.devicechange?.();
    await vi.waitFor(() => expect(cb).toHaveBeenCalled());
    off();
  });
});

describe("getMicStream", () => {
  it("spreads the saved device into the audio constraints", async () => {
    await refreshAudioDevices();
    writeMicDevice("mic1");
    await getMicStream({ channelCount: 1 });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { channelCount: 1, deviceId: { exact: "mic1" } },
    });
  });

  it("sends the plain constraints with no saved device", async () => {
    await getMicStream(true);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: {} });
  });

  it.each(["OverconstrainedError", "NotFoundError"])("retries once without the id on %s", async (name) => {
    await refreshAudioDevices();
    writeMicDevice("mic1");
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("x"), { name }));
    await getMicStream({ channelCount: 1 });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: { channelCount: 1 } });
  });

  it("does not retry a permission error", async () => {
    await refreshAudioDevices();
    writeMicDevice("mic1");
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    await expect(getMicStream(true)).rejects.toThrow("x");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});
