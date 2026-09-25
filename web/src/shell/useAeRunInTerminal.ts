// [ae] Run-on-box: AppShell's side of the Run button on chat code blocks.
//
// While the viewer owns the session and its agent declares shells (the gate
// upstream's "+ New shell" uses), this publishes the run target the code
// blocks read. A Run then:
//
//   1. picks the shell: the rail's selected shell when it is live, else the
//      newest live shell, else a new one of the default type through
//      upstream's own create route (the same call as "+ New shell");
//   2. opens it where the user sees it: a rail tab on desktop, the full-screen
//      terminal view on a phone (the Shells drawer's Expand path);
//   3. waits for that view's WebSocket and pastes through it
//      (`aeTerminalInput.ts`).

import { useEffect, useRef } from "react";
import { useCreateTerminal, AGENT_TERMINAL_IDS, terminalTabKey } from "@/hooks/useTerminals";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import type { TerminalInfo } from "@/lib/terminals";
import {
  type AeRunResult,
  type AeRunTarget,
  getAeRunTarget,
  setAeRunTarget,
  waitForAeTerminalSink,
} from "@/lib/aeTerminalInput";
import { resolveDefaultShell } from "./preferredShell";

export interface AeRunInTerminalOptions {
  /** Owner of a session whose shells are reachable (not a claude-native sub-agent). */
  canRun: boolean;
  /** The agent's declared terminal names; empty means no shells, so no Run. */
  declaredShells: readonly string[];
  /** The session's terminals (AppShell's rail inventory). */
  terminals: readonly TerminalInfo[];
  /** The rail's selected shell tab key, if any. */
  selectedTerminalKey: string | null;
  /** Desktop: open a shell as a rail tab. */
  openTerminalTab: (key: string) => void;
  /** Phone: open a shell full-screen. */
  openTerminalsPanel: (key: string) => void;
}

/** The live user shell a Run should target, or null when one must be created. */
export function pickRunShell(
  terminals: readonly TerminalInfo[],
  selectedTerminalKey: string | null,
): TerminalInfo | null {
  const shells = terminals.filter((t) => t.running && !AGENT_TERMINAL_IDS.has(t.id));
  const selected = shells.find((t) => terminalTabKey(t) === selectedTerminalKey);
  return selected ?? shells[shells.length - 1] ?? null;
}

export function useAeRunInTerminal(
  conversationId: string | null | undefined,
  options: AeRunInTerminalOptions,
): void {
  const isMobile = useIsMobileViewport();
  const create = useCreateTerminal(conversationId ?? "");
  // The run closure reads the latest render's values; the published target
  // only changes when the session or the gate does.
  const latest = useRef({ ...options, isMobile, create });
  latest.current = { ...options, isMobile, create };
  const enabled = !!conversationId && options.canRun && options.declaredShells.length > 0;

  useEffect(() => {
    if (!enabled || !conversationId) return undefined;
    const target: AeRunTarget = {
      conversationId,
      async run(text: string, submit: boolean): Promise<AeRunResult> {
        const now = latest.current;
        let shell = pickRunShell(now.terminals, now.selectedTerminalKey);
        if (shell === null) {
          const name = resolveDefaultShell(now.declaredShells);
          if (name === null) return { ok: false, error: "This session declares no shell." };
          try {
            shell = await now.create.mutateAsync(name);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
              ok: false,
              error: `Could not start a shell on the host (${reason}). Check that the host is online, then run it again.`,
            };
          }
        }
        const key = terminalTabKey(shell);
        if (latest.current.isMobile) latest.current.openTerminalsPanel(key);
        else latest.current.openTerminalTab(key);
        const sink = await waitForAeTerminalSink(conversationId, shell.id);
        if (sink === null || !sink.aePaste(text, submit)) {
          return {
            ok: false,
            error:
              "The shell did not connect within 20 seconds. Nothing was sent; open the shell and run it again.",
          };
        }
        return { ok: true, submitted: submit };
      },
    };
    setAeRunTarget(target);
    return () => {
      if (getAeRunTarget() === target) setAeRunTarget(null);
    };
  }, [enabled, conversationId]);
}
