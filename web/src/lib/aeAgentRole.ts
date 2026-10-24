// The role an agent works in (omnigent-ae): a session's `ae.role` label, or for a
// native subagent its description opening with the role ("Builder A: ...").

import { AE_ROLE_IDS, AE_ROLE_LABELS, type AeRoleId } from "@/lib/aeRoles";

/** The child fields a role can be read from; a native subagent's role rides in its summary or description. */
export interface AeAgentRoleSource {
  labels?: Record<string, string> | null;
  task_summary?: string | null;
}

const DESCRIPTION_LABEL = "omnigent.claude_native.description";
const NAMES = AE_ROLE_IDS.join("|");
// "Role: Builder." alone, or a description opening "Builder A: ..." (at most one 1-2 character token, then a colon).
const ROLE_PREFIX = new RegExp(`^\\s*role:\\s*(${NAMES})\\b`, "i");
const ROLE_DESCRIPTION = new RegExp(
  `^\\s*(?:role:\\s*)?(${NAMES})\\b(?:[ \\t]+[a-z0-9]{1,2})?[ \\t]*:`,
  "i",
);

function isRoleId(value: unknown): value is AeRoleId {
  return (AE_ROLE_IDS as readonly unknown[]).includes(value);
}

function roleFromText(text: string | null | undefined): AeRoleId | null {
  const match = ROLE_PREFIX.exec(text ?? "") ?? ROLE_DESCRIPTION.exec(text ?? "");
  const id = match?.[1].toLowerCase();
  return isRoleId(id) ? id : null;
}

/** The agent's role id, or null when it has none. */
export function aeAgentRole(child: AeAgentRoleSource): AeAgentRoleId | null {
  const label = child.labels?.["ae.role"];
  if (isRoleId(label)) return label;
  return roleFromText(child.task_summary) ?? roleFromText(child.labels?.[DESCRIPTION_LABEL]);
}

export type AeAgentRoleId = AeRoleId;

/** "builder" reads "Builder". */
export function aeRoleName(role: AeRoleId): string {
  return AE_ROLE_LABELS[role].label;
}

function trim(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.?0+$/, "");
}

/** 950, 9k, 116.4k, 1.24M. */
export function aeFormatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  // Floor, so 999,999 reads 999.9k rather than rounding up to a million.
  if (n < 1_000_000) return `${trim(Math.floor(n / 100) / 10, 1)}k`;
  return `${trim(n / 1_000_000, 2)}M`;
}

/** $0, <$0.01, $1.64, $71.25, $1,234. */
export function aeFormatCost(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  // Decide on the rounded cents, so 99.996 reads $100 and not $100.00.
  if (Math.round(usd * 100) < 10_000) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}
