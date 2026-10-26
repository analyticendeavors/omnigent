// The update nudge in the preset editor (omnigent-ae, 2026-10-26): a chip on a
// row whose model has a newer version in its family, and a line in the preset's
// header that counts them. See hooks/useAeModelUpdates for the state.

import { useEffect, useRef } from "react";
import { AeHint } from "@/components/AeHint";
import type { AeModelUpdatesState } from "@/hooks/useAeModelUpdates";
import { aeClaudeEffortLabel } from "@/lib/aeEffortDefault";
import { type AeModelUpdate, aeUpdateRowName } from "@/lib/aeModelUpdates";

// Below 480px the chip may wrap under the bar; above it the chip stays on the bar's line.
const CHIP =
  "inline-flex h-4 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-teal-700/40 bg-teal-500/10 px-1.5 text-xs leading-none dark:border-teal-400/40";
// Teal 700 on white and teal 300 on the dark page both clear 4.5:1. The pseudo-element
// widens the tap area to 24px while the chip stays 16px tall.
const ACTION =
  "relative shrink-0 font-medium text-teal-700 hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40 dark:text-teal-300 after:absolute after:-inset-x-1 after:-inset-y-1 after:content-['']";

/** The chip for one row: "<new model> Update", or "Was <old> Undo" once clicked. */
export function AeUpdateChip({
  rowKey,
  state,
  disabled,
}: {
  rowKey: string;
  state: AeModelUpdatesState;
  disabled: boolean;
}) {
  const done = state.updated.get(rowKey);
  const update = state.pending.find((u) => u.key === rowKey);
  const undoRef = useRef<HTMLButtonElement>(null);
  const updateRef = useRef<HTMLButtonElement>(null);
  const mine = state.focusKey === rowKey;
  // After a click the chip swaps its button; keyboard focus follows to the new one.
  useEffect(() => {
    if (mine) (done ? undoRef : updateRef).current?.focus();
  }, [mine, done]);
  if (done) {
    const text = `Was ${done.fromLabel}`;
    return (
      <span data-testid={`ae-model-updated-${rowKey}`} className={CHIP}>
        <span title={text} className="truncate text-foreground">
          {text}
          {done.effortFallback && `, effort now ${aeClaudeEffortLabel(done.effortFallback)}`}
        </span>
        <button
          ref={undoRef}
          type="button"
          disabled={disabled}
          aria-label={`Undo the update of ${done.name}`}
          onClick={() => state.undo(rowKey)}
          className={ACTION}
        >
          Undo
        </button>
        <AeHint id="nudge.update" className="-my-0.5 ml-0" />
      </span>
    );
  }
  if (!update) return null;
  const name = aeUpdateRowName(update.role, update.slot);
  const label = `${update.toLabel}${update.effortFallback ? `, effort ${aeClaudeEffortLabel(update.effortFallback)}` : ""}`;
  return (
    <span data-testid={`ae-model-chip-${rowKey}`} title={update.note ?? undefined} className={CHIP}>
      <span className="truncate text-foreground">{label}</span>
      <button
        ref={updateRef}
        type="button"
        disabled={disabled}
        aria-label={`Update ${name} to ${update.toLabel}${update.note ? `. ${update.note}` : ""}`}
        onClick={() => state.update(rowKey)}
        className={ACTION}
      >
        Update
      </button>
      <AeHint id="nudge.update" className="-my-0.5 ml-0" />
    </span>
  );
}

function distinct(labels: string[]): string[] {
  return labels.filter((label, i) => labels.indexOf(label) === i);
}

function changeText(updates: Pick<AeModelUpdate, "fromLabel" | "toLabel">[]): string {
  return updates.map((u) => `${u.fromLabel} to ${u.toLabel}`).join(", ");
}

/**
 * The count of newer models and Update all, then (after Update all) the batch
 * and its Undo all. It sits in the preset's header row, on the line of the name,
 * and wraps to its own line only on a narrow window. Always renders the polite
 * live region that announces each change.
 */
export function AeUpdateBanner({
  state,
  disabled,
}: {
  state: AeModelUpdatesState;
  disabled: boolean;
}) {
  const labels = distinct(state.pending.map((u) => u.toLabel));
  const batch = state.batch;
  const live = (
    <span role="status" aria-live="polite" className="sr-only">
      {state.announcement}
    </span>
  );
  if (labels.length === 0 && batch.length === 0) return live;
  const list = `${labels.length} newer ${labels.length === 1 ? "model" : "models"} for this preset: ${labels.join(", ")}`;
  const batchText = `Updated ${batch.length} ${batch.length === 1 ? "model" : "models"}: ${batch
    .map((entry) => `${entry.fromLabel} to ${entry.toLabel}`)
    .join(", ")}`;
  return (
    <div
      data-testid="ae-model-update-banner"
      className="flex min-w-[9rem] flex-1 basis-0 flex-col gap-0.5 text-xs"
    >
      {live}
      {labels.length > 0 && (
        <div className="flex min-w-0 items-center gap-2">
          <span title={list} className="min-w-0 truncate text-foreground">
            {list}
          </span>
          <span className="inline-flex shrink-0 items-center">
            <button
              type="button"
              data-testid="ae-model-update-all"
              disabled={disabled}
              aria-label={`Update all: ${changeText(state.pending)}`}
              title={changeText(state.pending)}
              onClick={state.updateAll}
              className={ACTION}
            >
              Update all
            </button>
            <AeHint id="nudge.update_all" />
          </span>
        </div>
      )}
      {batch.length > 0 && (
        <div data-testid="ae-model-update-batch" className="flex min-w-0 items-center gap-2">
          <span title={batchText} className="min-w-0 truncate text-foreground">
            {batchText}
          </span>
          <button
            type="button"
            data-testid="ae-model-undo-all"
            disabled={disabled}
            onClick={state.undoAll}
            className={ACTION}
          >
            Undo all
          </button>
        </div>
      )}
    </div>
  );
}
