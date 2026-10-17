// Pure mapping for the rail's Environment, Connectors, Outputs and Changes
// sections, kept apart from the hooks so each rule is unit-testable.

import { RunnerOfflineError, type WorkspaceChangedFile } from "@/hooks/useWorkspaceChangedFiles";
import { claudePermissionModeLabel } from "@/lib/claudePermissionMode";
import { codexApprovalModeLabel } from "@/lib/codexApprovalMode";
import type { AePrCard } from "@/lib/aePrs";
import type { AeRailIconName } from "./aeRailIcons";

// Environment

/** Which harness family reports what: Claude Code, Codex, or neither. */
export type AeRailHarnessKind = "claude" | "codex" | "other";

export function aeRailHarnessKind(harness: string | null | undefined): AeRailHarnessKind {
  if (harness === "claude-native" || harness === "native-claude") return "claude";
  if (harness === "codex-native" || harness === "native-codex") return "codex";
  return "other";
}

/** A folder as the rail shows it: the last segment, then its parent with home as "~". */
export function aeRailFolderParts(
  path: string,
  home: string | null | undefined,
): { name: string; parent: string } {
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = cut >= 0 ? trimmed.slice(cut + 1) || trimmed : trimmed;
  let parent = cut > 0 ? trimmed.slice(0, cut) : cut === 0 ? "/" : "";
  const cleanHome = home && home.length > 1 ? home.replace(/[\\/]+$/, "") : home;
  const afterHome = cleanHome ? parent.charAt(cleanHome.length) : "";
  if (
    cleanHome &&
    parent.startsWith(cleanHome) &&
    (parent === cleanHome || afterHome === "/" || afterHome === "\\")
  ) {
    parent = `~${parent.slice(cleanHome.length)}`;
  }
  return { name, parent };
}

/** The permission mode in the composer's words, or `null` when the session has not reported one. */
export function aeRailPermissionLabel(
  kind: AeRailHarnessKind,
  claudeMode: string | null | undefined,
  codexMode: string | null | undefined,
): string | null {
  if (kind === "claude") return claudeMode ? claudePermissionModeLabel(claudeMode) : null;
  if (kind === "codex") return codexMode ? codexApprovalModeLabel(codexMode) : null;
  return null;
}

// Connectors

export type AeRailMcpTone = "ok" | "err" | "warn" | "muted";

export interface AeRailConnectorRow {
  name: string;
  status: string;
  tone: AeRailMcpTone;
  word: string;
}

const MCP_STATUS: Record<string, { tone: AeRailMcpTone; word: string; order: number }> = {
  failed: { tone: "err", word: "failed", order: 0 },
  "needs-auth": { tone: "warn", word: "needs sign-in", order: 1 },
  pending: { tone: "warn", word: "starting", order: 2 },
  connected: { tone: "ok", word: "connected", order: 3 },
  disabled: { tone: "muted", word: "disabled", order: 4 },
  cancelled: { tone: "muted", word: "cancelled", order: 4 },
};

const UNKNOWN_STATUS = { tone: "muted" as const, word: "unknown", order: 5 };

/** Servers with a tone and a word, problems first, then by name. */
export function aeRailConnectorRows(
  servers: readonly { name: string; status: string }[] | undefined,
): AeRailConnectorRow[] {
  return (servers ?? [])
    .filter((server) => typeof server.name === "string" && server.name.trim() !== "")
    .map((server) => ({ server, meta: MCP_STATUS[server.status] ?? UNKNOWN_STATUS }))
    .sort(
      (a, b) =>
        a.meta.order - b.meta.order ||
        a.server.name.localeCompare(b.server.name, undefined, { sensitivity: "base" }),
    )
    .map(({ server, meta }) => ({
      name: server.name,
      status: server.status,
      tone: meta.tone,
      word: meta.word,
    }));
}

export function aeRailConnectorCounts(rows: readonly AeRailConnectorRow[]): {
  connected: number;
  failed: number;
  total: number;
} {
  return {
    connected: rows.filter((row) => row.status === "connected").length,
    failed: rows.filter((row) => row.status === "failed").length,
    total: rows.length,
  };
}

// Outputs

export type AeRailFileKind = "code" | "image" | "text" | "other";

const CODE_EXT = new Set(
  "ts tsx js jsx mjs cjs py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh ps1 sql html htm css scss less vue svelte json yaml yml toml xml tmdl dax m ipynb patch diff".split(
    " ",
  ),
);
const IMAGE_EXT = new Set("png jpg jpeg gif webp svg bmp ico avif heic tif tiff".split(" "));
const TEXT_EXT = new Set("md mdx txt csv tsv log rst adoc rtf".split(" "));

export function aeRailFileKind(name: string): AeRailFileKind {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (CODE_EXT.has(ext)) return "code";
  if (TEXT_EXT.has(ext)) return "text";
  return "other";
}

export const AE_RAIL_FILE_ICON: Record<AeRailFileKind, AeRailIconName> = {
  code: "fileCode",
  image: "photo",
  text: "fileText",
  other: "file",
};

export interface AeRailOutput {
  path: string;
  name: string;
  folder: string;
  kind: AeRailFileKind;
}

/** Files the session created (not edited or deleted), newest first. */
export function aeRailOutputs(files: readonly WorkspaceChangedFile[] | undefined): AeRailOutput[] {
  return (files ?? [])
    .filter((file) => file.status === "created")
    .map((file, index) => ({ file, index }))
    .sort(
      (a, b) =>
        (b.file.modified_at ?? Number.NEGATIVE_INFINITY) -
          (a.file.modified_at ?? Number.NEGATIVE_INFINITY) || a.index - b.index,
    )
    .map(({ file }) => {
      const cut = file.path.lastIndexOf("/");
      return {
        path: file.path,
        name: file.name || file.path.slice(cut + 1),
        folder: cut > 0 ? file.path.slice(0, cut) : "",
        kind: aeRailFileKind(file.name || file.path),
      };
    });
}

/** What to say when the changes list cannot load. */
export function aeRailChangesError(error: unknown): string {
  if (error instanceof RunnerOfflineError) {
    return "The session's runner is offline. Send a message to wake it, then reopen this section.";
  }
  const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
  return `Could not load the session's files${detail}. Reopen this section to retry.`;
}

// Changes

export function aeRailChangeTotals(files: readonly WorkspaceChangedFile[] | undefined): {
  files: number;
  added: number;
  removed: number;
  /** Some file reported line counts; outside git none do, and +0 −0 would mislead. */
  counted: boolean;
} {
  let added = 0;
  let removed = 0;
  let counted = false;
  for (const file of files ?? []) {
    if (file.lines_added != null || file.lines_removed != null) counted = true;
    added += file.lines_added ?? 0;
    removed += file.lines_removed ?? 0;
  }
  return { files: files?.length ?? 0, added, removed, counted };
}

export type AeRailPrState = "open" | "draft" | "merged" | "closed" | "unknown";

/** A pull request's state from its card, or `unknown` until the card loads. */
export function aeRailPrState(card: AePrCard | undefined): AeRailPrState {
  if (!card) return "unknown";
  if (card.state === "merged") return "merged";
  if (card.state === "closed") return "closed";
  return card.draft ? "draft" : "open";
}

/** The muted line under a pull request's title: "omnigent-ae #108 · checks running". */
export function aeRailPrMeta(
  repository: string,
  number: number,
  card: AePrCard | undefined,
): string {
  const repo = repository.split("/").pop() || repository;
  const head = `${repo} #${number}`;
  const state = aeRailPrState(card);
  if (!card) return head;
  if (state === "merged" || state === "closed") return `${head} · ${state}`;
  const checks: Record<AePrCard["ci"]["state"], string> = {
    passing: "checks passed",
    failing: "checks failing",
    pending: "checks running",
    none: "no checks",
    unknown: "checks unknown",
  };
  return `${head} · ${state === "draft" ? "draft · " : ""}${checks[card.ci.state]}`;
}

export function aeRailCount(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
