// Claude Code's permission modes. Two vocabularies: every mode
// `--permission-mode` accepts when starting a session, and the subset a
// running session can be switched to (see the SWITCHABLE list below).

import { nativeCodingAgentForHarness, WRAPPER_LABEL_KEY } from "@/lib/nativeCodingAgents";

const CLAUDE_NATIVE_PERMISSION_MODE_LABEL_KEY = "omnigent.claude_native.permission_mode";
const CLAUDE_NATIVE_WRAPPER = nativeCodingAgentForHarness("claude-native")?.wrapperLabel;

/** Whether a session runs the claude-native wrapper. Fails closed. */
export function isClaudeNativeSession(
  session: { labels?: Record<string, string | null> | null } | null | undefined,
): boolean {
  const wrapper = session?.labels?.[WRAPPER_LABEL_KEY];
  // Both sides must be set: an undefined registry lookup must not match a
  // session with no wrapper label.
  return !!wrapper && wrapper === CLAUDE_NATIVE_WRAPPER;
}

export interface ClaudePermissionModeOption {
  value: string;
  label: string;
  description: string;
}

export const CLAUDE_NATIVE_DEFAULT_PERMISSION_MODE = "default";

// Claude Code's `claude --permission-mode` choices (v2.1). Keep in sync
// with `claude --help`. The prompting mode is spelled `default` on the
// wire and labelled "Manual" in Claude's own UI, which this mirrors.
export const CLAUDE_NATIVE_PERMISSION_MODES: ClaudePermissionModeOption[] = [
  { value: "default", label: "Manual", description: "Prompts before edits and commands" },
  {
    value: "auto",
    label: "Auto",
    description: "Auto-runs; a classifier blocks risky actions",
  },
  {
    value: "acceptEdits",
    label: "Accept edits",
    description: "Auto-applies file edits; commands still prompt",
  },
  { value: "plan", label: "Plan", description: "Plans only; makes no edits" },
  { value: "dontAsk", label: "Don't ask", description: "Auto-denies anything not pre-approved" },
  {
    value: "bypassPermissions",
    label: "Bypass permissions",
    description: "Runs everything; no prompts or safety checks",
  },
];

/**
 * Modes a running session can be switched to: the shift+tab-reachable ones,
 * plus bypass. Bypass is not in the cycle of a pane launched without it, so
 * the runner restarts Claude in the same chat instead (no allow flag is ever
 * passed at launch); `dontAsk` stays launch-only.
 */
export const CLAUDE_NATIVE_SWITCHABLE_PERMISSION_MODES: ClaudePermissionModeOption[] =
  CLAUDE_NATIVE_PERMISSION_MODES.filter((mode) =>
    ["default", "acceptEdits", "plan", "auto", "bypassPermissions"].includes(mode.value),
  ).map((mode) =>
    mode.value === "bypassPermissions"
      ? {
          ...mode,
          description:
            "Restarts Claude in this chat, then runs everything with no prompts or safety checks",
        }
      : mode,
  );

export function isSwitchableClaudePermissionMode(mode: string | null | undefined): boolean {
  return CLAUDE_NATIVE_SWITCHABLE_PERMISSION_MODES.some((m) => m.value === mode);
}

/** Human label for a mode value, falling back to the raw value. */
export function claudePermissionModeLabel(mode: string | null | undefined): string {
  if (!mode) return "";
  return CLAUDE_NATIVE_PERMISSION_MODES.find((m) => m.value === mode)?.label ?? mode;
}

/**
 * The notice to show after a Claude permission switch, or `null` when it landed
 * where it was asked to. `outcome` is what the server says the runner did:
 * `"restarted"` (Claude restarted in the same chat), `"unconfirmed"` (restarted,
 * mode not yet read) or `"switched"` (shift+tab).
 */
export function claudePermissionSwitchNotice(
  requested: string,
  reached: string | null | undefined,
  outcome: "switched" | "restarted" | "unconfirmed" | undefined,
): string | null {
  if (outcome === "unconfirmed") return "Claude restarted; its mode will show once it is read.";
  if (!reached || reached === requested) return null;
  const was = claudePermissionModeLabel(reached);
  if (outcome !== "restarted")
    return `Claude is in ${was}, not ${claudePermissionModeLabel(requested)}.`;
  return requested === "bypassPermissions"
    ? `Claude restarted but stayed in ${was}. A managed setting on this host may turn bypass off.`
    : `Claude restarted but is in ${was}, not ${claudePermissionModeLabel(requested)}.`;
}

/**
 * The permission mode a running claude-native session is in, or `null` when
 * it cannot be determined.
 *
 * Prefers the label the server stamps after a confirmed switch, then the
 * launch flag. Returns `null` rather than assuming Claude's default: a
 * `permissions.defaultMode` in a settings file boots the session into a mode
 * that never appears in `terminal_launch_args`, so guessing "Manual" would
 * display a mode the session isn't in. Callers hide the picker on `null`.
 */
export function claudePermissionModeFromSession(
  session:
    | {
        labels?: Record<string, string | null> | null;
        terminalLaunchArgs?: string[] | null;
      }
    | null
    | undefined,
): string | null {
  const labelled = session?.labels?.[CLAUDE_NATIVE_PERMISSION_MODE_LABEL_KEY];
  if (typeof labelled === "string" && labelled) return labelled;
  const args = session?.terminalLaunchArgs ?? [];
  const flagIndex = args.indexOf("--permission-mode");
  if (flagIndex >= 0 && flagIndex + 1 < args.length) return args[flagIndex + 1];
  return null;
}
