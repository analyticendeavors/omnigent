// A plain-English line for a pending approval, plus a deterministic risk class (2026-11-27).
// The owner: an approval card led with the raw tool JSON, and the line Claude already writes
// for every Bash call ("description") was buried in it. The card, the Inbox row and the
// notification toast now share this one summary. No AI here: `source` marks whose words the
// line is ("agent" wrote it, "derived" is built from the input), the seam a later host
// service can fill with a model-written line.
//
// The content preview is cut by the server (300 chars for the claude-sdk hook), so JSON
// often arrives truncated. A truncated command is never trusted as read-only.

export type ApprovalRisk = "read" | "write" | "destructive";

export interface ApprovalSummary {
  text: string;
  /** Whose words `text` is: the agent's own description, or built from the input. */
  source: "agent" | "derived";
  risk: ApprovalRisk;
  kind: "command" | "edit";
  /** Working directory (Codex) or the edited file's folder (Claude edits). */
  cwd?: string;
  /** The command, or the diff or content of an edit. */
  code?: string;
  /** Short reason a destructive command is red, e.g. "discards work". */
  danger?: string;
}

export interface ApprovalSummaryInput {
  phase: string;
  contentPreview: string;
  codexCommand?: { command: string; cwd: string | null; reason: string | null } | null;
}

const DESTRUCTIVE: readonly (readonly [RegExp, string])[] = [
  [/\brm\b[^;&|\n]*\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$)/, "deletes files"],
  [/\bgit\s+(?:-C\s+\S+\s+)?reset\b[^;&|\n]*--hard/, "discards work"],
  [
    /\bgit\s+(?:-C\s+\S+\s+)?clean\b[^;&|\n]*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?=\s|$)/,
    "discards work",
  ],
  [
    /\bgit\s+(?:-C\s+\S+\s+)?push\b[^;&|\n]*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force(?:-with-lease)?|\+\S)(?=[\s=]|$)/,
    "rewrites remote",
  ],
  [/\bgit\s+(?:-C\s+\S+\s+)?branch\b[^;&|\n]*\s-[a-zA-Z]*D/, "deletes a branch"],
  [/\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/, "runs a downloaded script"],
  [/\bsudo\b/, "runs as admin"],
  [/\b(?:chmod|chown)\s+(?:-[a-zA-Z]*R|--recursive)/, "changes permissions"],
  [/\bmkfs\b|\bdd\s+if=/, "overwrites a disk"],
  [/\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE)\b/i, "drops data"],
  [/\bkill\s+-9\b|\bpkill\b|\bkillall\b/, "kills processes"],
  [
    /(?:>>?|\btee\b|\bcp\b|\bmv\b|\bln\b|\bsed\s+-i|\bchmod\b|\bchown\b)[^;&|\n]*(?:\/etc(?:\/|\b)|~\/\.ssh|\$HOME\/\.ssh|\/\.ssh\/)/,
    "touches system files",
  ],
];

const READ_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "grep", "rg", "find", "echo", "which",
  "stat", "du", "df", "file", "jq", "cd",
]); // prettier-ignore
const READ_GIT = new Set(["status", "log", "diff", "show", "branch"]);
const READ_GIT_BRANCH_ARGS = new Set([
  "-a", "-r", "-v", "-vv", "--list", "-l", "--show-current", "--all", "--remotes",
]); // prettier-ignore

function dangerOf(command: string): string | null {
  for (const [pattern, label] of DESTRUCTIVE) if (pattern.test(command)) return label;
  return null;
}

function segmentIsRead(segment: string): boolean {
  const words = segment.trim().split(/\s+/);
  let head = words[0] ?? "";
  let rest = words.slice(1);
  if (head === "git") {
    if (rest[0] === "-C") rest = rest.slice(2);
    head = rest[0] ?? "";
    rest = rest.slice(1);
    if (!READ_GIT.has(head) || rest.some((a) => a.startsWith("--output"))) return false;
    return head !== "branch" || rest.every((a) => READ_GIT_BRANCH_ARGS.has(a));
  }
  if (head === "sed") {
    return (
      rest[0] === "-n" &&
      !rest.some((w) => /^(-i\S*|--in-place\S*|--file\S*)$/.test(w)) &&
      !/(?:^|[^A-Za-z])[wWe](?:\s|\/|$)/.test(rest.slice(1).join(" "))
    );
  }
  if (!READ_COMMANDS.has(head)) return false;
  if (head === "find")
    return !rest.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(a));
  if (head === "rg") return !rest.some((a) => a.startsWith("--pre"));
  return true;
}

/**
 * Deterministic risk of a shell command. Never AI. When in doubt it classifies up:
 * write over read, destructive over write.
 */
export function classifyRisk(command: string): ApprovalRisk {
  if (dangerOf(command) !== null) return "destructive";
  // Harmless fd redirects (`2>&1`, `2>/dev/null`) are not output writes.
  const plain = command.replace(/\d?>&\d|\d?>\s*\/dev\/null/g, "");
  if (/>|\btee\b|\$\(|`|<\(/.test(plain)) return "write";
  const segments = plain.split(/&&|\|\||[;&|\n]/).filter((s) => s.trim() !== "");
  if (segments.length === 0) return "write";
  return segments.every(segmentIsRead) ? "read" : "write";
}

interface ParsedInput {
  fields: Record<string, unknown>;
  /** The preview was cut off, so values may be partial. */
  truncated: boolean;
}

function unescapeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

/** Parse `ToolName({...})` or a bare JSON object; pull string fields out of a cut-off body. */
function parseToolPreview(preview: string): { tool: string; input: ParsedInput } | null {
  const m = /^([A-Za-z_][\w.-]*)\((.*)$/s.exec(preview.trim());
  if (!m) return null;
  let body = m[2];
  if (body.endsWith(")")) body = body.slice(0, -1);
  if (body[0] !== "{") return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { tool: m[1], input: { fields: parsed as Record<string, unknown>, truncated: false } };
    }
    return null;
  } catch {
    const fields: Record<string, unknown> = {};
    const re = /"([A-Za-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)("?)/g;
    for (let hit = re.exec(body); hit !== null; hit = re.exec(body)) {
      fields[hit[1]] = unescapeJsonString(hit[2]);
    }
    return { tool: m[1], input: { fields, truncated: true } };
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const lineCount = (s: string): number => (s === "" ? 0 : s.split("\n").length);
const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const dirName = (p: string): string | undefined => {
  const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return cut > 0 ? p.slice(0, cut + 1) : undefined;
};
const prefixLines = (s: string, mark: string): string =>
  s
    .split("\n")
    .map((l) => `${mark} ${l}`)
    .join("\n");

function summarizeCommand(
  command: string,
  description: string | undefined,
  truncated: boolean,
  cwd?: string,
): ApprovalSummary {
  const danger = dangerOf(command);
  let risk = classifyRisk(command);
  if (truncated && risk === "read") risk = "write"; // the cut-off tail could be anything
  return {
    text: description ?? "Run a command",
    source: description ? "agent" : "derived",
    risk,
    kind: "command",
    cwd,
    code: command,
    ...(danger ? { danger } : {}),
  };
}

function summarizeEdit(tool: string, input: ParsedInput): ApprovalSummary | null {
  const { fields, truncated } = input;
  const path = str(fields.file_path) ?? str(fields.notebook_path);
  if (!path) return null;
  const name = baseName(path);
  const cwd = dirName(path);
  const base = { source: "derived" as const, risk: "write" as const, kind: "edit" as const, cwd };
  if (tool === "Write") {
    const content = str(fields.content) ?? "";
    return {
      ...base,
      text: truncated ? `Write ${name}` : `Write ${name} (${lineCount(content)} lines)`,
      code: content,
    };
  }
  if (tool === "NotebookEdit") {
    const src = str(fields.new_source) ?? "";
    return { ...base, text: `Edit notebook ${name}`, code: src };
  }
  const pairs: [string, string][] = Array.isArray(fields.edits)
    ? (fields.edits as Record<string, unknown>[]).map((e) => [
        str(e?.old_string) ?? "",
        str(e?.new_string) ?? "",
      ])
    : [[str(fields.old_string) ?? "", str(fields.new_string) ?? ""]];
  const diff = pairs
    .map(([o, n]) =>
      [o && prefixLines(o, "-"), n && prefixLines(n, "+")].filter(Boolean).join("\n"),
    )
    .join("\n");
  const removed = pairs.reduce((sum, [o]) => sum + lineCount(o), 0);
  const added = pairs.reduce((sum, [, n]) => sum + lineCount(n), 0);
  return {
    ...base,
    text: truncated ? `Edit ${name}` : `Edit ${name}: replace ${removed} lines with ${added}`,
    code: diff,
  };
}

/** The summary for a pending approval, or null when this kind of ask is not summarized. */
export function summarizeApproval(input: ApprovalSummaryInput): ApprovalSummary | null {
  const codex = input.codexCommand;
  if (codex) {
    const reason = str(codex.reason);
    return {
      ...summarizeCommand(codex.command, undefined, false, codex.cwd ?? undefined),
      text: reason ?? "Codex wants to run a command",
      source: reason ? "agent" : "derived",
    };
  }
  if (input.phase !== "pre_tool_use") return null;
  const parsed = parseToolPreview(input.contentPreview);
  if (!parsed) return null;
  const { tool, input: tin } = parsed;
  if (tool === "Bash") {
    const command = str(tin.fields.command);
    if (!command) return null;
    return summarizeCommand(command, str(tin.fields.description), tin.truncated);
  }
  if (tool === "Edit" || tool === "MultiEdit" || tool === "Write" || tool === "NotebookEdit") {
    return summarizeEdit(tool, tin);
  }
  return null;
}
