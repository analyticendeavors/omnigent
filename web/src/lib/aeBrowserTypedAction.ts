/**
 * AE: route the agent's browser snapshot, click and type through the desktop
 * shell's typed `browserPerformAction` bridge when the shell has one.
 *
 * Why (2026-11-21): desktop shells from 0.21 on build every page script in the
 * main process. Their legacy `browserExecute` path still runs a v0.18 relay's
 * scripts, but only when a script matches the shell's built-in template byte
 * for byte (`web/electron/src/browserLegacyAction.js` upstream). The AE
 * snapshot walk (dialogs in portals, shadow roots, frames) differs from that
 * template, so a 0.21 shell refused every snapshot with "Unsupported legacy
 * browser action; update the server UI". The typed bridge takes the action
 * name and its arguments instead. Shells without it (0.18, and this tree's own
 * desktop build) keep the `browserExecute` path and the AE snapshot walk.
 */

export type AeTypedBrowserAction = "snapshot" | "click" | "type";

export interface AeTypedBrowserBridge {
  browserPerformAction?: (
    conversationId: string,
    action: AeTypedBrowserAction,
    params?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; result?: string; error?: string }>;
}

/** The argument keys the shell accepts per action; it refuses any other key. */
const TYPED_ACTION_KEYS: Record<AeTypedBrowserAction, readonly string[]> = {
  snapshot: [],
  click: ["ref", "snapshot_id", "selector"],
  type: ["ref", "snapshot_id", "selector", "text"],
};

/** Keep only the keys the shell accepts, and drop null or missing values. */
export function aeTypedActionParams(
  action: AeTypedBrowserAction,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const key of TYPED_ACTION_KEYS[action]) {
    const value = args[key];
    if (value !== undefined && value !== null) params[key] = value;
  }
  return params;
}

/** Run the action through the typed bridge, or return undefined when the shell
 *  has none, so the caller falls back to `browserExecute`. */
export function aeTypedBrowserAction(
  desktop: AeTypedBrowserBridge,
  conversationId: string,
  action: AeTypedBrowserAction,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: string; error?: string }> | undefined {
  if (typeof desktop.browserPerformAction !== "function") return undefined;
  return desktop.browserPerformAction(conversationId, action, aeTypedActionParams(action, args));
}

/** The shell captures a page that was never on screen as an empty image, which
 *  arrives as a data URL with no payload. */
export function aeIsBlankCapture(dataUrl: string): boolean {
  const comma = dataUrl.indexOf(",");
  return comma === -1 || dataUrl.slice(comma + 1).trim() === "";
}

export const AE_BLANK_CAPTURE_ERROR =
  "The desktop app returned a blank screenshot because this chat's browser page is not on " +
  "screen. Ask the user to open the Browser pane on this chat, then call browser_screenshot " +
  "again.";
