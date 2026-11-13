import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishVoiceBins, resetVoiceBins } from "@/lib/aeVoiceLevel";
import { RING_SCALE } from "@/lib/aeVoiceRing";
import { AeVoiceRing } from "./AeVoiceRing";
import { AeVoicePanel } from "./AeVoicePanel";

function makeCtx() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    lineCap: "",
    strokeStyle: "",
    lineWidth: 0,
    globalAlpha: 1,
  };
}

let ctx: ReturnType<typeof makeCtx>;
let rafCallbacks: Map<number, FrameRequestCallback>;
let nextId: number;
let cancelSpy: ReturnType<typeof vi.fn>;

function runFrame(now = 16) {
  const entries = [...rafCallbacks.entries()];
  rafCallbacks.clear();
  for (const [, cb] of entries) cb(now);
}

type MqListener = () => void;
let mqState: Map<string, { matches: boolean; listeners: Set<MqListener> }>;

function mqFor(query: string) {
  let e = mqState.get(query);
  if (!e) {
    e = { matches: false, listeners: new Set() };
    mqState.set(query, e);
  }
  return e;
}

/** Flip a media query and tell its listeners, as a browser would. */
function flipMq(query: string, matches: boolean) {
  const e = mqFor(query);
  e.matches = matches;
  act(() => e.listeners.forEach((cb) => cb()));
}

const REDUCED = "(prefers-reduced-motion: reduce)";

function installMatchMedia() {
  mqState = new Map();
  window.matchMedia = ((query: string) => {
    const e = mqFor(query);
    return {
      get matches() {
        return e.matches;
      },
      media: query,
      addEventListener: (_t: string, cb: MqListener) => e.listeners.add(cb),
      removeEventListener: (_t: string, cb: MqListener) => e.listeners.delete(cb),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    };
  }) as unknown as typeof window.matchMedia;
}

function setReducedMotion(on: boolean) {
  installMatchMedia();
  mqFor(REDUCED).matches = on;
}

beforeEach(() => {
  ctx = makeCtx();
  rafCallbacks = new Map();
  nextId = 1;
  cancelSpy = vi.fn((id: number) => rafCallbacks.delete(id));
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    rafCallbacks.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", cancelSpy);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
  );
  setReducedMotion(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetVoiceBins();
});

describe("AeVoiceRing", () => {
  it("draws on a canvas sized to the ring and keeps drawing frame after frame", () => {
    render(<AeVoiceRing mode="bars" radius={40} />);
    const canvas = screen.getByTestId("ae-voice-ring-canvas") as HTMLCanvasElement;
    expect(canvas.style.width).toBe("168px");
    expect(canvas).toHaveAttribute("data-mode", "bars");
    expect(rafCallbacks.size).toBe(1);
    runFrame();
    expect(ctx.stroke).toHaveBeenCalled();
    expect(rafCallbacks.size).toBe(1);
  });

  it("cancels its frame on unmount and stops scheduling", () => {
    const { unmount } = render(<AeVoiceRing mode="liquid" radius={40} />);
    runFrame();
    expect(rafCallbacks.size).toBe(1);
    unmount();
    expect(cancelSpy).toHaveBeenCalled();
    expect(rafCallbacks.size).toBe(0);
  });

  it("stops while the page is hidden and resumes when visible again", () => {
    render(<AeVoiceRing mode="bars" radius={40} />);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(rafCallbacks.size).toBe(0);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(rafCallbacks.size).toBe(1);
  });

  it("reduced motion: no loop, one still ring drawn once and never redrawn per mic frame", () => {
    setReducedMotion(true);
    const alphas: number[] = [];
    ctx.stroke.mockImplementation(() => alphas.push(ctx.globalAlpha));
    const cs = vi.spyOn(window, "getComputedStyle");
    render(<AeVoiceRing mode="bars" radius={40} />);
    expect(rafCallbacks.size).toBe(0);
    expect(ctx.arc).toHaveBeenCalledTimes(1);
    const colorReads = cs.mock.calls.length;
    for (let i = 0; i < 20; i += 1) act(() => publishVoiceBins(new Float32Array(32).fill(i * 12)));
    expect(rafCallbacks.size).toBe(0);
    expect(ctx.arc).toHaveBeenCalledTimes(1);
    expect(cs.mock.calls.length).toBe(colorReads);
    expect(new Set(alphas).size).toBe(1);
  });

  it("reduced motion: a mode change redraws once", () => {
    setReducedMotion(true);
    const { rerender } = render(<AeVoiceRing mode="bars" radius={40} />);
    expect(ctx.arc).toHaveBeenCalledTimes(1);
    rerender(<AeVoiceRing mode="liquid" radius={40} />);
    expect(ctx.arc).toHaveBeenCalledTimes(2);
    rerender(<AeVoiceRing mode="liquid" radius={40} />);
    expect(ctx.arc).toHaveBeenCalledTimes(2);
  });

  it("toggling reduced motion live switches between the loop and the still ring", () => {
    setReducedMotion(false);
    render(<AeVoiceRing mode="bars" radius={40} />);
    expect(rafCallbacks.size).toBe(1);
    flipMq(REDUCED, true);
    expect(rafCallbacks.size).toBe(0);
    expect(ctx.arc).toHaveBeenCalledTimes(1);
    flipMq(REDUCED, false);
    expect(rafCallbacks.size).toBe(1);
  });

  it("theme change while still redraws with the new colours", async () => {
    setReducedMotion(true);
    document.documentElement.style.setProperty("--ae-voice-teal", "#111111");
    const strokes: string[] = [];
    ctx.stroke.mockImplementation(() => strokes.push(ctx.strokeStyle));
    render(<AeVoiceRing mode="bars" radius={40} />);
    expect(strokes).toEqual(["#111111"]);
    document.documentElement.style.setProperty("--ae-voice-teal", "#222222");
    document.documentElement.classList.add("dark");
    await waitFor(() => expect(strokes).toEqual(["#111111", "#222222"]));
    // And a prefers-color-scheme change does the same.
    document.documentElement.style.setProperty("--ae-voice-teal", "#333333");
    flipMq("(prefers-color-scheme: dark)", true);
    expect(strokes[strokes.length - 1]).toBe("#333333");
    document.documentElement.classList.remove("dark");
    document.documentElement.style.removeProperty("--ae-voice-teal");
  });

  it("resizes the backing buffer when the device pixel ratio changes", () => {
    setReducedMotion(false);
    vi.stubGlobal("devicePixelRatio", 1);
    render(<AeVoiceRing mode="bars" radius={40} />);
    const canvas = screen.getByTestId("ae-voice-ring-canvas") as HTMLCanvasElement;
    expect(canvas.width).toBe(168);
    vi.stubGlobal("devicePixelRatio", 2);
    flipMq("(resolution: 1dppx)", false);
    expect(canvas.width).toBe(336);
    expect(ctx.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0);
    vi.stubGlobal("devicePixelRatio", 3);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(canvas.width).toBe(504);
  });

  it("the canvas sits behind the circle and the ring stays inside the button margin", () => {
    render(<AeVoiceRing mode="bars" radius={40} />);
    expect(screen.getByTestId("ae-voice-ring-canvas").className).toContain("-z-10");
    expect(40 * 1.9 * RING_SCALE).toBeLessThan(48 + 24);
  });
});

describe("AeVoicePanel ring", () => {
  function sheet(phase: "listening" | "speaking" | "thinking") {
    return render(
      <AeVoicePanel
        layout="sheet"
        phase={phase}
        blocked={false}
        heard=""
        caption="Hi."
        onEnd={() => {}}
        onStop={() => {}}
        onResume={() => {}}
      />,
    );
  }

  it("chooses bars while listening, the liquid ring while speaking, idle otherwise", () => {
    const first = sheet("listening");
    expect(screen.getByTestId("ae-voice-ring-canvas")).toHaveAttribute("data-mode", "bars");
    first.unmount();
    const second = sheet("speaking");
    expect(screen.getByTestId("ae-voice-ring-canvas")).toHaveAttribute("data-mode", "liquid");
    second.unmount();
    sheet("thinking");
    expect(screen.getByTestId("ae-voice-ring-canvas")).toHaveAttribute("data-mode", "idle");
  });

  it("the speaking label and disc use the ring's amber token, not a fixed amber", () => {
    sheet("speaking");
    expect(screen.getByText("Speaking, tap to stop").className).toContain("--ae-voice-amber");
    expect(screen.getByTestId("ae-voice-ring").firstElementChild?.className).toContain(
      "--ae-voice-amber",
    );
  });

  it("the canvas is inert: hidden from readers and never takes taps", () => {
    sheet("listening");
    const canvas = screen.getByTestId("ae-voice-ring-canvas");
    expect(canvas).toHaveAttribute("aria-hidden", "true");
    expect(canvas.className).toContain("pointer-events-none");
  });
});
