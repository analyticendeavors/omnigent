// A tiny event so a control outside the action dock (the rail's Answer button) can ask
// the dock to open its tray and scroll to a kind of line, or to one child's line (omnigent-ae, 2026-10-29).
// Nothing is stored: a reveal with no dock mounted is simply lost.

import { useEffect, useRef } from "react";
import type { AeDockKind } from "@/lib/aeActionDock";

type Listener = (kind: AeDockKind, childId?: string) => void;

const listeners = new Set<Listener>();

/** Ask any mounted dock to open its tray at the first line of `kind`, or at `childId`'s. */
export function aeRevealDock(kind: AeDockKind, childId?: string): void {
  for (const listener of [...listeners]) listener(kind, childId);
}

/** Run `onReveal` for each reveal while the caller is mounted. */
export function useAeDockReveal(onReveal: Listener): void {
  const latest = useRef(onReveal);
  latest.current = onReveal;
  useEffect(() => {
    const listener: Listener = (kind, childId) => latest.current(kind, childId);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
}
