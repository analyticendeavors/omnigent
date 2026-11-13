import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishVoiceBins, resetVoiceBins } from "@/lib/aeVoiceLevel";
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

function setReducedMotion(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as typeof window.matchMedia;
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

  it("reduced motion: no loop, one still ring whose brightness follows the mic", () => {
    setReducedMotion(true);
    const alphas: number[] = [];
    ctx.stroke.mockImplementation(() => alphas.push(ctx.globalAlpha));
    render(<AeVoiceRing mode="bars" radius={40} />);
    expect(rafCallbacks.size).toBe(0);
    expect(ctx.arc).toHaveBeenCalled();
    expect(alphas[0]).toBeCloseTo(0.3);
    act(() => publishVoiceBins(new Float32Array(32).fill(255)));
    expect(rafCallbacks.size).toBe(0);
    expect(alphas[alphas.length - 1]).toBeGreaterThan(0.9);
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

  it("the canvas is inert: hidden from readers and never takes taps", () => {
    sheet("listening");
    const canvas = screen.getByTestId("ae-voice-ring-canvas");
    expect(canvas).toHaveAttribute("aria-hidden", "true");
    expect(canvas.className).toContain("pointer-events-none");
  });
});
