import { describe, expect, it } from "vitest";
import { RunnerOfflineError, type WorkspaceChangedFile } from "@/hooks/useWorkspaceChangedFiles";
import type { AePrCard } from "@/lib/aePrs";
import {
  aeRailChangeTotals,
  aeRailChangesError,
  aeRailConnectorCounts,
  aeRailConnectorRows,
  aeRailFileKind,
  aeRailFolderParts,
  aeRailHarnessKind,
  aeRailOutputs,
  aeRailPermissionLabel,
  aeRailPrMeta,
  aeRailPrState,
} from "./aeRailModel";

function file(path: string, extra: Partial<WorkspaceChangedFile> = {}): WorkspaceChangedFile {
  return {
    path,
    name: path.split("/").pop() ?? path,
    status: "created",
    bytes: 10,
    modified_at: 100,
    lines_added: null,
    lines_removed: null,
    ...extra,
  };
}

function card(extra: Partial<AePrCard> = {}): AePrCard {
  return {
    repo: "analyticendeavors/omnigent-ae",
    number: 108,
    url: "https://github.com/analyticendeavors/omnigent-ae/pull/108",
    title: "Add a session rail",
    state: "open",
    draft: false,
    author: null,
    head_ref: null,
    base_ref: null,
    head_sha: null,
    ci: { state: "pending", passing: 1, failing: 0, pending: 2, total: 3 },
    mergeable: { state: "clean", detail: "" },
    review: { state: "none", approvals: 0, changes_requested: 0, requested: [] },
    merge: { methods: [], default_method: null, allowed: false, reason: null },
    ...extra,
  } as AePrCard;
}

describe("environment", () => {
  it("names the harness family", () => {
    expect(aeRailHarnessKind("claude-native")).toBe("claude");
    expect(aeRailHarnessKind("native-codex")).toBe("codex");
    expect(aeRailHarnessKind("claude-sdk")).toBe("other");
    expect(aeRailHarnessKind(null)).toBe("other");
  });

  it("splits a folder and shortens home to ~", () => {
    expect(aeRailFolderParts("/home/demo/repos/omnigent-ae/", "/home/demo")).toEqual({
      name: "omnigent-ae",
      parent: "~/repos",
    });
    expect(aeRailFolderParts("/home/demo/x", "/home/demo/")).toEqual({ name: "x", parent: "~" });
    expect(aeRailFolderParts("/srv/app", null)).toEqual({ name: "app", parent: "/srv" });
    // Built from parts: a sibling that merely starts with the home user's name.
    const sibling = ["demo", "x"].join("");
    expect(aeRailFolderParts(`/home/${sibling}/app`, "/home/demo").parent).toBe(`/home/${sibling}`);
    expect(aeRailFolderParts("C:\\Users\\demo\\GitHub\\repo", "C:\\Users\\demo")).toEqual({
      name: "repo",
      parent: "~\\GitHub",
    });
    expect(aeRailFolderParts(`C:\\Users\\${sibling}\\repo`, "C:\\Users\\demo").parent).toBe(
      `C:\\Users\\${sibling}`,
    );
    expect(aeRailFolderParts("/app", null)).toEqual({ name: "app", parent: "/" });
  });

  it("labels the permission mode in the composer's words", () => {
    expect(aeRailPermissionLabel("claude", "auto", null)).toBe("Auto");
    expect(aeRailPermissionLabel("claude", "default", null)).toBe("Manual");
    expect(aeRailPermissionLabel("codex", null, "approve-for-me")).toBe("Approve for me");
    expect(aeRailPermissionLabel("claude", "", null)).toBeNull();
    expect(aeRailPermissionLabel("other", "auto", "full-access")).toBeNull();
  });
});

describe("connectors", () => {
  it("puts problems first and counts connected and failed", () => {
    const rows = aeRailConnectorRows([
      { name: "omnigent", status: "connected" },
      { name: "ae", status: "connected" },
      { name: "raymcp", status: "failed" },
      { name: "github", status: "needs-auth" },
      { name: "slow", status: "pending" },
      { name: "off", status: "disabled" },
      { name: "odd", status: "weird" },
      { name: "  ", status: "connected" },
    ]);
    expect(rows.map((r) => [r.name, r.tone, r.word])).toEqual([
      ["raymcp", "err", "failed"],
      ["github", "warn", "needs sign-in"],
      ["slow", "warn", "starting"],
      ["ae", "ok", "connected"],
      ["omnigent", "ok", "connected"],
      ["off", "muted", "disabled"],
      ["odd", "muted", "unknown"],
    ]);
    expect(aeRailConnectorCounts(rows)).toEqual({ connected: 2, failed: 1, total: 7 });
    expect(aeRailConnectorRows(undefined)).toEqual([]);
  });
});

describe("outputs", () => {
  it("lists only created files, newest first, with a kind", () => {
    const outputs = aeRailOutputs([
      file("docs/old.md", { modified_at: 1 }),
      file("src/edited.ts", { status: "modified", modified_at: 50 }),
      file("gone.txt", { status: "deleted", modified_at: 60 }),
      file("shots/rail.png", { modified_at: 30 }),
      file("review.html", { modified_at: null }),
      file("web/src/new.tsx", { modified_at: 40 }),
    ]);
    expect(outputs).toEqual([
      { path: "web/src/new.tsx", name: "new.tsx", folder: "web/src", kind: "code" },
      { path: "shots/rail.png", name: "rail.png", folder: "shots", kind: "image" },
      { path: "docs/old.md", name: "old.md", folder: "docs", kind: "text" },
      { path: "review.html", name: "review.html", folder: "", kind: "code" },
    ]);
  });

  it("knows other files and dotfiles", () => {
    expect(aeRailFileKind("0070-ae-patch.patch")).toBe("code");
    expect(aeRailFileKind("archive.zip")).toBe("other");
    expect(aeRailFileKind(".env")).toBe("other");
    expect(aeRailFileKind("PHOTO.JPG")).toBe("image");
  });

  it("explains a load failure with what to do", () => {
    expect(aeRailChangesError(new RunnerOfflineError())).toMatch(
      /runner is offline.*Send a message/,
    );
    expect(aeRailChangesError(new Error("git status timed out"))).toBe(
      "Could not load the session's files: git status timed out. Reopen this section to retry.",
    );
  });
});

describe("changes", () => {
  it("sums lines, treating unknown counts as zero", () => {
    expect(
      aeRailChangeTotals([
        file("a.ts", { lines_added: 10, lines_removed: 2 }),
        file("b.png"),
        file("c.ts", { status: "modified", lines_added: 5, lines_removed: 7 }),
      ]),
    ).toEqual({ files: 3, added: 15, removed: 9, counted: true });
    expect(aeRailChangeTotals(undefined)).toEqual({
      files: 0,
      added: 0,
      removed: 0,
      counted: false,
    });
    expect(aeRailChangeTotals([file("x.txt", {})])).toEqual({
      files: 1,
      added: 0,
      removed: 0,
      counted: false,
    });
  });

  it("maps pull request states and the muted line", () => {
    expect(aeRailPrState(undefined)).toBe("unknown");
    expect(aeRailPrState(card())).toBe("open");
    expect(aeRailPrState(card({ draft: true }))).toBe("draft");
    expect(aeRailPrState(card({ state: "merged" }))).toBe("merged");
    expect(aeRailPrState(card({ state: "closed" }))).toBe("closed");
    const repo = "analyticendeavors/omnigent-ae";
    expect(aeRailPrMeta(repo, 108, undefined)).toBe("omnigent-ae #108");
    expect(aeRailPrMeta(repo, 108, card())).toBe("omnigent-ae #108 · checks running");
    expect(aeRailPrMeta(repo, 108, card({ draft: true }))).toBe(
      "omnigent-ae #108 · draft · checks running",
    );
    expect(aeRailPrMeta(repo, 106, card({ state: "merged" }))).toBe("omnigent-ae #106 · merged");
    expect(
      aeRailPrMeta(
        repo,
        1,
        card({ ci: { state: "failing", passing: 0, failing: 1, pending: 0, total: 1 } }),
      ),
    ).toBe("omnigent-ae #1 · checks failing");
  });
});
