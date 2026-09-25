// [ae] Run-on-box: the transport half of the Run button on chat code blocks.
//
// Two small module-level registries, so the chat's code blocks (deep inside
// Streamdown) and the shell surfaces (under AppShell) never need a prop path:
//
//   - Input sinks. Every writable `TerminalView` registers its live
//     `TerminalSession` here under (session id, terminal id). A Run writes
//     through `TerminalSession.aeWrite`, which is xterm's own paste followed
//     by an Enter keystroke: the bytes take the same `term.onData` path, and
//     the same WebSocket, as the keyboard. No new server endpoint.
//
//     A sink is ready only once the shell has drawn and gone quiet. xterm
//     brackets a paste only after it has parsed the shell's own request for
//     bracketed paste (ESC[?2004h), which arrives with the shell's first
//     output, not with the WebSocket's open. Pasted unbracketed, every newline
//     is an Enter: the lines of a block held back for an open heredoc would
//     run anyway, and a password prompt would read the next line. So a
//     multi-line block is never pasted unbracketed.
//   - The run target. AppShell publishes one while the viewer owns a session
//     whose agent declares shells (`useAeRunInTerminal`); code blocks show Run
//     only while it is set.

import { useSyncExternalStore } from "react";
import type { AeShellKind } from "./aeRunCommand";

/** What a `TerminalSession` exposes to a Run. */
export interface AeTerminalSink {
  /** `open` once the WebSocket is up; `gone` after dispose or close. */
  aeInputState: () => "open" | "connecting" | "gone";
  /** Subscribe to the terminal finishing parsing a chunk of output. */
  aeOnOutput: (listener: () => void) => { dispose: () => void };
  /** Whether the shell has turned on bracketed paste. */
  aeBracketedPaste: () => boolean;
  /** Paste through the keyboard path, then press Enter when `submit`. */
  aeWrite: (text: string, submit: boolean) => void;
  /** Give the terminal the keyboard focus. */
  focus: () => void;
}

interface SinkEntry {
  sink: AeTerminalSink;
  /** `performance.now()` of the first and the latest parsed output, or null. */
  firstOutputAt: number | null;
  lastOutputAt: number | null;
  output: { dispose: () => void };
}

const sinks = new Map<string, SinkEntry[]>();

function sinkKey(sessionId: string, terminalId: string): string {
  return `${sessionId}\u0000${terminalId}`;
}

function liveSinks(key: string): SinkEntry[] {
  const list = (sinks.get(key) ?? []).filter((e) => e.sink.aeInputState() !== "gone");
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
  const entry: SinkEntry = {
    sink,
    firstOutputAt: null,
    lastOutputAt: null,
    output: { dispose: () => {} },
  };
  entry.output = sink.aeOnOutput(() => {
    const now = performance.now();
    entry.firstOutputAt ??= now;
    entry.lastOutputAt = now;
  });
  sinks.set(key, [...liveSinks(key), entry]);
  return () => {
    entry.output.dispose();
    const rest = (sinks.get(key) ?? []).filter((e) => e !== entry);
    if (rest.length === 0) sinks.delete(key);
    else sinks.set(key, rest);
  };
}

/** Quiet after the shell's last output before a Run pastes. */
export const AE_SINK_QUIET_MS = 400;
/** A shell that keeps printing is written to this long after its first output. */
export const AE_SINK_BUSY_MS = 2_000;

function isReady(entry: SinkEntry, now: number): boolean {
  if (entry.sink.aeInputState() !== "open") return false;
  if (entry.firstOutputAt === null || entry.lastOutputAt === null) return false;
  return (
    now - entry.lastOutputAt >= AE_SINK_QUIET_MS || now - entry.firstOutputAt >= AE_SINK_BUSY_MS
  );
}

/**
 * The most recently attached sink for a terminal that is ready for a paste
 * (connected, its shell drawn and quiet), or null.
 */
export function findAeTerminalSink(sessionId: string, terminalId: string): AeTerminalSink | null {
  const now = performance.now();
  const ready = liveSinks(sinkKey(sessionId, terminalId)).filter((e) => isReady(e, now));
  return ready.length > 0 ? ready[ready.length - 1].sink : null;
}

/** How long a Run waits for the shell it opened to connect. */
export const AE_SINK_WAIT_MS = 20_000;

/**
 * Resolve with the terminal's ready sink as soon as one exists (the view it
 * was just opened in connects asynchronously), or null after `timeoutMs`.
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

/**
 * Paste a Run's text into a ready sink. A multi-line block needs bracketed
 * paste (see the header); without it nothing is sent.
 */
export function pasteIntoAeTerminal(
  sink: AeTerminalSink,
  text: string,
  submit: boolean,
): AeRunResult {
  if (sink.aeInputState() !== "open") {
    return {
      ok: false,
      error: "The shell disconnected before the paste. Nothing was sent; run it again.",
    };
  }
  if (text.includes("\n") && !sink.aeBracketedPaste()) {
    return {
      ok: false,
      error:
        "This shell has not turned on bracketed paste, so the lines would run one by one. Nothing was sent; copy the block into the terminal instead.",
    };
  }
  sink.aeWrite(text, submit);
  return { ok: true, submitted: submit, focus: () => sink.focus() };
}

/** Result of one Run. */
export type AeRunResult =
  | {
      ok: true;
      submitted: boolean;
      /** Focus the terminal it went to; called once the confirm sheet has closed. */
      focus: () => void;
    }
  | { ok: false; error: string };

/** What AppShell publishes while code blocks may show Run. */
export interface AeRunTarget {
  conversationId: string;
  /** The shell kinds the session declares; a block runs only in its own kind. */
  shells: ReadonlySet<AeShellKind>;
  run: (text: string, submit: boolean, shell: AeShellKind) => Promise<AeRunResult>;
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
