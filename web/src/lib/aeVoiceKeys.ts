// Desktop Voice mode keys (omnigent-ae, 2026-11-19): Enter sends the heard draft, Esc ends Voice
// mode while listening or speaking. Escape keeps its other jobs: it stops a working chat, closes
// a dialog, menu or the /btw overlay, and (Voice mode off) discards a dictation take.

import type { VoicePhase } from "@/lib/aeVoiceMode";

export interface VoiceKeyContext {
  voiceOn: boolean;
  /** The phone sheet has no key hints and no Escape change. */
  sheet: boolean;
  phase: VoicePhase;
  /** The chat is working, read-only, or a /btw, slash or mention menu is open. */
  busy: boolean;
  /** A dialog, menu or listbox is open in the document. */
  overlayOpen: boolean;
  /** The key came from the composer text box or the page itself, not a button, menu or editor. */
  targetOk: boolean;
}

export type VoiceKeyAction = "send" | "end" | null;

const OVERLAY_SELECTOR = '[role="dialog"], [role="menu"], [role="listbox"]';

/** True when a dialog, menu or listbox is open (a closed or hidden one does not count). */
export function overlayIsOpen(doc: Document = document): boolean {
  for (const el of doc.querySelectorAll(OVERLAY_SELECTOR)) {
    if (el.closest('[hidden], [aria-hidden="true"], [data-state="closed"]')) continue;
    return true;
  }
  return false;
}

/** True for a key from the composer's own text box, or from the page when nothing is focused. */
export function isComposerKeyTarget(
  target: EventTarget | null,
  composer: HTMLElement | null,
  doc: Document = document,
): boolean {
  if (target === null) return true;
  if (composer !== null && target === composer) return true;
  return target === doc.body || target === doc.documentElement || target === doc;
}

/** What a key press does in Voice mode, or null to leave it to the other handlers. */
export function voiceKeyAction(
  e: Pick<KeyboardEvent, "key" | "repeat" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & {
    isComposing?: boolean;
  },
  ctx: VoiceKeyContext,
): VoiceKeyAction {
  if (!ctx.voiceOn || ctx.sheet || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.isComposing || !ctx.targetOk || ctx.busy || ctx.overlayOpen) return null;
  if (e.key === "Enter" && !e.shiftKey && ctx.phase === "listening") return "send";
  if (e.key === "Escape" && (ctx.phase === "listening" || ctx.phase === "speaking")) {
    return "end";
  }
  return null;
}
