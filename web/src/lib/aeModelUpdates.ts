// "A newer model" nudge for the preset editor (omnigent-ae, 2026-10-26). A row
// whose model has a newer version in the same family gets an Update chip; a
// click changes the model only. Nothing here applies anything by itself: the
// editor calls aeApplyUpdate on a click. Claude ids are read with
// aeClaudeVersion; Codex rows by family name and generation number.

import { aeClaudeVersion } from "@/lib/aeClaudeModels";
import {
  aeCodexDefaultEffort,
  aeCodexEfforts,
  aeCodexLabel,
  aeCodexRowName,
  aeCompareGeneration,
} from "@/lib/aeCodexModels";
import { type AeAgentEffort, aeModelLabel } from "@/lib/aeRoleBase";
import { type AeReviewerSlot, aeReviewerList, aeWriteReviewers } from "@/lib/aeReviewers";
import {
  AE_ROLE_IDS,
  AE_ROLE_LABELS,
  type AeRoleId,
  type AeRoleSetting,
  type AeRoleTable,
} from "@/lib/aeRoles";
import { findNativeModelOption } from "@/lib/codexNativeModels";
import type { NativeModelOption } from "@/lib/types";

export interface AeModelCatalogs {
  /** Claude ids the role table offers, e.g. `claude-opus-5-6`. */
  claude: readonly string[];
  /** The Codex host's model list; empty while it loads. */
  codex: readonly NativeModelOption[];
}

/** What a stored row holds: a role setting, or one reviewer slot. */
export type AeRowValue = AeRoleSetting | AeReviewerSlot;

export interface AeModelUpdate {
  /** `planner`, or `reviewer:1` for the second reviewer. */
  key: string;
  role: AeRoleId;
  /** The reviewer slot, or null for a role with one setting. */
  slot: number | null;
  fromModel: string;
  fromLabel: string;
  toModel: string;
  toLabel: string;
  /** The effort the row holds after the update; null leaves a Codex row on the model's default. */
  effort: AeAgentEffort | null;
  /** Set when the new model does not offer the row's effort: the default it falls back to. */
  effortFallback: AeAgentEffort | null;
  /** Said in the chip's hint when something the row had cannot carry over. */
  note: string | null;
}

export const AE_NO_CONTEXT_NOTE = "1M context variant not available";

/** "Planner", or "Reviewer 2" for the second reviewer slot. */
export function aeUpdateRowName(role: AeRoleId, slot: number | null): string {
  return role === "reviewer" && slot !== null && slot > 0
    ? `Reviewer ${slot + 1}`
    : AE_ROLE_LABELS[role].label;
}

const SUFFIX = /\[[^\]]*\]$/;

/**
 * The newest id of the same Claude family, when it is newer than `model`. A
 * context suffix ("[1m]") carries over only to an id the catalog lists with it;
 * otherwise the plain id comes back and `noContext` is true. No id is made up.
 */
export function aeNewerClaudeUpdate(
  model: string,
  catalog: readonly string[],
): { model: string; noContext: boolean } | null {
  const bare = model.trim().replace(SUFFIX, "");
  const suffix = SUFFIX.exec(model.trim())?.[0] ?? "";
  const version = aeClaudeVersion(bare);
  if (!version) return null;
  let best: { id: string; major: number; minor: number } | null = null;
  for (const id of catalog) {
    const other = aeClaudeVersion(id.replace(SUFFIX, ""));
    if (!other || other.family !== version.family) continue;
    const newer = !best || (other.major - best.major || other.minor - best.minor) > 0;
    if (newer) best = { id: id.replace(SUFFIX, ""), major: other.major, minor: other.minor };
  }
  if (!best || (best.major - version.major || best.minor - version.minor) <= 0) return null;
  // Only an id the catalog really lists is offered; a variant it lacks skips the row.
  if (suffix && catalog.includes(best.id + suffix))
    return { model: best.id + suffix, noContext: false };
  if (!catalog.includes(best.id)) return null;
  return { model: best.id, noContext: !!suffix };
}

/** {@link aeNewerClaudeUpdate}'s id alone. */
export function aeNewerClaudeModel(model: string, catalog: readonly string[]): string | null {
  return aeNewerClaudeUpdate(model, catalog)?.model ?? null;
}

/** The newest model of the same Codex family, when newer than the stored one; null when the stored one is not listed. */
export function aeNewerCodexModel(
  model: string | null,
  rows: readonly NativeModelOption[],
): NativeModelOption | null {
  const current = model ? findNativeModelOption(rows, model) : null;
  const name = current ? aeCodexRowName(current) : null;
  if (!name) return null;
  let best: { row: NativeModelOption; generation: number[] } | null = null;
  for (const row of rows) {
    const other = aeCodexRowName(row);
    if (!other || other.family !== name.family) continue;
    if (!best || aeCompareGeneration(other.generation, best.generation) > 0)
      best = { row, generation: other.generation };
  }
  return best && aeCompareGeneration(best.generation, name.generation) > 0 ? best.row : null;
}

function updateOf(
  key: string,
  role: AeRoleId,
  slot: number | null,
  value: AeRowValue,
  catalogs: AeModelCatalogs,
): AeModelUpdate | null {
  if (value.mode === "fixed") {
    const found = aeNewerClaudeUpdate(value.model, catalogs.claude);
    if (!found) return null;
    const toModel = found.model;
    return {
      key,
      role,
      slot,
      fromModel: value.model,
      fromLabel: aeModelLabel(value.model),
      toModel,
      toLabel: aeModelLabel(toModel),
      effort: value.effort,
      effortFallback: null,
      note: found.noContext ? AE_NO_CONTEXT_NOTE : null,
    };
  }
  if (value.mode === "agent" && value.model) {
    const next = aeNewerCodexModel(value.model, catalogs.codex);
    if (!next) return null;
    const from = findNativeModelOption(catalogs.codex, value.model);
    const offered = aeCodexEfforts(next);
    const keeps = !value.effort || offered.length === 0 || offered.includes(value.effort);
    const fallback = keeps ? null : aeCodexDefaultEffort(next);
    return {
      key,
      role,
      slot,
      fromModel: value.model,
      fromLabel: from ? aeCodexLabel(from) : value.model,
      toModel: next.model ?? next.id,
      toLabel: aeCodexLabel(next),
      effort: fallback ?? value.effort,
      effortFallback: fallback,
      note: null,
    };
  }
  return null;
}

/** The row at `key`, or null when the preset has none there. */
export function aeRowAt(roles: AeRoleTable, key: string): AeRowValue | null {
  const [role, index] = key.split(":");
  if (role === "reviewer") return aeReviewerList(roles.reviewer)[Number(index ?? 0)] ?? null;
  return (AE_ROLE_IDS as readonly string[]).includes(role)
    ? roles[role as Exclude<AeRoleId, "reviewer">]
    : null;
}

/** `roles` with the row at `key` replaced. */
export function aeWithRow(roles: AeRoleTable, key: string, value: AeRowValue): AeRoleTable {
  const [role, index] = key.split(":");
  if (role === "reviewer") {
    const slots = aeReviewerList(roles.reviewer);
    const at = Number(index ?? 0);
    if (!slots[at]) return roles;
    return {
      ...roles,
      reviewer: aeWriteReviewers(slots.map((s, i) => (i === at ? (value as AeReviewerSlot) : s))),
    };
  }
  if (!(AE_ROLE_IDS as readonly string[]).includes(role)) return roles;
  return { ...roles, [role]: value as AeRoleSetting };
}

/** Every row whose model has a newer version in its family. Auto, Session and unparseable rows give none. */
export function aeModelUpdates(roles: AeRoleTable, catalogs: AeModelCatalogs): AeModelUpdate[] {
  const found: AeModelUpdate[] = [];
  for (const role of AE_ROLE_IDS) {
    if (role === "reviewer") {
      aeReviewerList(roles.reviewer).forEach((slot, i) => {
        const update = updateOf(`reviewer:${i}`, role, i, slot, catalogs);
        if (update) found.push(update);
      });
      continue;
    }
    const update = updateOf(role, role, null, roles[role], catalogs);
    if (update) found.push(update);
  }
  return found;
}

/** The row after the update: model and, only if the new model lacks it, the effort. */
export function aeUpdatedRow(row: AeRowValue, update: AeModelUpdate): AeRowValue {
  if (row.mode === "fixed") return { ...row, model: update.toModel };
  if (row.mode === "agent") return { ...row, model: update.toModel, effort: update.effort };
  return row;
}

/** Applies one update; a row that no longer holds the model it was found with is left alone. */
export function aeApplyUpdate(roles: AeRoleTable, update: AeModelUpdate): AeRoleTable {
  const row = aeRowAt(roles, update.key);
  if (!row || (row.mode !== "fixed" && row.mode !== "agent") || row.model !== update.fromModel)
    return roles;
  return aeWithRow(roles, update.key, aeUpdatedRow(row, update));
}
