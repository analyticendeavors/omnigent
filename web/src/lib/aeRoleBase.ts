// The role setting shapes aeRoles.ts and aeReviewers.ts both build on
// (omnigent-ae, 2026-10-24); aeRoles.ts re-exports them.

import { aeClaudeVersionLabel } from "@/lib/aeClaudeModels";

export const AE_ROLE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AeRoleEffort = (typeof AE_ROLE_EFFORTS)[number];

export type AeRoleSetting =
  { mode: "auto" } | { mode: "session" } | { mode: "fixed"; model: string; effort: AeRoleEffort };

/** "claude-opus-5-5" -> "Opus 5.5"; an id it cannot read stays as is. */
export function aeModelLabel(model: string): string {
  return aeClaudeVersionLabel(model) ?? model;
}
