// START ON lines (omnigent-ae, 2026-10-23): a handoff packet ends with a line
// such as `START ON: preset "Balanced"`, `START ON: preset "Deep debug", with
// one change` or `START ON: no preset, Sonnet 5.5 medium solo`. On a session's
// first message the composer reads it and sets the preset, or the model and
// effort, before the first turn. This file only parses; a line it cannot read
// returns null and the message goes out unchanged.

import {
  AE_RESERVED_PRESET_ID,
  AE_ROLE_EFFORTS,
  type AeRoleEffort,
  type AeRolePreset,
  aeModelLabel,
} from "@/lib/aeRoles";
import type { NativeModelOption } from "@/lib/types";

export type AeStartOnTarget =
  | { kind: "preset"; presetId: string; label: string }
  | { kind: "model"; model: string; label: string; effort: AeRoleEffort | null };

/** The text after the first `START ON:` line's colon, without markdown, or null. */
export function aeStartOnLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^[\s>*_`#-]*start on\s*[*_`]*\s*:\s*(.*)$/i.exec(line);
    if (match) return match[1].replace(/[*_`]/g, "").trim();
  }
  return null;
}

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

function findPreset(phrase: string, presets: readonly AeRolePreset[]): AeStartOnTarget | null {
  const key = squash(phrase);
  if (!key) return null;
  if (key === squash(AE_RESERVED_PRESET_ID)) {
    return { kind: "preset", presetId: AE_RESERVED_PRESET_ID, label: "Lead picks" };
  }
  const preset = presets.find((p) => squash(p.title) === key || squash(p.id) === key);
  return preset ? { kind: "preset", presetId: preset.id, label: preset.title } : null;
}

function modelKeys(option: NativeModelOption): string[] {
  const keys = [option.id, option.model ?? "", option.displayName ?? ""];
  keys.push(aeModelLabel(option.model ?? option.id));
  return keys
    .map((k) => squash(k.replace(/\[[^\]]*\]$/, "")))
    .flatMap((k) => (k.startsWith("claude") ? [k, k.slice(6)] : [k]))
    .filter(Boolean);
}

function findModel(phrase: string, models: readonly NativeModelOption[]): NativeModelOption | null {
  const key = squash(phrase).replace(/^claude/, "");
  if (!key) return null;
  return models.find((m) => modelKeys(m).includes(key)) ?? null;
}

const FILLER = new Set([
  "no",
  "preset",
  "effort",
  "solo",
  "team",
  "on",
  "at",
  "with",
  "and",
  "use",
]);

/**
 * What a message's START ON line asks for, matched against the user's presets
 * and the session's model options; null when there is no line or it names
 * nothing known. A preset plus rows that differ applies the preset only.
 */
export function aeParseStartOn(
  text: string,
  presets: readonly AeRolePreset[],
  models: readonly NativeModelOption[],
): AeStartOnTarget | null {
  const rest = aeStartOnLine(text);
  if (!rest) return null;
  const quoted = /["“”'‘’]([^"“”'‘’]+)["“”'‘’]/.exec(rest)?.[1];
  const head = rest
    .split(/,|\(|\s+with\s+|\s+plus\s+|\s+and\s+/i)[0]
    .replace(/^\s*(the\s+)?preset\s*:?\s*/i, "")
    .trim();
  for (const phrase of [quoted, head, rest]) {
    const found = phrase ? findPreset(phrase, presets) : null;
    if (found) return found;
  }
  const words = rest
    .toLowerCase()
    .split(/[\s,;()]+/)
    .filter(Boolean);
  const effort =
    (words.find((w) => (AE_ROLE_EFFORTS as readonly string[]).includes(w)) as
      AeRoleEffort | undefined) ?? null;
  const modelWords = words.filter(
    (w) => !FILLER.has(w) && !(AE_ROLE_EFFORTS as readonly string[]).includes(w),
  );
  // Longest run of words first: "opus 5.5" before "opus".
  for (let start = 0; start < modelWords.length; start += 1) {
    for (let end = Math.min(modelWords.length, start + 4); end > start; end -= 1) {
      const option = findModel(modelWords.slice(start, end).join(" "), models);
      if (option) {
        const name = option.displayName ?? aeModelLabel(option.model ?? option.id);
        return {
          kind: "model",
          model: option.id,
          effort,
          label: effort ? `${name} ${effort}` : name,
        };
      }
    }
  }
  return null;
}
