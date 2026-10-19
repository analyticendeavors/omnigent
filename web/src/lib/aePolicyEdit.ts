/**
 * Editing a global policy's parameters on the Global Policies page (AE patch).
 *
 * The add dialog holds every parameter as a string; these helpers turn a stored
 * policy's `factory_params` back into those strings and decide which policies
 * have parameters to edit.
 */

import type { DefaultPolicy } from "@/hooks/useDefaultPolicies";
import type { PolicyRegistryEntry } from "@/hooks/usePolicies";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";

/** Tabler's `pencil` (@tabler/icons 3.46.0), inlined for the Edit button. */
export const AE_PENCIL_ICON: AeTablerIconNode = [
  ["path", { d: "M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4" }],
  ["path", { d: "M13.5 6.5l4 4" }],
];

function formText(value: unknown): string {
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

/**
 * A stored policy's params as the dialog's form strings. Arrays join with ","
 * and no space, because the multi-select chips split on "," without trimming;
 * objects become JSON, as the object field expects.
 */
export function aePolicyFormValues(
  params: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === null || value === undefined) continue;
    values[key] = Array.isArray(value) ? value.map(formText).join(",") : formText(value);
  }
  return values;
}

/**
 * The params an edit saves. The form strings cannot carry every stored value
 * back (an empty list, numbers in a list, an item with a comma), so a field
 * whose text still matches its prefill keeps the stored value exactly, as do
 * stored keys the form does not show. A changed field takes the dialog's
 * coerced value, and a cleared one is left out, so the factory's default applies.
 */
export function aeEditedParams(
  stored: Record<string, unknown> | null | undefined,
  form: Record<string, string>,
  coerced: Record<string, unknown>,
): Record<string, unknown> {
  const prefill = aePolicyFormValues(stored);
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored ?? {})) {
    if (form[key] === prefill[key]) params[key] = value;
  }
  for (const [key, value] of Object.entries(coerced)) {
    if (form[key] !== prefill[key]) params[key] = value;
  }
  return params;
}

/** Whether a card offers Edit: a stored factory policy whose schema has parameters. */
export function aePolicyEditable(policy: DefaultPolicy, entry?: PolicyRegistryEntry): boolean {
  if (policy.id === null || policy.source === "config" || entry?.kind !== "factory") return false;
  const schema = entry.params_schema as { properties?: Record<string, unknown> } | null;
  return Object.keys(schema?.properties ?? {}).length > 0;
}
