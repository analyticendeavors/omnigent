// [ae] Run-on-box: AppShell's side of the Run button on chat code blocks.
//
// While the viewer owns the session and its agent declares shells (the gate
// upstream's "+ New shell" uses), this publishes the run target the code
// blocks read. A Run then:
//
//   1. picks the shell, of the block's kind only (a powershell block never
//      lands in bash, a bash block never in pwsh): the rail's selected shell
//      when it is live, else the newest live shell, else a new one of the
//      default type through upstream's own create route (the same call as
//      "+ New shell");
//   2. opens it where the user sees it: a rail tab on desktop, the full-screen
//      terminal view on a phone (the Shells drawer's Expand path);
//   3. waits for that view's WebSocket and pastes through it
//      (`aeTerminalInput.ts`).

import { useEffect, useMemo, useRef } from "react";
import { useCreateTerminal, AGENT_TERMINAL_IDS, terminalTabKey } from "@/hooks/useTerminals";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import type { TerminalInfo } from "@/lib/terminals";
import { type AeShellKind, terminalShellKind } from "@/lib/aeRunCommand";
import {
  type AeRunResult,
  type AeRunTarget,
  getAeRunTarget,
  pasteIntoAeTerminal,
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

/** The live user shell of `kind` a Run should target, or null when one must be created. */
export function pickRunShell(
  terminals: readonly TerminalInfo[],
  selectedTerminalKey: string | null,
  kind: AeShellKind = "posix",
): TerminalInfo | null {
  const shells = terminals.filter(
    (t) => t.running && !AGENT_TERMINAL_IDS.has(t.id) && terminalShellKind(t.name) === kind,
  );
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
  const kindsKey = [...new Set(options.declaredShells.map(terminalShellKind))].sort().join(",");
  const shells = useMemo(
    () => new Set(kindsKey.split(",").filter(Boolean) as AeShellKind[]),
    [kindsKey],
  );

  useEffect(() => {
    if (!enabled || !conversationId) return undefined;
    const target: AeRunTarget = {
      conversationId,
      shells,
      async run(text: string, submit: boolean, kind: AeShellKind): Promise<AeRunResult> {
        const now = latest.current;
        let shell = pickRunShell(now.terminals, now.selectedTerminalKey, kind);
        if (shell === null) {
          const declared = now.declaredShells.filter((name) => terminalShellKind(name) === kind);
          const name = resolveDefaultShell(declared);
          if (name === null) {
            return {
              ok: false,
              error:
                kind === "powershell"
                  ? "This session has no PowerShell shell. Nothing was sent."
                  : "This session declares no shell. Nothing was sent.",
            };
          }
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
        if (sink === null) {
          return {
            ok: false,
            error:
              "The shell did not connect within 20 seconds. Nothing was sent; open the shell and run it again.",
          };
        }
        return pasteIntoAeTerminal(sink, text, submit);
      },
    };
    setAeRunTarget(target);
    return () => {
      if (getAeRunTarget() === target) setAeRunTarget(null);
    };
  }, [enabled, conversationId, shells]);
}
