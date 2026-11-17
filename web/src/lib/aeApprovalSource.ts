// Who resolved an approval card (omnigent-ae). Each client caller of submitApproval passes one
// of these in the resolve body's `_meta.source`; the server logs it next to the verdict so a
// card that resolved by itself can be traced to the control that did it. The server accepts
// only these values and logs anything else as "unknown".

export const APPROVAL_SOURCES = [
  "card",
  "voice",
  "voice_panel",
  "hotkey",
  "inbox",
  "approve_page",
] as const;

export type ApprovalSource = (typeof APPROVAL_SOURCES)[number];

/** `meta` with the source added; a source the caller already set is overwritten. */
export function withApprovalSource(
  source: ApprovalSource,
  meta?: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(meta ?? {}), source };
}
