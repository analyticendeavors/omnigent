// The Voice circle's animated ring (omnigent-ae). Canvas only: it sits behind the
// circle, takes no space and no taps. Bars follow the real mic bins, the liquid
// ring follows a synthetic reply envelope (the reply <audio> is never routed
// through an AudioContext). It draws only while mounted, visible and motion is allowed.
// Reduced motion draws one still ring per mode, theme or pixel-ratio change, never per mic frame.

import { useEffect, useRef } from "react";
import { getVoiceBins } from "@/lib/aeVoiceLevel";
import {
  drawRing,
  drawStaticRing,
  newRingState,
  RING_EXTENT,
  type RingColors,
  stepRing,
  type VoiceRingMode,
} from "@/lib/aeVoiceRing";

export interface AeVoiceRingProps {
  mode: VoiceRingMode;
  /** Radius of the circle the ring surrounds, in CSS px. */
  radius: number;
  /** Changes when the reply moves to a new sentence; gives the ring a small bump. */
  pulseKey?: string;
}

function readColors(el: Element): RingColors {
  const cs = getComputedStyle(el);
  return {
    teal: cs.getPropertyValue("--ae-voice-teal").trim() || "#3fa58e",
    amber: cs.getPropertyValue("--ae-voice-amber").trim() || "#d98a2b",
  };
}

export function AeVoiceRing({ mode, radius, pulseKey }: AeVoiceRingProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const stateRef = useRef(newRingState());
  const pulseSeen = useRef(pulseKey);
  if (pulseSeen.current !== pulseKey) {
    pulseSeen.current = pulseKey;
    stateRef.current.pulse = 1;
  }
  // Set by the effect below: draws the still ring when motion is reduced, else does nothing.
  const redrawStill = useRef<(() => void) | null>(null);
  const size = Math.round(radius * RING_EXTENT * 2);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const darkMq = window.matchMedia?.("(prefers-color-scheme: dark)");
    let reduced = Boolean(mq?.matches);
    // Cached; refreshed only when the theme changes.
    let colors = readColors(canvas);
    let raf: number | null = null;
    const t0 = performance.now();

    const sizeBuffer = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return dpr;
    };
    let dpr = sizeBuffer();

    const drawStill = () => {
      if (reduced) drawStaticRing(ctx, modeRef.current, radius, colors);
    };
    redrawStill.current = drawStill;
    const frame = (now: number) => {
      raf = null;
      if (document.hidden || reduced) return;
      const t = (now - t0) / 1000;
      stepRing(stateRef.current, modeRef.current, t, getVoiceBins());
      drawRing(ctx, stateRef.current, t, radius, colors);
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (raf !== null || document.hidden) return;
      if (reduced) {
        drawStill();
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    const onMotion = () => {
      reduced = Boolean(mq?.matches);
      stop();
      start();
    };
    const onTheme = () => {
      colors = readColors(canvas);
      drawStill();
    };
    // A new device pixel ratio (window moved to another screen, browser zoom): resize the buffer.
    let dprMq: MediaQueryList | undefined;
    const onDpr = () => {
      dpr = sizeBuffer();
      watchDpr();
      drawStill();
    };
    const watchDpr = () => {
      dprMq?.removeEventListener?.("change", onDpr);
      dprMq = window.matchMedia?.(`(resolution: ${dpr}dppx)`);
      dprMq?.addEventListener?.("change", onDpr);
    };
    const onResize = () => {
      const next = Math.max(1, window.devicePixelRatio || 1);
      if (next !== dpr) onDpr();
    };
    watchDpr();
    window.addEventListener("resize", onResize);
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(onTheme);
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    darkMq?.addEventListener?.("change", onTheme);
    document.addEventListener("visibilitychange", onVisibility);
    mq?.addEventListener?.("change", onMotion);
    start();
    return () => {
      stop();
      redrawStill.current = null;
      window.removeEventListener("resize", onResize);
      dprMq?.removeEventListener?.("change", onDpr);
      observer?.disconnect();
      darkMq?.removeEventListener?.("change", onTheme);
      document.removeEventListener("visibilitychange", onVisibility);
      mq?.removeEventListener?.("change", onMotion);
    };
  }, [radius, size]);

  // A mode change while still: redraw once. (Animated mode reads modeRef each frame.)
  const stillMode = useRef(mode);
  useEffect(() => {
    if (stillMode.current === mode) return;
    stillMode.current = mode;
    redrawStill.current?.();
  }, [mode]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-testid="ae-voice-ring-canvas"
      data-mode={mode}
      style={{ width: size, height: size }}
      className="pointer-events-none absolute top-1/2 left-1/2 -z-10 -translate-x-1/2 -translate-y-1/2"
    />
  );
}
