// The Voice circle's animated ring (omnigent-ae). Canvas only: it sits behind the
// circle, takes no space and no taps. Bars follow the real mic bins, the liquid
// ring follows a synthetic reply envelope (the reply <audio> is never routed
// through an AudioContext). It draws only while mounted, visible and motion is allowed.

import { useEffect, useRef } from "react";
import { getVoiceBins, subscribeVoiceBins } from "@/lib/aeVoiceLevel";
import {
  binsLevel,
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

const COLOR_REFRESH_FRAMES = 60;

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
  const size = Math.round(radius * RING_EXTENT * 2);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let reduced = Boolean(mq?.matches);
    let colors = readColors(canvas);
    let raf: number | null = null;
    let frames = 0;
    const t0 = performance.now();

    const drawStill = () => {
      colors = readColors(canvas);
      drawStaticRing(ctx, modeRef.current, binsLevel(getVoiceBins()), radius, colors);
    };
    const frame = (now: number) => {
      raf = null;
      if (document.hidden || reduced) return;
      if (frames++ % COLOR_REFRESH_FRAMES === 0) colors = readColors(canvas);
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
    // Reduced motion has no loop: a new mic frame or a mode change redraws the still ring.
    const unsubscribe = subscribeVoiceBins(() => {
      if (reduced && !document.hidden) drawStill();
    });
    document.addEventListener("visibilitychange", onVisibility);
    mq?.addEventListener?.("change", onMotion);
    start();
    return () => {
      stop();
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      mq?.removeEventListener?.("change", onMotion);
    };
  }, [radius, size]);

  // A mode change while still: redraw once. (Animated mode reads modeRef each frame.)
  useEffect(() => {
    const canvas = canvasRef.current;
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!canvas || !mq?.matches) return;
    const ctx = canvas.getContext("2d");
    if (ctx) drawStaticRing(ctx, mode, binsLevel(getVoiceBins()), radius, readColors(canvas));
  }, [mode, radius]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-testid="ae-voice-ring-canvas"
      data-mode={mode}
      style={{ width: size, height: size }}
      className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
    />
  );
}
