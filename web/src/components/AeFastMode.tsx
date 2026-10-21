// The fast mode switch at the bottom of the composer's model menu
// (omnigent-ae, 2026-10-14). Reid asked for Claude Desktop's fast mode switch
// "if I'm ever connected to a Claude session", per session. Claude Code takes
// `/fast on|off` mid-session and reports the state in its status line; this
// row reads and changes it through `@/lib/aeFastMode`.
//
// Shown for claude-native sessions only. Turning it on needs an Opus release
// with fast mode and a host that keeps fast mode per session; turning it off
// is always allowed. The switch never guesses: until the session reports its
// state it is drawn off with a note saying so. A change Claude Code has not
// confirmed yet keeps the switch at the requested state with the reason, and
// the open menu re-reads it.

import { useEffect, useId } from "react";
import * as DropdownMenuPrimitive from "radix-ui/dropdown-menu";
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { MenuItem } from "@/components/ui/menu-item";
import {
  AE_FAST_MODE_RECHECK_MS,
  aeFastModeModelSupported,
  changeAeFastMode,
  refreshAeFastMode,
  useAeFastMode,
} from "@/lib/aeFastMode";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";

export const AE_FAST_MODE_HINT = "Faster Opus output; bills usage credits";
export const AE_FAST_MODE_NEEDS_PER_SESSION = "Needs per-session fast mode on this host";
export const AE_FAST_MODE_NEEDS_OPUS = "Choose a supported Opus model to turn on fast mode";

/** The design system's Switch, drawn without a button: the menu item is the control. */
function SwitchTrack({ checked, disabled }: { checked: boolean; disabled: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-state={checked ? "checked" : "unchecked"}
      className={cn(
        "inline-flex h-[18.4px] w-[32px] shrink-0 items-center rounded-full border border-transparent transition-all",
        checked ? "bg-primary" : "bg-input dark:bg-input/80",
        disabled && "opacity-50",
      )}
    >
      <span
        className={cn(
          "block size-4 rounded-full bg-background transition-transform",
          checked
            ? "translate-x-[calc(100%-2px)] dark:bg-primary-foreground"
            : "dark:bg-foreground",
        )}
      />
    </span>
  );
}

export function AeFastModeSection({
  pickerKind,
  model,
  modelLabel,
  busy = false,
}: {
  /** The composer's model picker kind; the row shows only for "claude". */
  pickerKind: string | null;
  /** The session's model id as reported, e.g. "claude-opus-5-5". */
  model: string | null;
  /** The chip's label for it, e.g. "Opus 5.5", for ids that carry no version. */
  modelLabel: string | null;
  /** Another configuration change is running. */
  busy?: boolean;
}) {
  const sessionId = useChatStore((state) => state.conversationId);
  const modelChangePending = useChatStore((state) => state.pendingModelChange !== null);
  const shown = pickerKind === "claude" && sessionId !== null;
  const state = useAeFastMode(shown ? sessionId : null);
  const awaitingConfirmation = state.pending !== null && state.pendingReason !== null;
  const labelId = useId();
  const hintId = useId();
  const noteId = useId();
  useEffect(() => {
    if (shown && sessionId) void refreshAeFastMode(sessionId);
  }, [shown, sessionId]);
  useEffect(() => {
    if (!shown || !sessionId || !awaitingConfirmation) return;
    const timer = setInterval(() => void refreshAeFastMode(sessionId), AE_FAST_MODE_RECHECK_MS);
    return () => clearInterval(timer);
  }, [shown, sessionId, awaitingConfirmation]);
  if (!shown || sessionId === null) return null;

  const pending = state.pending !== null;
  const checked = state.pending ?? state.enabled ?? false;
  // Why turning it on is unavailable; off stays allowed while it is on or unknown.
  // An unsupported model is the common case, so it is the row's tooltip, not a
  // second line; the host's limit is rarer and stays visible.
  const modelUnsupported = !aeFastModeModelSupported(model, modelLabel);
  const onBlocked = modelUnsupported
    ? AE_FAST_MODE_NEEDS_OPUS
    : state.perSession === false
      ? AE_FAST_MODE_NEEDS_PER_SESSION
      : null;
  const mayTurnOff = state.enabled === true || (state.enabled === null && state.settled);
  const disabled = pending || busy || modelChangePending || (onBlocked !== null && !mayTurnOff);
  const failed = !pending && state.error !== null;
  const note = pending
    ? (state.pendingReason ?? `Turning fast mode ${state.pending ? "on" : "off"}…`)
    : (state.error ??
      (modelUnsupported ? null : onBlocked) ??
      (state.enabled === null && state.settled ? "Unknown until the session replies" : null));

  return (
    <div data-testid="composer-fast-mode">
      <DropdownMenuSeparator />
      {/* The composer menu pads checkbox rows for a check mark; this row draws a switch. */}
      <MenuItem asChild density="none" interactive={!disabled} className="pr-2!">
        <DropdownMenuPrimitive.CheckboxItem
          checked={checked}
          disabled={disabled}
          aria-labelledby={labelId}
          aria-describedby={note ? `${hintId} ${noteId}` : hintId}
          title={modelUnsupported ? AE_FAST_MODE_NEEDS_OPUS : AE_FAST_MODE_HINT}
          aria-busy={pending || undefined}
          data-testid="composer-fast-mode-switch"
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={(next) =>
            void changeAeFastMode(sessionId, onBlocked === null && next === true)
          }
        >
          <span className="flex min-w-0 flex-1 flex-col whitespace-normal break-words">
            <span id={labelId} className={cn("leading-5", disabled && "text-muted-foreground")}>
              Fast mode
            </span>
            <span id={hintId} className="sr-only">
              {modelUnsupported ? `${AE_FAST_MODE_HINT}. ${AE_FAST_MODE_NEEDS_OPUS}` : AE_FAST_MODE_HINT}
            </span>
            {note && (
              <span
                id={noteId}
                data-testid="composer-fast-mode-note"
                className={cn(
                  "mt-0.5 text-xs leading-4",
                  failed ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {note}
              </span>
            )}
          </span>
          <SwitchTrack checked={checked} disabled={disabled} />
        </DropdownMenuPrimitive.CheckboxItem>
      </MenuItem>
    </div>
  );
}
