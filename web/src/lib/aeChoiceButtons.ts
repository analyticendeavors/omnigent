// AE: a form prompt with one small choice shows one button per choice.
//
// An MCP server's confirmation ("Confirm the operation", a required string enum
// Yes / No with enumNames "Continue the operation" / "Decline the operation")
// used to render a dropdown plus Submit and Reject. Reid, 2026-10-27: "you don't
// need a dropdown for Continue or Decline the operation. The popup should have a
// single button for either." This file holds the detection and the label rule;
// `AeChoiceButtons.tsx` draws the buttons.
//
// Kept out of the component files (the thin-fork rule): vitest suites mock whole
// component modules, and a constant two files share lives here.

import { enumLabel, schemaFields } from "@/components/blocks/ElicitationSchemaForm";

/** One button: the enum value it submits, the short label, and the full label. */
export interface AeChoice {
  value: string;
  /** Shown on the button: the full label minus any words every label shares at the end. */
  label: string;
  /** Shown in the tooltip and read by screen readers. */
  fullLabel: string;
}

/** A schema that is one small choice, ready to draw as buttons. */
export interface AeChoiceField {
  name: string;
  title: string;
  description: string;
  choices: AeChoice[];
  /** True when no choice declines, so the card adds a Reject button of its own. */
  needsReject: boolean;
}

const DECLINE_LIKE = /^(no|decline|cancel|deny|reject)\b/i;

/** Whether a choice's value or full label reads as a decline. */
export function aeChoiceDeclines(choice: AeChoice): boolean {
  return DECLINE_LIKE.test(choice.value.trim()) || DECLINE_LIKE.test(choice.fullLabel.trim());
}

/** The most values a choice may have and still read better as buttons than a select. */
export const AE_CHOICE_MAX = 4;
export const AE_CHOICE_MIN = 2;

/**
 * Drop the run of whole words every label ends with, keeping at least one word
 * on each. ``["Continue the operation", "Decline the operation"]`` becomes
 * ``["Continue", "Decline"]``; labels that share nothing, or would lose every
 * word, come back unchanged.
 */
export function trimSharedSuffix(labels: string[]): string[] {
  const words = labels.map((label) => label.trim().split(/\s+/).filter(Boolean));
  if (words.length < 2 || words.some((w) => w.length === 0)) return labels;
  const shortest = Math.min(...words.map((w) => w.length));
  let shared = 0;
  while (shared < shortest - 1) {
    const last = (w: string[]) => w[w.length - 1 - shared];
    const word = last(words[0]);
    if (!words.every((w) => last(w) === word)) break;
    shared += 1;
  }
  if (shared === 0) return labels;
  // "Yes, proceed" and "No, proceed" leave "Yes," and "No,": drop the dangling mark.
  return words.map((w) =>
    w
      .slice(0, w.length - shared)
      .join(" ")
      .replace(/[,;:.]+$/, ""),
  );
}

/** A button label longer than this is cut down to its first clause. */
const SHORT_LABEL_MAX = 40;

/**
 * What a button shows for a long answer: the words before the first colon or
 * " - " (an option often reads "Do X: because Y, then Z"), else the label cut at
 * a word with an ellipsis. A short label comes back as it is; the full text stays in the
 * button's tooltip and accessible name.
 */
export function aeShortChoiceLabel(label: string): string {
  const text = label.trim();
  if (text.length <= SHORT_LABEL_MAX) return text;
  const head = text.split(/:\s|\s-\s/)[0].trim();
  // A clause a little over the limit still beats a cut mid-thought; the button wraps.
  if (head.length >= 3 && head.length < text.length && head.length <= SHORT_LABEL_MAX + 12) {
    return head;
  }
  // Cut by code point so an emoji is never split, and at a word when the cut lands inside one.
  const chars = Array.from(text);
  const kept = chars.slice(0, SHORT_LABEL_MAX).join("");
  const cut = /\s/.test(chars[SHORT_LABEL_MAX]) ? kept.trimEnd() : kept.replace(/\s+\S*$/, "");
  return `${cut || kept}…`;
}

/**
 * The labels buttons show for these answers. Two answers that shorten to the
 * same words ("Fix it now: patch it" and "Fix it now: revert it") keep their
 * full labels, so no two buttons read alike.
 */
export function aeShortChoiceLabels(labels: string[]): string[] {
  const short = labels.map(aeShortChoiceLabel);
  return short.map((s, i) => (short.filter((o) => o === s).length > 1 ? labels[i].trim() : s));
}

/**
 * The single-choice form in ``schema``, or null when it is anything else:
 * exactly one property, a required string whose schema lists 2 to 4 string
 * values in `enum` (oneOf and const forms keep the dropdown), and not an
 * AskUserQuestion. An optional field keeps the form, since buttons would force a value.
 */
export function aeChoiceField(
  schema: Record<string, unknown> | null | undefined,
  isAskUserQuestion = false,
): AeChoiceField | null {
  if (isAskUserQuestion) return null;
  const fields = schemaFields(schema);
  if (fields.length !== 1) return null;
  const { name, prop, required } = fields[0];
  if (!required) return null;
  if (prop.type !== "string" || !Array.isArray(prop.enum)) return null;
  if (prop.enum.length < AE_CHOICE_MIN || prop.enum.length > AE_CHOICE_MAX) return null;
  if (!prop.enum.every((v) => typeof v === "string")) return null;
  const values = prop.enum as string[];
  if (new Set(values).size !== values.length) return null;
  const full = values.map((value, i) => enumLabel(prop, i, value));
  const short = aeShortChoiceLabels(trimSharedSuffix(full));
  const choices = values.map((value, i) => ({ value, label: short[i], fullLabel: full[i] }));
  return {
    name,
    title: typeof prop.title === "string" ? prop.title : "",
    description: typeof prop.description === "string" ? prop.description : "",
    choices,
    needsReject: !choices.some(aeChoiceDeclines),
  };
}

/** The first button is the primary style only when its value is an affirmative "Yes". */
export function aeChoiceIsPrimary(choice: AeChoice, index: number): boolean {
  return index === 0 && choice.value.trim().toLowerCase() === "yes";
}

/** A "No" value takes the outline style the card's Reject uses. */
export function aeChoiceIsNo(choice: AeChoice): boolean {
  return choice.value.trim().toLowerCase() === "no";
}
