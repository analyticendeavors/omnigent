// [ae] Run-on-box: the Run button on a chat code block and its confirm sheet.
//
// Rendered by `ChatCodeBlockPre` (components/ai-elements/message.tsx) beside
// upstream's wrap and copy buttons. It shows only when all of these hold:
//
//   - AppShell published a run target (the viewer owns a session whose agent
//     declares shells; `useAeRunInTerminal`),
//   - the block sits in an assistant text section of the main chat (not a
//     user bubble, not a side chat, not a plan or a PR body),
//   - the block is a shell fence or an untagged block that reads as commands
//     (`aeRunCommand.ts`), and the session declares a shell of its kind (a
//     powershell block needs a PowerShell shell; hosts are Linux, macOS, WSL),
//   - the message has finished streaming (Streamdown's own context carries the
//     mode upstream's MessageResponse passes): a block still arriving is a
//     partial command.
//
// After a Run the terminal gets the focus once the sheet has closed (while it
// is open its focus trap would take it back), so a sudo password prompt can be
// answered by typing.
//
// Nothing is sent until the sheet's Run: the sheet shows the exact text, says
// plainly when the block uses sudo, rm -rf, curl | sh or dd, and says when
// Enter is withheld because a heredoc or a quote is still open.

import { PlayIcon, TriangleAlertIcon } from "lucide-react";
import { isValidElement, useContext, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { StreamdownContext } from "streamdown";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { showToast } from "@/components/ui/toast";
import {
  blockShellKind,
  codeBlockLanguage,
  isRunnableBlock,
  planRun,
  type AeRunPlan,
} from "@/lib/aeRunCommand";
import { useAeRunTarget } from "@/lib/aeTerminalInput";

/** Marker upstream's BlockRenderer puts on every assistant text section. */
const ASSISTANT_SECTION_SELECTOR = '[data-testid="assistant-text-section"]';

function blockLanguage(block: ReactNode): string | null {
  if (!isValidElement<{ className?: string }>(block)) return null;
  return codeBlockLanguage(block.props.className);
}

export function AeRunCodeButton({ block, code }: { block: ReactNode; code: string }) {
  const target = useAeRunTarget();
  const inSideChat = useContext(ConversationScopeContext) !== null;
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [inAssistantText, setInAssistantText] = useState(false);
  const [plan, setPlan] = useState<AeRunPlan | null>(null);
  const [running, setRunning] = useState(false);
  const focusAfterClose = useRef<(() => void) | null>(null);
  const streaming = useContext(StreamdownContext).mode === "streaming";
  const language = blockLanguage(block);

  useLayoutEffect(() => {
    setInAssistantText(anchorRef.current?.closest(ASSISTANT_SECTION_SELECTOR) != null);
  }, []);

  const visible =
    target !== null &&
    !streaming &&
    !inSideChat &&
    inAssistantText &&
    target.shells.has(blockShellKind(language)) &&
    isRunnableBlock(language, code);

  const confirm = async () => {
    if (!plan || !target) return;
    setRunning(true);
    const result = await target.run(plan.text, plan.submit, plan.shell);
    focusAfterClose.current = result.ok ? result.focus : null;
    setRunning(false);
    setPlan(null);
    if (!result.ok) showToast(result.error);
    else if (!result.submitted)
      showToast("Pasted without Enter. Finish the command in the terminal.");
  };

  return (
    <span ref={anchorRef} className="contents" data-testid="ae-run-anchor">
      {visible && (
        <Button
          aria-label="Run in terminal"
          className="h-6 gap-1 bg-sidebar/80 px-1.5 text-xs text-muted-foreground hover:bg-sidebar/80 hover:text-foreground dark:hover:bg-sidebar/80 supports-[backdrop-filter]:bg-sidebar/70 supports-[backdrop-filter]:backdrop-blur"
          data-testid="ae-run-button"
          onClick={() => setPlan(planRun(code, language))}
          size="sm"
          title="Run in this session's shell"
          type="button"
          variant="ghost"
        >
          <PlayIcon className="size-3" aria-hidden />
          Run
        </Button>
      )}
      <Dialog open={plan !== null} onOpenChange={(open) => !open && !running && setPlan(null)}>
        {plan && (
          <DialogContent
            className="max-h-[85vh] overflow-y-auto sm:max-w-lg"
            data-testid="ae-run-sheet"
            onCloseAutoFocus={(event) => {
              const focus = focusAfterClose.current;
              focusAfterClose.current = null;
              if (focus === null) return;
              event.preventDefault();
              focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>Run in the terminal?</DialogTitle>
              <DialogDescription>
                {plan.submit
                  ? "This text is pasted into the session's shell on its host, then Enter is pressed."
                  : "This text is pasted into the session's shell on its host. Enter is not pressed."}
              </DialogDescription>
            </DialogHeader>
            <pre
              className="max-h-64 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all"
              data-testid="ae-run-text"
            >
              {plan.text}
            </pre>
            {plan.dangers.length > 0 && (
              <ul className="flex flex-col gap-1.5" data-testid="ae-run-dangers">
                {plan.dangers.map((danger) => (
                  <li
                    key={danger.id}
                    className="flex items-start gap-2 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
                    data-danger={danger.id}
                  >
                    <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    <span>{danger.message}</span>
                  </li>
                ))}
              </ul>
            )}
            {plan.removedHidden > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="ae-run-removed">
                {plan.removedHidden === 1
                  ? "1 hidden control character was removed from the block before sending."
                  : `${plan.removedHidden} hidden control characters were removed from the block before sending.`}
              </p>
            )}
            {plan.hint && (
              <p className="text-xs text-muted-foreground" data-testid="ae-run-hint">
                {plan.hint}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={running}
                onClick={() => setPlan(null)}
                data-testid="ae-run-cancel"
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant={plan.dangers.length > 0 ? "destructive" : "default"}
                disabled={running}
                onClick={() => void confirm()}
                data-testid="ae-run-confirm"
              >
                {running ? "Sending…" : "Run"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </span>
  );
}
