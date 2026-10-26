// Role presets (omnigent-ae, 2026-10-23): named, saved mixes of the five-role
// table (Lead, Planner, Reviewer, Builder, Helper) and the model change rules.
// The server keeps them per user (`GET` and `PUT /v1/ae/roles`, see
// packages/ae_omni_policies role_prefs.py in omnigent-ae); this file holds the
// shapes, the parser for the server's answer and the pure edits Settings >
// Roles makes before it saves the whole list.

import { aeClaudeVersion } from "@/lib/aeClaudeModels";
import {
  AE_ROLE_EFFORTS,
  type AeRoleEffort,
  type AeRoleSetting,
  aeModelLabel,
} from "@/lib/aeRoleBase";
import {
  type AeReviewerSetting,
  type AeReviewerUnavailable,
  type AeReviewMerge,
  aeParseReviewerMulti,
  aeReviewerList,
  aeReviewerRowLabel,
  aeReviewerSummary,
  aeReviewerUnavailableOf,
  aeReviewMergeOf,
} from "@/lib/aeReviewers";
import { comparableModelId } from "@/lib/codexNativeModels";

export const AE_ROLE_IDS = ["lead", "planner", "reviewer", "builder", "helper"] as const;
export type AeRoleId = (typeof AE_ROLE_IDS)[number];

export { AE_ROLE_EFFORTS, aeModelLabel };
export type { AeRoleEffort, AeRoleSetting };

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

/**
 * Helpers rule (2026-10-23, when Auto / Solo / Team folded into presets): "any"
 * lets the lead bring in other agents and sessions, "own" keeps work with the
 * lead and its native subagents. Missing on presets saved before it: "any".
 */
export const AE_HELPERS = ["any", "own"] as const;
export type AeHelpers = (typeof AE_HELPERS)[number];
export const AE_HELPERS_LABELS: Record<AeHelpers, { label: string; hint: string }> = {
  any: { label: "Any agent or session", hint: "The lead may bring in other agents" },
  own: { label: "Own subagents only", hint: "No other agents or sessions" },
};
/**
 * Tag on the model change rules (2026-10-24): nothing acts on them until the
 * lead gets a tool to change models, so Settings says so.
 */
export const AE_COMING_LATER = {
  label: "Coming later",
  hint: "The lead does not change models on its own yet.",
} as const;
/** The Helpers choices as a segmented control takes them. */
export const AE_HELPERS_OPTIONS = AE_HELPERS.map((value) => ({
  value,
  label: AE_HELPERS_LABELS[value].label,
}));
/** The Helpers rule of a preset or customization; absent reads as "any". */
export function aeHelpersOf(rules: { helpers?: AeHelpers } | undefined): AeHelpers {
  return rules?.helpers === "own" ? "own" : "any";
}

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
/** Alt 1 to Alt 9 in the composer pick presets in list order. */
export const AE_PRESET_SHORTCUTS = 9;
export const AE_AUTO_RAISES_MAX = 3;
export const AE_PRESET_TITLE_MAX = 40;
export const AE_PRESET_DESCRIPTION_MAX = 120;
export const AE_PRESET_WHEN_MAX = 400;

/** The Reviewer role may hold one to three reviewers (aeReviewers.ts). */
export type AeRoleTable = {
  [K in AeRoleId]: K extends "reviewer" ? AeReviewerSetting : AeRoleSetting;
};

export interface AeRoleRules {
  raise_or_lower: AeRaiseMode;
  lead_steps_down: boolean;
  auto_raises: number;
  /** Absent on presets saved before the rule existed; read it with `aeHelpersOf`. */
  helpers?: AeHelpers;
  /** With two or more reviewers; absent reads as "merged" (aeReviewMergeOf). */
  review_merge?: AeReviewMerge;
  /** With two or more reviewers; absent reads as "run_rest" (aeReviewerUnavailableOf). */
  reviewer_unavailable?: AeReviewerUnavailable;
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

/** The user's preset-insights setting (AePresetInsightsBlock); every other save sends it back unchanged. */
export interface AeInsights {
  enabled: boolean;
  weeks: number;
  scope: "all" | "own";
  /** What the Admin Center Presets card shows this user; absent means both. */
  show?: AeInsightsShow;
  /** How often the scheduled review runs; absent means every 2 weeks. */
  frequency?: AeInsightsFrequency;
}

export type AeInsightsShow = "cost" | "tokens" | "both";

export type AeInsightsFrequency = "weekly" | "biweekly" | "monthly";

/** The review frequency choices, in display order. */
export const AE_INSIGHTS_FREQUENCIES: [AeInsightsFrequency, string][] = [
  ["weekly", "Weekly"],
  ["biweekly", "Every 2 weeks"],
  ["monthly", "Monthly"],
];

export const AE_INSIGHTS_FREQUENCY_DEFAULT: AeInsightsFrequency = "biweekly";

function parseInsights(value: unknown): AeInsights | null {
  if (!isObject(value)) return null;
  const { enabled, weeks, scope, show, frequency } = value;
  if (typeof enabled !== "boolean" || typeof weeks !== "number") return null;
  if (scope !== "all" && scope !== "own") return null;
  const out: AeInsights = { enabled, weeks, scope };
  if (show === "cost" || show === "tokens" || show === "both") out.show = show;
  if (frequency === "weekly" || frequency === "biweekly" || frequency === "monthly") {
    out.frequency = frequency;
  }
  return out;
}

/** `state` with its insights setting replaced, for the Preset insights block's save. */
export function aeWithInsights(state: AeRolesDoc, insights: AeInsights): AeRolesDoc {
  return aeRolesDoc({ ...state, insights });
}

/** What `PUT /v1/ae/roles` takes. */
export interface AeRolesDoc {
  revision: number;
  default_preset: string;
  apply_start_on: boolean;
  presets: AeRolePreset[];
  /** Starter ids the read offered; a save sends them back so the server knows what this client saw. */
  starters_seen?: string[];
  /** Absent until the user sets it. */
  insights?: AeInsights;
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
    if (role === "reviewer") {
      // Only the lead may use the session model (the server refuses it here), so a
      // stored session reviewer is not a preset this client reads or rewrites as Auto.
      const plain = parseSetting(roles.reviewer);
      const setting =
        plain?.mode === "session" ? null : (plain ?? aeParseReviewerMulti(roles.reviewer));
      if (!setting) return null;
      table.reviewer = setting;
      continue;
    }
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
      // Kept only when stored, so a preset saved before the rule round-trips unchanged.
      ...(rules.helpers === "own" || rules.helpers === "any" ? { helpers: rules.helpers } : {}),
      ...(rules.review_merge === "merged" || rules.review_merge === "separate"
        ? { review_merge: rules.review_merge }
        : {}),
      ...(rules.reviewer_unavailable === "run_rest" || rules.reviewer_unavailable === "ask"
        ? { reviewer_unavailable: rules.reviewer_unavailable }
        : {}),
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
  const { revision, default_preset, apply_start_on, presets, starters, starters_seen, insights } =
    value;
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
    ...(Array.isArray(starters_seen) && starters_seen.every((id) => typeof id === "string")
      ? { starters_seen: starters_seen as string[] }
      : {}),
    ...(parseInsights(insights) ? { insights: parseInsights(insights) as AeInsights } : {}),
  };
}

/** The body a PUT sends: the state without the server-owned starters. */
export function aeRolesDoc(state: AeRolesDoc): AeRolesDoc {
  return {
    revision: state.revision,
    default_preset: state.default_preset,
    apply_start_on: state.apply_start_on,
    presets: state.presets,
    ...(state.starters_seen ? { starters_seen: state.starters_seen } : {}),
    ...(state.insights ? { insights: state.insights } : {}),
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
  const { reviewer } = preset.roles;
  return {
    ...preset,
    roles: {
      ...preset.roles,
      reviewer:
        reviewer.mode === "multi"
          ? { mode: "multi", reviewers: reviewer.reviewers.map((slot) => ({ ...slot })) }
          : reviewer,
    },
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
    a.rules.auto_raises === b.rules.auto_raises &&
    aeHelpersOf(a.rules) === aeHelpersOf(b.rules) &&
    aeReviewMergeOf(a.rules) === aeReviewMergeOf(b.rules) &&
    aeReviewerUnavailableOf(a.rules) === aeReviewerUnavailableOf(b.rules)
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
  // Agent reviewers run on another provider's models, so only Claude slots count.
  const settings = AE_ROLE_IDS.flatMap((role): (AeRoleSetting | { mode: "agent" })[] =>
    role === "reviewer" ? aeReviewerList(roles.reviewer) : [roles[role]],
  ).filter((s) => s.mode !== "agent");
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
    if (role === "reviewer") {
      parts.push(`${aeReviewerRowLabel(roles.reviewer)} ${aeReviewerSummary(roles.reviewer)}`);
      continue;
    }
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

// ---------------------------------------------------------------------------
// Settings > Roles' collapsed row

/** Width of one icon chip in the collapsed row plus the gap after it, in px. */
export const AE_ROW_ICON_PX = 34;
/** Width of the "+N" button plus its gap, in px. */
export const AE_ROW_MORE_PX = 42;

/**
 * The collapsed row's order: the open preset, then the default, then pinned
 * presets, then the rest in list order.
 */
export function aeRowOrder(
  presets: readonly AeRolePreset[],
  openId: string,
  defaultId: string,
): AeRolePreset[] {
  const rank = (p: AeRolePreset) =>
    p.id === openId ? 0 : p.id === defaultId ? 1 : p.pinned ? 2 : 3;
  return presets
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map(({ p }) => p);
}

/**
 * How many icon chips fit beside the open preset in `width` px, where `fixed`
 * is what the open chip and the new-preset button already take. Every icon
 * shows when all fit; otherwise room is kept for "+N". A width of 0 (not
 * measured yet) shows none.
 */
export function aeRowIconCount(width: number, fixed: number, icons: number): number {
  if (width <= 0 || icons <= 0) return 0;
  if (fixed + icons * AE_ROW_ICON_PX <= width) return icons;
  return Math.max(
    0,
    Math.min(icons, Math.floor((width - fixed - AE_ROW_MORE_PX) / AE_ROW_ICON_PX)),
  );
}
