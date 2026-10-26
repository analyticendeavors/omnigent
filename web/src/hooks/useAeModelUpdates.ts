// The update nudge's state for one open preset (omnigent-ae, 2026-10-26): which
// rows have a newer model, and which the user just updated, so each can be
// undone. It never changes a preset on its own; every change starts with a call
// from a click, and goes through the editor's own onRoles like any other edit.
//
// Undo puts the model back, and the effort only if it is still the one Update
// left, so an edit made in between stays. A reviewer slot has no id of its own,
// so when a slot is removed the records follow the slots that remain by object
// identity, and a record whose slot is gone is dropped.

import { useMemo, useState } from "react";
import {
  type AeModelUpdate,
  type AeRowValue,
  aeApplyUpdate,
  aeModelUpdates,
  aeRowAt,
  aeUpdateRowName,
  aeWithRow,
} from "@/lib/aeModelUpdates";
import type { AeAgentEffort } from "@/lib/aeRoleBase";
import { aeReviewerList } from "@/lib/aeReviewers";
import type { AeRoleTable } from "@/lib/aeRoles";
import type { NativeModelOption } from "@/lib/types";

export interface AeUpdated {
  key: string;
  /** The row as it was before Update. */
  before: AeRowValue;
  /** The effort Update left on the row. */
  afterEffort: AeAgentEffort | null;
  name: string;
  fromLabel: string;
  toLabel: string;
  toModel: string;
  /** Set when the new model did not offer the row's effort and it moved to this default. */
  effortFallback: AeAgentEffort | null;
  /** Updated by Update all, so one Undo all reverts the batch. */
  batch: boolean;
}

export interface AeModelUpdatesState {
  /** Rows with a newer model, not yet updated. */
  pending: AeModelUpdate[];
  /** Rows updated and still on that model, by key. */
  updated: ReadonlyMap<string, AeUpdated>;
  /** The rows the last Update all changed and Undo all would revert. */
  batch: AeUpdated[];
  /** The row whose chip takes keyboard focus after a click. */
  focusKey: string | null;
  /** A sentence for a polite live region. */
  announcement: string;
  update: (key: string) => void;
  updateAll: () => void;
  undo: (key: string) => void;
  undoAll: () => void;
}

const effortOf = (row: AeRowValue | null) =>
  row && (row.mode === "fixed" || row.mode === "agent") ? row.effort : null;

/** `current` with the model put back, and the effort too only if Update's effort is still there. */
function undone(current: AeRowValue, entry: AeUpdated): AeRowValue {
  const before = entry.before;
  if (
    (current.mode !== "fixed" && current.mode !== "agent") ||
    (before.mode !== "fixed" && before.mode !== "agent")
  )
    return current;
  const keepsEffort = effortOf(current) === entry.afterEffort;
  const effort = keepsEffort ? effortOf(before) : effortOf(current);
  return { ...current, model: before.model, effort } as AeRowValue;
}

interface Record_ {
  presetId: string;
  roles: AeRoleTable;
  done: Record<string, AeUpdated>;
}

export function useAeModelUpdates(
  presetId: string,
  roles: AeRoleTable,
  claude: readonly string[],
  codex: readonly NativeModelOption[],
  onRoles: (roles: AeRoleTable) => void,
): AeModelUpdatesState {
  const [record, setRecord] = useState<Record_>({ presetId, roles, done: {} });
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // Follow the slots when one is removed: same object, new place; a removed slot's record goes.
  if (record.presetId !== presetId || record.roles !== roles) {
    let done = record.presetId === presetId ? record.done : {};
    const was = aeReviewerList(record.roles.reviewer);
    const now = aeReviewerList(roles.reviewer);
    if (record.presetId === presetId && now.length < was.length) {
      done = Object.fromEntries(
        Object.entries(done).flatMap(([key, entry]) => {
          if (!key.startsWith("reviewer:")) return [[key, entry]];
          const at = now.indexOf(was[Number(key.slice(9))]);
          return at < 0 ? [] : [[`reviewer:${at}`, { ...entry, key: `reviewer:${at}` }]];
        }),
      );
    }
    setRecord({ presetId, roles, done });
  }
  const done = useMemo(() => (record.presetId === presetId ? record.done : {}), [record, presetId]);
  const pending = useMemo(() => aeModelUpdates(roles, { claude, codex }), [roles, claude, codex]);
  // An update stays "updated" only while its row still holds the model it moved to.
  const updated = useMemo(() => {
    const live = new Map<string, AeUpdated>();
    for (const [key, entry] of Object.entries(done)) {
      const row = aeRowAt(roles, key);
      if ((row?.mode === "fixed" || row?.mode === "agent") && row.model === entry.toModel)
        live.set(key, entry);
    }
    return live;
  }, [done, roles]);
  const keep = (entries: AeUpdated[]) =>
    setRecord((current) => ({
      ...current,
      done: { ...current.done, ...Object.fromEntries(entries.map((e) => [e.key, e])) },
    }));
  const apply = (updates: AeModelUpdate[], batch: boolean) => {
    let next = roles;
    const entries: AeUpdated[] = [];
    for (const update of updates) {
      const before = aeRowAt(next, update.key);
      const after = aeApplyUpdate(next, update);
      if (!before || after === next) continue;
      next = after;
      entries.push({
        key: update.key,
        before,
        afterEffort: effortOf(aeRowAt(next, update.key)),
        name: aeUpdateRowName(update.role, update.slot),
        fromLabel: update.fromLabel,
        toLabel: update.toLabel,
        toModel: update.toModel,
        effortFallback: update.effortFallback,
        batch,
      });
    }
    if (entries.length === 0) return;
    keep(entries);
    onRoles(next);
    setFocusKey(entries[0].key);
    setAnnouncement(
      entries.length === 1
        ? `${entries[0].name} updated to ${entries[0].toLabel}`
        : `${entries.length} models updated`,
    );
  };
  const revert = (entries: AeUpdated[]) => {
    let next = roles;
    for (const entry of entries) {
      const current = aeRowAt(next, entry.key);
      if (current) next = aeWithRow(next, entry.key, undone(current, entry));
    }
    onRoles(next);
    const gone = entries.map((e) => e.key);
    setRecord((current) => ({
      ...current,
      done: Object.fromEntries(Object.entries(current.done).filter(([k]) => !gone.includes(k))),
    }));
    setFocusKey(entries[0]?.key ?? null);
    setAnnouncement(
      entries.length === 1
        ? `${entries[0].name} restored to ${entries[0].fromLabel}`
        : `${entries.length} models restored`,
    );
  };
  return {
    pending,
    updated,
    batch: [...updated.values()].filter((entry) => entry.batch),
    focusKey,
    announcement,
    update: (key) =>
      apply(
        pending.filter((u) => u.key === key),
        false,
      ),
    updateAll: () => apply(pending, true),
    undo: (key) => {
      const entry = updated.get(key);
      if (entry) revert([entry]);
    },
    undoAll: () => revert([...updated.values()].filter((entry) => entry.batch)),
  };
}
