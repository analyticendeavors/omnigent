import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AeTerminalSink,
  findAeTerminalSink,
  getAeRunTarget,
  registerAeTerminalInput,
  resetAeTerminalInputForTests,
  setAeRunTarget,
  waitForAeTerminalSink,
} from "./aeTerminalInput";

function sink(state: "open" | "connecting" | "gone"): AeTerminalSink & { state: typeof state } {
  const s = {
    state,
    aeInputState: () => s.state,
    aePaste: vi.fn(() => s.state === "open"),
  };
  return s;
}

afterEach(() => {
  resetAeTerminalInputForTests();
  vi.useRealTimers();
});

describe("terminal input sinks", () => {
  it("finds the newest open sink for the session and terminal", () => {
    const older = sink("open");
    const newer = sink("open");
    registerAeTerminalInput("s1", "t1", older);
    registerAeTerminalInput("s1", "t1", newer);
    expect(findAeTerminalSink("s1", "t1")).toBe(newer);
    expect(findAeTerminalSink("s1", "t2")).toBeNull();
    expect(findAeTerminalSink("s2", "t1")).toBeNull();
  });

  it("skips connecting and gone sinks, and unregister removes one", () => {
    const open = sink("open");
    const connecting = sink("connecting");
    registerAeTerminalInput("s1", "t1", open);
    const unregister = registerAeTerminalInput("s1", "t1", connecting);
    expect(findAeTerminalSink("s1", "t1")).toBe(open);
    open.state = "gone";
    expect(findAeTerminalSink("s1", "t1")).toBeNull();
    connecting.state = "open";
    expect(findAeTerminalSink("s1", "t1")).toBe(connecting);
    unregister();
    expect(findAeTerminalSink("s1", "t1")).toBeNull();
  });

  it("waits for a sink to connect, and gives up after the timeout", async () => {
    vi.useFakeTimers();
    const late = sink("connecting");
    registerAeTerminalInput("s1", "t1", late);
    const found = waitForAeTerminalSink("s1", "t1", 1000, 100);
    await vi.advanceTimersByTimeAsync(300);
    late.state = "open";
    await vi.advanceTimersByTimeAsync(100);
    await expect(found).resolves.toBe(late);

    const never = waitForAeTerminalSink("s1", "missing", 1000, 100);
    await vi.advanceTimersByTimeAsync(1100);
    await expect(never).resolves.toBeNull();
  });
});

describe("run target", () => {
  it("publishes and clears the target", () => {
    const target = { conversationId: "c1", run: vi.fn() };
    setAeRunTarget(target);
    expect(getAeRunTarget()).toBe(target);
    setAeRunTarget(null);
    expect(getAeRunTarget()).toBeNull();
  });
});
