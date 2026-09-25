// [ae] Paste into a terminal from a touch device (omnigent-ae, 2026-09-24).
//
// xterm.js draws the terminal on a canvas and keeps its keyboard input in a
// hidden textarea, so a long press on a phone offers no Paste: iOS never
// shows the edit menu over it. This control fills that gap. It shows only on
// a coarse (touch) primary pointer, and `TerminalView` renders it only while
// a writable attach is connected.
//
// A tap reads the clipboard inside the user gesture and writes the text
// through the session's `aeWrite` (xterm's own paste, bracketed when the
// shell asked for it; Enter is never pressed). When the Clipboard API is
// missing (plain HTTP) or refuses (iOS declined, permission denied, empty),
// a small sheet opens with a textarea, where the native long press paste
// works, and Send writes what it holds. The text is never logged or stored.

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useIsCoarsePointer } from "@/hooks/useIsCoarsePointer";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";
import type { AeTerminalSink } from "@/lib/aeTerminalInput";

/**
 * Tabler `clipboard-text` (outline), from @tabler/icons 3.46.0, inlined so a
 * single small button does not pull in the lazy chunk of every icon.
 */
const CLIPBOARD_TEXT_ICON: AeTablerIconNode = [
  [
    "path",
    { d: "M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2" },
  ],
  ["path", { d: "M9 5a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2" }],
  ["path", { d: "M9 12h6" }],
  ["path", { d: "M9 16h6" }],
];

/** The part of a `TerminalSession` a paste needs. */
export type AeTerminalPasteSink = Pick<AeTerminalSink, "aeWrite" | "focus">;

async function readClipboard(): Promise<string | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) return null;
    const text = await navigator.clipboard.readText();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

export function AeTerminalPaste({ getSink }: { getSink: () => AeTerminalPasteSink | null }) {
  const coarse = useIsCoarsePointer();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const reading = useRef(false);
  const focusAfterClose = useRef(false);

  if (!coarse) return null;

  const write = (text: string): boolean => {
    const sink = getSink();
    if (sink === null) return false;
    sink.aeWrite(text, false);
    return true;
  };

  const paste = async () => {
    if (reading.current) return;
    reading.current = true;
    const text = await readClipboard();
    reading.current = false;
    if (text !== null && write(text)) {
      getSink()?.focus();
      return;
    }
    setDraft("");
    setSheetOpen(true);
  };

  const closeSheet = (sent: boolean) => {
    focusAfterClose.current = sent;
    setDraft("");
    setSheetOpen(false);
  };

  const send = () => {
    if (draft === "") return;
    closeSheet(write(draft));
  };

  return (
    <>
      <Button
        aria-label="Paste into terminal"
        className="absolute top-2 right-4 z-30 size-9 border border-border bg-background/80 p-0 text-muted-foreground shadow-sm supports-[backdrop-filter]:bg-background/60 supports-[backdrop-filter]:backdrop-blur"
        data-testid="ae-terminal-paste"
        // Keep the terminal's focus (and the phone's keyboard) through the tap.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void paste()}
        title="Paste"
        type="button"
        variant="ghost"
      >
        <AeTablerSvg node={CLIPBOARD_TEXT_ICON} className="size-5" />
      </Button>
      <Dialog open={sheetOpen} onOpenChange={(open) => !open && closeSheet(false)}>
        {sheetOpen && (
          <DialogContent
            className="sm:max-w-md"
            data-testid="ae-terminal-paste-sheet"
            onCloseAutoFocus={(event) => {
              if (!focusAfterClose.current) return;
              focusAfterClose.current = false;
              event.preventDefault();
              getSink()?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>Paste into the terminal</DialogTitle>
              <DialogDescription>
                The clipboard could not be read directly. Long press the box, choose Paste, then
                Send. Enter is not pressed.
              </DialogDescription>
            </DialogHeader>
            <Textarea
              aria-label="Text to paste"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              autoFocus
              // 16px keeps iOS from zooming the page when the box takes focus.
              className="max-h-48 min-h-24 font-mono text-base md:text-base"
              data-testid="ae-terminal-paste-text"
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              value={draft}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => closeSheet(false)}
                data-testid="ae-terminal-paste-cancel"
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={draft === ""}
                onClick={send}
                data-testid="ae-terminal-paste-send"
              >
                Send
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
