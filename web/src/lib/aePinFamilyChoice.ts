// The "pin only the parent, or the whole family?" question (omnigent-ae,
// 2026-10-31): a one-slot store the cascade (shell/aePinFamily.ts) asks
// through and the dialog (shell/AePinFamilyChoice.tsx) answers. Kept in lib/ so
// both files share it without importing a component.

import { useSyncExternalStore } from "react";

export type AePinFamilyAnswer = "parent" | "family" | "cancel";

export interface AePinFamilyQuestion {
  /** Whether the lead is being pinned or unpinned. */
  action: "pin" | "unpin";
  /** The lead's title, shown in the dialog. */
  title: string | null;
  /** Why the whole family cannot be taken (pin only): the family button is disabled with it. */
  familyBlocked?: string;
}

let current: {
  question: AePinFamilyQuestion;
  resolve: (answer: AePinFamilyAnswer) => void;
} | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

/** Asks; resolves with the answer, or "cancel" when closed or replaced by a newer question. */
export function askPinFamily(question: AePinFamilyQuestion): Promise<AePinFamilyAnswer> {
  current?.resolve("cancel");
  return new Promise((resolve) => {
    current = { question, resolve };
    emit();
  });
}

export function answerPinFamily(answer: AePinFamilyAnswer): void {
  const open = current;
  if (!open) return;
  current = null;
  emit();
  open.resolve(answer);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => current?.question ?? null;

export function usePinFamilyQuestion(): AePinFamilyQuestion | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
