import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AE_SINK_BUSY_MS,
  AE_SINK_QUIET_MS,
  type AeTerminalSink,
  findAeTerminalSink,
  getAeRunTarget,
  pasteIntoAeTerminal,
  registerAeTerminalInput,
  resetAeTerminalInputForTests,
  setAeRunTarget,
  waitForAeTerminalSink,
} from "./aeTerminalInput";

type FakeSink = AeTerminalSink & {
  state: "open" | "connecting" | "gone";
  bracketed: boolean;
  draw: () => void;
};

function sink(state: FakeSink["state"]): FakeSink {
  const listeners = new Set<() => void>();
  const s: FakeSink = {
    state,
    bracketed: true,
    aeInputState: () => s.state,
    aeOnOutput: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    aeBracketedPaste: () => s.bracketed,
    aeWrite: vi.fn(),
    focus: vi.fn(),
    draw: () => {
      for (const listener of listeners) listener();
    },
  };
  return s;
}

/** Register, draw, and let the shell go quiet. */
function registerDrawn(session: string, terminal: string, s: FakeSink): () => void {
  const unregister = registerAeTerminalInput(session, terminal, s);
  s.draw();
  vi.advanceTimersByTime(AE_SINK_QUIET_MS);
  return unregister;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetAeTerminalInputForTests();
  vi.useRealTimers();
});

describe("terminal input sinks", () => {
  it("finds the newest ready sink for the session and terminal", () => {
    const older = sink("open");
    const newer = sink("open");
    registerDrawn("s1", "t1", older);
    registerDrawn("s1", "t1", newer);
    expect(findAeTerminalSink("s1", "t1")).toBe(newer);
    expect(findAeTerminalSink("s1", "t2")).toBeNull();
    expect(findAeTerminalSink("s2", "t1")).toBeNull();
  });

  it("skips connecting and gone sinks, and unregister removes one", () => {
    const open = sink("open");
    const connecting = sink("connecting");
    registerDrawn("s1", "t1", open);
    const unregister = registerDrawn("s1", "t1", connecting);
    expect(findAeTerminalSink("s1", "t1")).toBe(open);
    open.state = "gone";
    expect(findAeTerminalSink("s1", "t1")).toBeNull();
    connecting.state = "open";
    expect(findAeTerminalSink("s1", "t1")).toBe(connecting);
    unregister();
    expect(findAeTerminalSink("s1", "t1")).toBeNull();
  });

  it("is not ready on the WebSocket's open, only once the shell has drawn and gone quiet", () => {
    const s = sink("open");
    registerAeTerminalInput("s1", "t1", s);
    expect(findAeTerminalSink("s1", "t1")).toBeNull();
    s.draw();
    expect(findAeTerminalSink("s1", "t1")).toBeNull();
    vi.advanceTimersByTime(AE_SINK_QUIET_MS);
    expect(findAeTerminalSink("s1", "t1")).toBe(s);
  });

  it("writes to a shell that keeps printing once it has had time to draw", () => {
    const s = sink("open");
    registerAeTerminalInput("s1", "t1", s);
    for (let elapsed = 0; elapsed < AE_SINK_BUSY_MS; elapsed += 100) {
      s.draw();
      expect(findAeTerminalSink("s1", "t1")).toBeNull();
      vi.advanceTimersByTime(100);
    }
    s.draw();
    expect(findAeTerminalSink("s1", "t1")).toBe(s);
  });

  it("waits for a sink to connect and draw, and gives up after the timeout", async () => {
    const late = sink("connecting");
    registerAeTerminalInput("s1", "t1", late);
    const found = waitForAeTerminalSink("s1", "t1", 2000, 100);
    await vi.advanceTimersByTimeAsync(300);
    late.state = "open";
    late.draw();
    await vi.advanceTimersByTimeAsync(AE_SINK_QUIET_MS + 100);
    await expect(found).resolves.toBe(late);

    const never = waitForAeTerminalSink("s1", "missing", 1000, 100);
    await vi.advanceTimersByTimeAsync(1100);
    await expect(never).resolves.toBeNull();
  });
});

describe("pasteIntoAeTerminal", () => {
  it("pastes a single line whatever the paste mode", () => {
    const s = sink("open");
    s.bracketed = false;
    expect(pasteIntoAeTerminal(s, "ls -la", true)).toMatchObject({ ok: true, submitted: true });
    expect(s.aeWrite).toHaveBeenCalledWith("ls -la", true);
  });

  it("sends nothing multi-line unless the shell turned on bracketed paste", () => {
    const s = sink("open");
    s.bracketed = false;
    const result = pasteIntoAeTerminal(s, "rm -rf build\ncat <<EOF", false);
    expect(result.ok).toBe(false);
    expect(s.aeWrite).not.toHaveBeenCalled();
    s.bracketed = true;
    expect(pasteIntoAeTerminal(s, "rm -rf build\ncat <<EOF", false)).toMatchObject({
      ok: true,
      submitted: false,
    });
  });

  it("sends nothing to a shell that disconnected", () => {
    const s = sink("gone");
    expect(pasteIntoAeTerminal(s, "ls", true).ok).toBe(false);
    expect(s.aeWrite).not.toHaveBeenCalled();
  });
});

describe("run target", () => {
  it("publishes and clears the target", () => {
    const target = { conversationId: "c1", shells: new Set(["posix" as const]), run: vi.fn() };
    setAeRunTarget(target);
    expect(getAeRunTarget()).toBe(target);
    setAeRunTarget(null);
    expect(getAeRunTarget()).toBeNull();
  });
});
