// [ae] Paste into a terminal from a touch device (omnigent-ae, 2026-09-24).
//
// xterm.js draws the terminal on a canvas and keeps its keyboard input in a
// hidden textarea, so a long press on a phone offers no Paste: iOS never
// shows the edit menu over it. This control fills that gap. It shows only on
// a coarse (touch) primary pointer. `TerminalView` keeps it mounted for as
// long as the attach is writable, so an open sheet and its text survive a
// dropped socket (an iOS app switch); the button is disabled while the
// terminal is not connected.
//
// A tap takes the terminal session that is current at that moment, reads the
// clipboard inside the user gesture, and pastes through `pasteIntoAeTerminal`,
// the same guards a Run gets: nothing is written unless the socket is open,
// and multi-line text is refused unless the shell turned on bracketed paste
// (otherwise every line would run as it arrived). One trailing newline, a
// common copy artifact, is dropped. Enter is never pressed. A write goes only
// to the session the tap started with; if the terminal reconnected during
// the read, the text waits in the sheet instead.
//
// The sheet opens whenever a paste does not go through, with a message for
// the cause: the Clipboard API missing (plain HTTP) or refused, an empty
// clipboard, a terminal that is not ready, or multi-line text the shell
// cannot take. Its textarea keeps any text that was read and takes the native
// long press Paste; Send pastes through the same guards and closes only on
// success. The text is never logged or stored.
//
// Focus goes back to the terminal after a paste for a hardware keyboard. iOS
// does not raise its on-screen keyboard from a focus call made after an
// await, so on a phone the terminal is tapped again to type.

import { useEffect, useRef, useState } from "react";
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
import { type AeTerminalSink, pasteIntoAeTerminal } from "@/lib/aeTerminalInput";

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

/** Why the sheet is open; each cause has its own message. */
export type AePasteSheetReason = "unreadable" | "empty" | "not-ready" | "reconnected" | "multiline";

export const AE_PASTE_MESSAGES: Record<AePasteSheetReason, string> = {
  unreadable:
    "The clipboard could not be read directly. Long press the box, choose Paste, then Send.",
  empty: "Clipboard is empty. Copy the text again, or long press the box and choose Paste.",
  "not-ready": "The terminal is not connected, so nothing was sent. Tap Send once it is back.",
  reconnected:
    "The terminal reconnected while the clipboard was read, so nothing was sent. Tap Send to paste.",
  multiline:
    "This shell has not turned on bracketed paste, so each line would run as it arrived. Nothing was sent; edit the text to one line, or Cancel.",
};

/** Drop exactly one trailing newline (`\n` or `\r\n`). */
export function aeTrimPasteText(text: string): string {
  return text.replace(/\r?\n$/, "");
}

type ClipboardRead = { kind: "text"; text: string } | { kind: "empty" } | { kind: "unreadable" };

async function readClipboard(): Promise<ClipboardRead> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
      return { kind: "unreadable" };
    }
    const text = aeTrimPasteText(await navigator.clipboard.readText());
    return text === "" ? { kind: "empty" } : { kind: "text", text };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * Paste through the Run guards. Returns the terminal's focus call when the
 * paste went through, else the sheet's reason.
 */
function tryPaste(
  sink: AeTerminalSink | null,
  text: string,
): { ok: true; focus: () => void } | { ok: false; reason: AePasteSheetReason } {
  if (sink === null || sink.aeInputState() !== "open") return { ok: false, reason: "not-ready" };
  const result = pasteIntoAeTerminal(sink, text, false);
  if (result.ok) return { ok: true, focus: result.focus };
  return { ok: false, reason: sink.aeInputState() === "open" ? "multiline" : "not-ready" };
}

export function AeTerminalPaste({
  getSink,
  connected,
}: {
  /** The terminal's current session (a re-dial replaces it), or null. */
  getSink: () => AeTerminalSink | null;
  /** Whether the attach is connected; the button is disabled otherwise. */
  connected: boolean;
}) {
  const coarse = useIsCoarsePointer();
  const [reason, setReason] = useState<AePasteSheetReason | null>(null);
  const [draft, setDraft] = useState("");
  // Bumped on every tap and on unmount, so a read that resolves late is dropped.
  const readGeneration = useRef(0);
  const reading = useRef(false);
  // Set by a Send that went through; called once the sheet has closed (while
  // it is open its focus trap would take the focus back).
  const focusAfterClose = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      readGeneration.current += 1;
      reading.current = false;
    },
    [],
  );

  if (!coarse) return null;

  const openSheet = (why: AePasteSheetReason, text: string) => {
    setDraft(text);
    setReason(why);
  };

  const paste = async () => {
    if (reading.current) return;
    reading.current = true;
    const generation = ++readGeneration.current;
    const sink = getSink();
    const read = await readClipboard();
    if (generation !== readGeneration.current) return;
    reading.current = false;
    if (read.kind !== "text") {
      openSheet(read.kind, "");
      return;
    }
    const current = getSink();
    if (sink === null || current !== sink || sink.aeInputState() !== "open") {
      openSheet(sink !== null && current !== sink ? "reconnected" : "not-ready", read.text);
      return;
    }
    const pasted = tryPaste(sink, read.text);
    if (pasted.ok) pasted.focus();
    else openSheet(pasted.reason, read.text);
  };

  const closeSheet = () => {
    setReason(null);
    setDraft("");
  };

  const send = () => {
    const text = aeTrimPasteText(draft);
    if (text === "") return;
    const pasted = tryPaste(getSink(), text);
    if (!pasted.ok) {
      setReason(pasted.reason);
      return;
    }
    focusAfterClose.current = pasted.focus;
    closeSheet();
  };

  return (
    <>
      <Button
        aria-label="Paste into terminal"
        className="absolute top-2 right-4 z-30 size-9 border border-border bg-background/80 p-0 text-muted-foreground shadow-sm supports-[backdrop-filter]:bg-background/60 supports-[backdrop-filter]:backdrop-blur"
        data-testid="ae-terminal-paste"
        disabled={!connected}
        // Keep the terminal's focus through the tap where the browser allows.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void paste()}
        title="Paste"
        type="button"
        variant="ghost"
      >
        <AeTablerSvg node={CLIPBOARD_TEXT_ICON} className="size-5" />
      </Button>
      <Dialog open={reason !== null} onOpenChange={(open) => !open && closeSheet()}>
        <DialogContent
          className="sm:max-w-md"
          data-testid="ae-terminal-paste-sheet"
          onCloseAutoFocus={(event) => {
            const focus = focusAfterClose.current;
            focusAfterClose.current = null;
            if (focus === null) return;
            event.preventDefault();
            focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Paste into the terminal</DialogTitle>
            <DialogDescription data-testid="ae-terminal-paste-message" data-reason={reason ?? ""}>
              {reason !== null && AE_PASTE_MESSAGES[reason]} Enter is not pressed.
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
              onClick={closeSheet}
              data-testid="ae-terminal-paste-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={aeTrimPasteText(draft) === ""}
              onClick={send}
              data-testid="ae-terminal-paste-send"
            >
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
