import { describe, expect, it } from "vitest";

import {
  CLAUDE_NATIVE_PERMISSION_MODES,
  CLAUDE_NATIVE_SWITCHABLE_PERMISSION_MODES,
  claudePermissionModeFromSession,
  claudePermissionModeLabel,
  claudePermissionSwitchNotice,
  isClaudeNativeSession,
  isSwitchableClaudePermissionMode,
} from "@/lib/claudePermissionMode";

describe("claudePermissionSwitchNotice", () => {
  it("is silent when the switch landed where asked", () => {
    expect(claudePermissionSwitchNotice("plan", "plan", "restarted")).toBeNull();
    expect(claudePermissionSwitchNotice("plan", "plan", "switched")).toBeNull();
  });

  it("says only that Claude restarted when its mode was not read", () => {
    expect(claudePermissionSwitchNotice("plan", "auto", "unconfirmed")).toBe(
      "Claude restarted; its mode will show once it is read.",
    );
  });

  it("says restarted only after a restart", () => {
    expect(claudePermissionSwitchNotice("plan", "auto", "restarted")).toBe(
      "Claude restarted but is in Auto, not Plan.",
    );
    expect(claudePermissionSwitchNotice("plan", "auto", "switched")).toBe(
      "Claude is in Auto, not Plan.",
    );
    expect(claudePermissionSwitchNotice("plan", "auto", undefined)).toBe(
      "Claude is in Auto, not Plan.",
    );
  });

  it("keeps the managed-setting hint for a bypass request that was restarted", () => {
    expect(claudePermissionSwitchNotice("bypassPermissions", "default", "restarted")).toBe(
      "Claude restarted but stayed in Manual. A managed setting on this host may turn bypass off.",
    );
  });
});

describe("claudePermissionMode", () => {
  it("offers only shift+tab-reachable modes for a running session", () => {
    // dontAsk is never in Claude's cycle — offering it would produce a switch
    // the server rejects. Bypass is last: the cycle does not reach it, so the
    // runner restarts Claude in the same chat to get there.
    expect(CLAUDE_NATIVE_SWITCHABLE_PERMISSION_MODES.map((m) => m.value)).toEqual([
      "default",
      "auto",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ]);
    const bypass = CLAUDE_NATIVE_SWITCHABLE_PERMISSION_MODES.find(
      (m) => m.value === "bypassPermissions",
    );
    expect(bypass?.label).toBe("Bypass permissions");
    expect(bypass?.description).toBe(
      "Restarts Claude in this chat, then runs everything with no prompts or safety checks",
    );
    // The start-session list keeps the original wording.
    expect(
      CLAUDE_NATIVE_PERMISSION_MODES.find((m) => m.value === "bypassPermissions")?.description,
    ).toBe("Runs everything; no prompts or safety checks");
  });

  it("still offers the launch-only modes when starting a session", () => {
    // The start-session picker passes --permission-mode, which accepts modes
    // the live switcher can't reach; that vocabulary must stay wider.
    const startup = CLAUDE_NATIVE_PERMISSION_MODES.map((m) => m.value);
    expect(startup).toContain("dontAsk");
    expect(startup).toContain("bypassPermissions");
  });

  it("labels the prompting mode the way Claude Code does", () => {
    // Claude's own TUI renders "manual mode on" for the `default` value, so
    // the web label matches what users see in the pane.
    expect(claudePermissionModeLabel("default")).toBe("Manual");
    expect(claudePermissionModeLabel("auto")).toBe("Auto");
  });

  it("falls back to the raw value for an unknown mode", () => {
    expect(claudePermissionModeLabel("someFutureMode")).toBe("someFutureMode");
    expect(claudePermissionModeLabel(null)).toBe("");
  });

  it("accepts only switchable modes", () => {
    expect(isSwitchableClaudePermissionMode("auto")).toBe(true);
    expect(isSwitchableClaudePermissionMode("dontAsk")).toBe(false);
    expect(isSwitchableClaudePermissionMode("bypassPermissions")).toBe(true);
    expect(isSwitchableClaudePermissionMode(undefined)).toBe(false);
  });

  describe("isClaudeNativeSession", () => {
    it("matches the claude-native wrapper only", () => {
      expect(
        isClaudeNativeSession({ labels: { "omnigent.wrapper": "claude-code-native-ui" } }),
      ).toBe(true);
      expect(isClaudeNativeSession({ labels: { "omnigent.wrapper": "codex-native-ui" } })).toBe(
        false,
      );
    });

    it("fails closed with no session or no labels", () => {
      // A session with no wrapper label must not match — otherwise the mode
      // picker would render for harnesses with no shift+tab cycle to drive.
      expect(isClaudeNativeSession(null)).toBe(false);
      expect(isClaudeNativeSession(undefined)).toBe(false);
      expect(isClaudeNativeSession({})).toBe(false);
      expect(isClaudeNativeSession({ labels: {} })).toBe(false);
    });
  });

  describe("claudePermissionModeFromSession", () => {
    it("prefers the label the server stamps after a live switch", () => {
      expect(
        claudePermissionModeFromSession({
          labels: { "omnigent.claude_native.permission_mode": "auto" },
          terminalLaunchArgs: ["--permission-mode", "plan"],
        }),
      ).toBe("auto");
    });

    it("falls back to the launch flag before any switch", () => {
      // terminal_launch_args is the only signal until the first live switch
      // stamps the label.
      expect(
        claudePermissionModeFromSession({
          terminalLaunchArgs: ["--permission-mode", "plan"],
        }),
      ).toBe("plan");
    });

    it("reads the flag value even when other launch args precede it", () => {
      expect(
        claudePermissionModeFromSession({
          terminalLaunchArgs: ["--verbose", "--permission-mode", "acceptEdits"],
        }),
      ).toBe("acceptEdits");
    });

    it("returns null when the mode cannot be determined", () => {
      // Not "default": a `permissions.defaultMode` in a settings file boots
      // the session into a mode that never reaches terminal_launch_args, so
      // guessing would display a mode the session isn't in. Callers hide the
      // picker instead.
      expect(claudePermissionModeFromSession({})).toBeNull();
      expect(claudePermissionModeFromSession(null)).toBeNull();
      // A trailing flag with no value must not read past the end of the args.
      expect(
        claudePermissionModeFromSession({ terminalLaunchArgs: ["--permission-mode"] }),
      ).toBeNull();
    });
  });
});
