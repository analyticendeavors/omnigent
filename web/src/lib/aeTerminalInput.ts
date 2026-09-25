// [ae] Run-on-box: the transport half of the Run button on chat code blocks.
//
// Two small module-level registries, so the chat's code blocks (deep inside
// Streamdown) and the shell surfaces (under AppShell) never need a prop path:
//
//   - Input sinks. Every writable `TerminalView` registers its live
//     `TerminalSession` here under (session id, terminal id). A Run writes
//     through `TerminalSession.aePaste`, which is xterm's own paste followed
//     by an Enter keystroke: the bytes take the same `term.onData` path, and
//     the same WebSocket, as the keyboard. No new server endpoint.
//   - The run target. AppShell publishes one while the viewer owns a session
//     whose agent declares shells (`useAeRunInTerminal`); code blocks show Run
//     only while it is set.

import { useSyncExternalStore } from "react";

/** What a `TerminalSession` exposes to a Run. */
export interface AeTerminalSink {
  /** `open` once the WebSocket is up; `gone` after dispose or close. */
  aeInputState: () => "open" | "connecting" | "gone";
  /** Paste through the keyboard path, then Enter when `submit`. False when not open. */
  aePaste: (text: string, submit: boolean) => boolean;
}

const sinks = new Map<string, AeTerminalSink[]>();

function sinkKey(sessionId: string, terminalId: string): string {
  return `${sessionId}\u0000${terminalId}`;
}

function liveSinks(key: string): AeTerminalSink[] {
  const list = (sinks.get(key) ?? []).filter((sink) => sink.aeInputState() !== "gone");
  if (list.length === 0) sinks.delete(key);
  else sinks.set(key, list);
  return list;
}

/**
 * Register a writable terminal attach. Read-only attaches never register (the
 * server drops their input anyway). Returns the matching unregister.
 */
export function registerAeTerminalInput(
  sessionId: string,
  terminalId: string,
  sink: AeTerminalSink,
): () => void {
  const key = sinkKey(sessionId, terminalId);
  sinks.set(key, [...liveSinks(key), sink]);
  return () => {
    const rest = (sinks.get(key) ?? []).filter((s) => s !== sink);
    if (rest.length === 0) sinks.delete(key);
    else sinks.set(key, rest);
  };
}

/** The most recently attached open sink for a terminal, or null. */
export function findAeTerminalSink(sessionId: string, terminalId: string): AeTerminalSink | null {
  const open = liveSinks(sinkKey(sessionId, terminalId)).filter(
    (sink) => sink.aeInputState() === "open",
  );
  return open.length > 0 ? open[open.length - 1] : null;
}

/** How long a Run waits for the shell it opened to connect. */
export const AE_SINK_WAIT_MS = 20_000;

/**
 * Resolve with the terminal's open sink as soon as one exists (the view it was
 * just opened in connects asynchronously), or null after `timeoutMs`.
 */
export function waitForAeTerminalSink(
  sessionId: string,
  terminalId: string,
  timeoutMs = AE_SINK_WAIT_MS,
  intervalMs = 100,
): Promise<AeTerminalSink | null> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      const sink = findAeTerminalSink(sessionId, terminalId);
      if (sink !== null) {
        resolve(sink);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

/** Result of one Run. */
export type AeRunResult = { ok: true; submitted: boolean } | { ok: false; error: string };

/** What AppShell publishes while code blocks may show Run. */
export interface AeRunTarget {
  conversationId: string;
  run: (text: string, submit: boolean) => Promise<AeRunResult>;
}

let runTarget: AeRunTarget | null = null;
const targetListeners = new Set<() => void>();

/** Publish (or clear, with null) the session code blocks run in. */
export function setAeRunTarget(target: AeRunTarget | null): void {
  if (runTarget === target) return;
  runTarget = target;
  for (const listener of targetListeners) listener();
}

/** The current run target, or null. */
export function getAeRunTarget(): AeRunTarget | null {
  return runTarget;
}

function subscribeTarget(listener: () => void): () => void {
  targetListeners.add(listener);
  return () => targetListeners.delete(listener);
}

/** React view of the run target. */
export function useAeRunTarget(): AeRunTarget | null {
  return useSyncExternalStore(subscribeTarget, getAeRunTarget, () => null);
}

/** Test helper: drop every sink and the target. */
export function resetAeTerminalInputForTests(): void {
  sinks.clear();
  setAeRunTarget(null);
}
