// Role presets (omnigent-ae, 2026-10-23): named, saved mixes of the five-role
// table (Lead, Planner, Reviewer, Builder, Helper) and the model change rules.
// The server keeps them per user (`GET` and `PUT /v1/ae/roles`, see
// packages/ae_omni_policies role_prefs.py in omnigent-ae); this file holds the
// shapes, the parser for the server's answer and the pure edits Settings >
// Roles makes before it saves the whole list.

import { aeClaudeVersion, aeClaudeVersionLabel } from "@/lib/aeClaudeModels";
import { comparableModelId } from "@/lib/codexNativeModels";

export const AE_ROLE_IDS = ["lead", "planner", "reviewer", "builder", "helper"] as const;
export type AeRoleId = (typeof AE_ROLE_IDS)[number];

export const AE_ROLE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AeRoleEffort = (typeof AE_ROLE_EFFORTS)[number];

export const AE_ROLE_COLORS = [
  "green",
  "teal",
  "blue",
  "violet",
  "amber",
  "red",
  "pink",
  "slate",
] as const;
export type AeRoleColor = (typeof AE_ROLE_COLORS)[number];

export const AE_RAISE_MODES = ["off", "tell", "ask"] as const;
export type AeRaiseMode = (typeof AE_RAISE_MODES)[number];

/** The per-session choice that lets the lead pick among presets; never a preset's id. */
export const AE_RESERVED_PRESET_ID = "lead-picks";

/**
 * Text the server accepts in a title, description or when-to-use note: one
 * line, no control characters (a newline becomes a space).
 */
export function aeOneLine(text: string): string {
  const isBreak = (code: number) =>
    code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
  const spaced = Array.from(text, (ch) => (isBreak(ch.charCodeAt(0)) ? " " : ch)).join("");
  return spaced.replace(/ {2,}/g, " ").trim();
}

/** The title and description SettingsPage's `Section` shell gives Settings > Roles. */
export const AE_ROLES_SETTINGS = {
  title: "Roles",
  description: "Which model and effort each kind of work runs on, saved as presets.",
};

/** Most presets one user keeps; the server refuses more. */
export const AE_PRESET_LIMIT = 30;
/** The list view shows a search box past this many presets. */
export const AE_PRESET_SEARCH_FROM = 8;
/** Alt 1 to Alt 9 follow list order (the key binding is not wired yet). */
export const AE_PRESET_SHORTCUTS = 9;
export const AE_AUTO_RAISES_MAX = 3;
export const AE_PRESET_TITLE_MAX = 40;
export const AE_PRESET_DESCRIPTION_MAX = 120;
export const AE_PRESET_WHEN_MAX = 400;

export type AeRoleSetting =
  { mode: "auto" } | { mode: "session" } | { mode: "fixed"; model: string; effort: AeRoleEffort };

export type AeRoleTable = Record<AeRoleId, AeRoleSetting>;

export interface AeRoleRules {
  raise_or_lower: AeRaiseMode;
  lead_steps_down: boolean;
  auto_raises: number;
}

export interface AeRolePreset {
  id: string;
  title: string;
  icon: string;
  color: AeRoleColor;
  description: string;
  when_to_use: string;
  pinned: boolean;
  roles: AeRoleTable;
  rules: AeRoleRules;
}

/** What `PUT /v1/ae/roles` takes. */
export interface AeRolesDoc {
  revision: number;
  default_preset: string;
  apply_start_on: boolean;
  presets: AeRolePreset[];
}

/** What `GET` and `PUT /v1/ae/roles` answer. */
export interface AeRolesState extends AeRolesDoc {
  starters: AeRolePreset[];
}

export const AE_ROLE_LABELS: Record<AeRoleId, { label: string; hint: string }> = {
  lead: { label: "Lead", hint: "orchestrates" },
  planner: { label: "Planner", hint: "design, root cause" },
  reviewer: { label: "Reviewer", hint: "review, verify" },
  builder: { label: "Builder", hint: "writes code" },
  helper: { label: "Helper", hint: "watch, poll, commit" },
};

/** Tile classes per preset color: a tinted box with the icon in the color. */
export const AE_ROLE_COLOR_CLASSES: Record<AeRoleColor, { tile: string; swatch: string }> = {
  green: { tile: "bg-emerald-500/15 text-emerald-500", swatch: "bg-emerald-500" },
  teal: { tile: "bg-teal-500/15 text-teal-500", swatch: "bg-teal-500" },
  blue: { tile: "bg-blue-500/15 text-blue-500", swatch: "bg-blue-500" },
  violet: { tile: "bg-violet-500/15 text-violet-500", swatch: "bg-violet-500" },
  amber: { tile: "bg-amber-500/15 text-amber-500", swatch: "bg-amber-500" },
  red: { tile: "bg-red-500/15 text-red-500", swatch: "bg-red-500" },
  pink: { tile: "bg-pink-500/15 text-pink-500", swatch: "bg-pink-500" },
  slate: { tile: "bg-slate-500/15 text-slate-400", swatch: "bg-slate-400" },
};

/** The dot beside a model name, by Claude family. */
const FAMILY_DOTS: Record<string, string> = {
  fable: "bg-violet-400",
  opus: "bg-amber-400",
  sonnet: "bg-blue-400",
  haiku: "bg-emerald-400",
};

export function aeModelDotClass(model: string): string {
  const family = aeClaudeVersion(model)?.family;
  return (family && FAMILY_DOTS[family]) || "bg-muted-foreground";
}

/** "claude-opus-5-5" -> "Opus 5.5"; an id it cannot read stays as is. */
export function aeModelLabel(model: string): string {
  return aeClaudeVersionLabel(model) ?? model;
}

// ---------------------------------------------------------------------------
// Parsing the server's answer

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseSetting(value: unknown): AeRoleSetting | null {
  if (!isObject(value)) return null;
  if (value.mode === "auto") return { mode: "auto" };
  if (value.mode === "session") return { mode: "session" };
  if (
    value.mode === "fixed" &&
    typeof value.model === "string" &&
    value.model &&
    (AE_ROLE_EFFORTS as readonly unknown[]).includes(value.effort)
  ) {
    return { mode: "fixed", model: value.model, effort: value.effort as AeRoleEffort };
  }
  return null;
}

function parsePreset(value: unknown): AeRolePreset | null {
  if (!isObject(value)) return null;
  const { id, title, icon, color, description, when_to_use, pinned, roles, rules } = value;
  if (typeof id !== "string" || typeof title !== "string" || typeof icon !== "string") return null;
  if (!(AE_ROLE_COLORS as readonly unknown[]).includes(color)) return null;
  if (!isObject(roles) || !isObject(rules)) return null;
  const table = {} as AeRoleTable;
  for (const role of AE_ROLE_IDS) {
    const setting = parseSetting(roles[role]);
    if (!setting) return null;
    table[role] = setting;
  }
  const { raise_or_lower, lead_steps_down, auto_raises } = rules;
  if (!(AE_RAISE_MODES as readonly unknown[]).includes(raise_or_lower)) return null;
  if (typeof lead_steps_down !== "boolean" || typeof auto_raises !== "number") return null;
  return {
    id,
    title,
    icon,
    color: color as AeRoleColor,
    description: typeof description === "string" ? description : "",
    when_to_use: typeof when_to_use === "string" ? when_to_use : "",
    pinned: pinned === true,
    roles: table,
    rules: {
      raise_or_lower: raise_or_lower as AeRaiseMode,
      lead_steps_down,
      auto_raises: Math.max(0, Math.min(AE_AUTO_RAISES_MAX, Math.round(auto_raises))),
    },
  };
}

function parsePresets(value: unknown): AeRolePreset[] | null {
  if (!Array.isArray(value)) return null;
  const presets = value.map(parsePreset);
  return presets.every((preset): preset is AeRolePreset => preset !== null) ? presets : null;
}

/** The server's roles state, or null when the body is not one. */
export function aeParseRolesState(value: unknown): AeRolesState | null {
  if (!isObject(value)) return null;
  const { revision, default_preset, apply_start_on, presets, starters } = value;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return null;
  if (typeof default_preset !== "string") return null;
  const list = parsePresets(presets);
  if (!list) return null;
  return {
    revision,
    default_preset,
    apply_start_on: apply_start_on !== false,
    presets: list,
    starters: parsePresets(starters) ?? [],
  };
}

/** The body a PUT sends: the state without the server-owned starters. */
export function aeRolesDoc(state: AeRolesDoc): AeRolesDoc {
  return {
    revision: state.revision,
    default_preset: state.default_preset,
    apply_start_on: state.apply_start_on,
    presets: state.presets,
  };
}

// ---------------------------------------------------------------------------
// Edits (each returns a new doc; the caller saves it)

/** A slug for `title` that no preset in `taken` uses: "Deep debug" -> "deep-debug", then "deep-debug-2". */
export function aePresetId(title: string, inUse: readonly string[]): string {
  const taken = [...inUse, AE_RESERVED_PRESET_ID];
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "preset";
  const start = SLUG.test(base) ? base : `p-${base}`.slice(0, 32);
  if (!taken.includes(start)) return start;
  for (let n = 2; ; n += 1) {
    const candidate = `${start}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Move the preset `id` to `index` in the list (the user's order). */
export function aeMovePreset<T extends AeRolesDoc>(doc: T, id: string, index: number): T {
  const from = doc.presets.findIndex((preset) => preset.id === id);
  if (from < 0) return doc;
  const to = Math.max(0, Math.min(doc.presets.length - 1, index));
  if (from === to) return doc;
  const presets = [...doc.presets];
  const [moved] = presets.splice(from, 1);
  presets.splice(to, 0, moved);
  return { ...doc, presets };
}

export function aeReplacePreset<T extends AeRolesDoc>(doc: T, next: AeRolePreset): T {
  return { ...doc, presets: doc.presets.map((preset) => (preset.id === next.id ? next : preset)) };
}

/**
 * Remove a preset. Deleting the default makes the first remaining preset the
 * default; the last preset cannot be deleted (the server needs at least one).
 */
export function aeDeletePreset<T extends AeRolesDoc>(doc: T, id: string): T {
  const presets = doc.presets.filter((preset) => preset.id !== id);
  if (presets.length === 0 || presets.length === doc.presets.length) return doc;
  const default_preset =
    doc.default_preset === id || !presets.some((p) => p.id === doc.default_preset)
      ? presets[0].id
      : doc.default_preset;
  return { ...doc, presets, default_preset };
}

/** A copy of `source` placed right after it, titled "<title> copy". */
export function aeDuplicatePreset<T extends AeRolesDoc>(
  doc: T,
  source: AeRolePreset,
): { doc: T; id: string } {
  const suffix = " copy";
  const room = AE_PRESET_TITLE_MAX - Array.from(suffix).length;
  const title = `${Array.from(source.title).slice(0, room).join("")}${suffix}`;
  const id = aePresetId(
    title,
    doc.presets.map((p) => p.id),
  );
  const copy: AeRolePreset = { ...structuredCopy(source), id, title, pinned: false };
  const at = doc.presets.findIndex((p) => p.id === source.id);
  const presets = [...doc.presets];
  presets.splice(at < 0 ? presets.length : at + 1, 0, copy);
  return { doc: { ...doc, presets }, id };
}

/** Starters whose id the list no longer has, appended at its end. */
export function aeRestoreStarters<T extends AeRolesDoc>(
  doc: T,
  starters: readonly AeRolePreset[],
): { doc: T; added: AeRolePreset[] } {
  const ids = new Set(doc.presets.map((p) => p.id));
  const room = AE_PRESET_LIMIT - doc.presets.length;
  const added = starters.filter((s) => !ids.has(s.id)).slice(0, Math.max(0, room));
  if (added.length === 0) return { doc, added };
  return { doc: { ...doc, presets: [...doc.presets, ...added.map(structuredCopy)] }, added };
}

export function structuredCopy(preset: AeRolePreset): AeRolePreset {
  return {
    ...preset,
    roles: { ...preset.roles },
    rules: { ...preset.rules },
  };
}

export function aeSameRoles(
  a: { roles: AeRoleTable; rules: AeRoleRules },
  b: { roles: AeRoleTable; rules: AeRoleRules },
): boolean {
  return (
    JSON.stringify(AE_ROLE_IDS.map((r) => a.roles[r])) ===
      JSON.stringify(AE_ROLE_IDS.map((r) => b.roles[r])) &&
    a.rules.raise_or_lower === b.rules.raise_or_lower &&
    a.rules.lead_steps_down === b.rules.lead_steps_down &&
    a.rules.auto_raises === b.rules.auto_raises
  );
}

// ---------------------------------------------------------------------------
// Models

const FAMILY_RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };

function rankOf(model: string): [number, number, number] {
  const version = aeClaudeVersion(model);
  if (!version) return [0, 0, 0];
  return [FAMILY_RANK[version.family] ?? 0, version.major, version.minor];
}

/**
 * The top model among `models` (catalog ids): highest Claude family, then the
 * newest version. Null for an empty list. The catalog carries no cost tier, so
 * the family order stands in for it.
 */
export function aeTopModel(models: readonly string[]): string | null {
  let top: string | null = null;
  for (const model of models) {
    if (top === null) {
      top = model;
      continue;
    }
    const [a, b] = [rankOf(model), rankOf(top)];
    if ((a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) > 0) top = model;
  }
  return top;
}

/**
 * Every role fixed on the top model at max effort (YOLO style). `catalog` is
 * the host's model ids; with none loaded, the preset's own models stand in.
 */
export function aeIsTopTierEverywhere(roles: AeRoleTable, catalog: readonly string[]): boolean {
  const settings = AE_ROLE_IDS.map((role) => roles[role]);
  if (!settings.every((s) => s.mode === "fixed" && s.effort === "max")) return false;
  const models = settings.map((s) => (s.mode === "fixed" ? s.model : ""));
  const top = aeTopModel(catalog.length > 0 ? catalog : models);
  if (!top) return false;
  const target = comparableModelId(top);
  return models.every((m) => comparableModelId(m) === target);
}

/** One line for a preset's role mix: "Opus 5.5 plans, Sonnet 5.5 reviews, ...". */
export function aeRoleSummary(roles: AeRoleTable): string {
  const parts: string[] = [];
  for (const role of AE_ROLE_IDS) {
    const setting = roles[role];
    const value =
      setting.mode === "fixed"
        ? `${aeModelLabel(setting.model)} ${setting.effort}`
        : setting.mode === "session"
          ? "session model"
          : "auto";
    parts.push(`${AE_ROLE_LABELS[role].label} ${value}`);
  }
  return parts.join(" · ");
}

/**
 * Pinned presets first, each group in its saved order: the list view groups
 * them that way, and Alt 1 to Alt 9 follow the same order.
 */
export function aeNormalizeOrder<T extends AeRolesDoc>(doc: T): T {
  const pinned = doc.presets.filter((p) => p.pinned);
  const others = doc.presets.filter((p) => !p.pinned);
  const presets = [...pinned, ...others];
  return presets.every((p, i) => p === doc.presets[i]) ? doc : { ...doc, presets };
}

/** Pin or unpin a preset; it joins the end of the pinned group or the start of the others. */
export function aeSetPinned<T extends AeRolesDoc>(doc: T, id: string, pinned: boolean): T {
  const preset = doc.presets.find((p) => p.id === id);
  if (!preset || preset.pinned === pinned) return doc;
  const rest = doc.presets.filter((p) => p.id !== id);
  const pinnedCount = rest.filter((p) => p.pinned).length;
  const presets = [...rest];
  presets.splice(pinnedCount, 0, { ...preset, pinned });
  return aeNormalizeOrder({ ...doc, presets });
}

/** Drop `id` onto `overId`'s place; it takes the pinned state of the group it lands in. */
export function aeDropPreset<T extends AeRolesDoc>(doc: T, id: string, overId: string): T {
  const over = doc.presets.find((p) => p.id === overId);
  const moved = doc.presets.find((p) => p.id === id);
  if (!over || !moved || id === overId) return doc;
  const index = doc.presets.findIndex((p) => p.id === overId);
  const repinned =
    moved.pinned === over.pinned ? doc : aeReplacePreset(doc, { ...moved, pinned: over.pinned });
  return aeNormalizeOrder(aeMovePreset(repinned, id, index));
}
