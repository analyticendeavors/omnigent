import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMicStream,
  listAudioDevices,
  micConstraint,
  readMicDevice,
  readSpeakerDevice,
  refreshAudioDevices,
  shortDeviceName,
  useSavedAudioDevices,
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
    expect(await listAudioDevices()).toMatchObject({ inputs: [], outputs: [], inputsKnown: false });
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

describe("before microphone permission", () => {
  const hidden = [
    dev("audioinput", "", ""),
    dev("audiooutput", "", ""),
  ];

  it("drops empty ids, marks the kind not known and still trusts the saved id", async () => {
    (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockResolvedValue(hidden);
    const list = await listAudioDevices();
    expect(list.inputs).toEqual([]);
    expect(list.inputsKnown).toBe(false);
    expect(list.outputsKnown).toBe(false);
    await refreshAudioDevices();
    writeMicDevice("mic1");
    expect(micConstraint()).toEqual({ deviceId: { exact: "mic1" } });
  });

  it("re-lists after a stream succeeds", async () => {
    const enumerate = navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>;
    enumerate.mockResolvedValue(hidden);
    await refreshAudioDevices();
    writeMicDevice("absent");
    // Kind not known: the saved id is trusted.
    expect(micConstraint()).toEqual({ deviceId: { exact: "absent" } });
    const before = enumerate.mock.calls.length;
    enumerate.mockResolvedValue(DEVICES);
    await getMicStream(true);
    await vi.waitFor(() => expect(enumerate.mock.calls.length).toBeGreaterThan(before));
    // Only a refreshed, known list can say the saved id is gone.
    await vi.waitFor(() => expect(micConstraint()).toBeUndefined());
  });

  it("retries once on the default when the saved device is unplugged and no listing exists yet", async () => {
    window.localStorage.setItem("omnigent:ae-mic-device", "unplugged");
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotFoundError" }));
    vi.resetModules();
    const fresh = await import("./aeAudioDevices");
    await expect(fresh.getMicStream({ channelCount: 1 })).resolves.toBeDefined();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: { channelCount: 1 } });
  });
});

describe("listener and ordering", () => {
  it("removes devicechange with the last subscriber and attaches again for the next", async () => {
    const add = vi.fn();
    const remove = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: () => Promise.resolve(DEVICES),
        getUserMedia,
        addEventListener: add,
        removeEventListener: remove,
      },
    });
    const off1 = subscribeAudioDevices(() => {});
    const off2 = subscribeAudioDevices(() => {});
    expect(add).toHaveBeenCalledTimes(1);
    off1();
    expect(remove).not.toHaveBeenCalled();
    off2();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][1]).toBe(add.mock.calls[0][1]);
    const off3 = subscribeAudioDevices(() => {});
    expect(add).toHaveBeenCalledTimes(2);
    off3();
  });

  it("drops an older refresh that resolves after a newer one", async () => {
    let first!: (v: MediaDeviceInfo[]) => void;
    const enumerate = vi
      .fn()
      .mockImplementationOnce(() => new Promise<MediaDeviceInfo[]>((r) => {
          first = r;
        }))
      .mockImplementationOnce(() => Promise.resolve(DEVICES));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { enumerateDevices: enumerate, getUserMedia, addEventListener: () => {} },
    });
    const older = refreshAudioDevices();
    await refreshAudioDevices();
    first([dev("audioinput", "old", "Old Mic")]);
    await older;
    writeMicDevice("old");
    expect(micConstraint()).toBeUndefined();
    writeMicDevice("mic1");
    expect(micConstraint()).toEqual({ deviceId: { exact: "mic1" } });
  });

  it("keeps the saved ids snapshot stable between writes and follows a write", () => {
    const { result, rerender } = renderHook(() => useSavedAudioDevices());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    act(() => writeMicDevice("mic1"));
    expect(result.current).not.toBe(first);
    expect(result.current.mic).toBe("mic1");
  });
});

describe("shortDeviceName", () => {
  it.each([
    ["Microphone (Logitech BRIO 4K Stream Edition)", "Logitech BRIO 4K Stream Edition"],
    ["Headset (Jabra Evolve2 75)", "Jabra Evolve2 75"],
    ["Speakers (Realtek(R) Audio)", "Realtek(R) Audio"],
    ["MacBook Pro Microphone", "MacBook Pro Microphone"],
    ["Microphone 2", "Microphone 2"],
  ])("%s", (label, short) => {
    expect(shortDeviceName(label)).toBe(short);
  });
});

describe("store listeners and first listing", () => {
  it("a saved-choice subscriber alone attaches no devicechange listener", () => {
    const add = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { enumerateDevices: () => Promise.resolve(DEVICES), getUserMedia, addEventListener: add },
    });
    const { unmount } = renderHook(() => useSavedAudioDevices());
    expect(add).not.toHaveBeenCalled();
    unmount();
  });

  it("three calls before the first listing resolves enumerate once", async () => {
    vi.resetModules();
    const fresh = await import("./aeAudioDevices");
    let resolve!: (v: MediaDeviceInfo[]) => void;
    const enumerate = vi.fn(
      () =>
        new Promise<MediaDeviceInfo[]>((r) => {
          resolve = r;
        }),
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { enumerateDevices: enumerate, getUserMedia, addEventListener: () => {} },
    });
    fresh.micConstraint();
    fresh.micConstraint();
    fresh.speakerSinkId();
    expect(enumerate).toHaveBeenCalledTimes(1);
    resolve(DEVICES);
    await vi.waitFor(() => expect(fresh.micConstraint()).toBeUndefined());
    expect(enumerate).toHaveBeenCalledTimes(1);
  });
});
