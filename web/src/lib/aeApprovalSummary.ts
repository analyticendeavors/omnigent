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
  /** The command preview was cut off, so its tail is unseen. */
  truncated?: boolean;
}

export interface ApprovalSummaryInput {
  phase: string;
  contentPreview: string;
  codexCommand?: { command: string; cwd: string | null; reason: string | null } | null;
}

// Git's global options (`-c k=v`, `-C path`, ...) sit between `git` and the subcommand; drop
// them before matching a subcommand so `git -c x=y reset --hard` is still caught.
const GIT_GLOBALS =
  /\bgit(?:\s+(?:-[Cc]\s+\S+|--(?:git-dir|work-tree|namespace)(?:=|\s+)\S+|--exec-path(?:=\S+)?|--no-pager|--bare|-P))+\s+/g;
const CMD_START = String.raw`(?:^|[\s;&|('"\x60/])`;

const DESTRUCTIVE: readonly (readonly [RegExp, string])[] = [
  [new RegExp(`${CMD_START}rm(?=\\s|$)`), "deletes files"],
  [/\bfind\b[^;&|\n]*\s-(?:delete|(?:exec|execdir|ok|okdir)\s+\S*rm)(?=\s|$)/, "deletes files"],
  [new RegExp(`${CMD_START}(?:shred|truncate)(?=\\s|$)`), "overwrites files"],
  [/\bgit\s+reset\b[^;&|\n]*\s--(?:hard|keep|merge)\b/, "discards work"],
  [/\bgit\s+clean\b[^;&|\n]*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?=\s|$)/, "discards work"],
  [/\bgit\s+checkout\b[^;&|\n]*(?:\s--|\s\.)(?=\s|$)/, "discards work"],
  [/\bgit\s+restore\b/, "discards work"],
  [/\bgit\s+stash\s+(?:drop|clear)\b/, "discards work"],
  [
    /\bgit\s+push\b[^;&|\n]*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force(?:-with-lease)?|--delete|-d|\+\S|:\S+)(?=[\s=]|$)/,
    "rewrites remote",
  ],
  [/\bgit\s+branch\b[^;&|\n]*\s-[a-zA-Z]*D/, "deletes a branch"],
  [/\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/, "runs a downloaded script"],
  [/\bsudo\b/, "runs as admin"],
  [/\b(?:chmod|chown)\s+(?:-[a-zA-Z]*R|--recursive)/, "changes permissions"],
  [/\bmkfs\b|\bdd\s+if=/, "overwrites a disk"],
  [/\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE)\b/i, "drops data"],
  [
    /\bkill\s+(?:-9|-KILL|-SIGKILL|-s\s+(?:KILL|SIGKILL|9))\b|\bpkill\b|\bkillall\b/,
    "kills processes",
  ],
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
const READ_GIT_BRANCH_ARGS = new Set(["-a", "-r", "-v", "-vv", "--list"]);
const GIT_BLOCKED_ARGS = [
  "--output",
  "--ext-diff",
  "--textconv",
  "--exec-path",
  "--git-dir",
  "--work-tree",
];
const FIND_FLAGS = new Set([
  "-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth", "-mtime", "-mmin",
  "-newer", "-size", "-print", "-not", "-o", "-a", "-empty", "-regex", "-iregex",
]); // prettier-ignore
// A token with no quote, backslash, glob, expansion or redirect character, so the shell
// passes it on exactly as written and the flag checks below see what really runs.
const SAFE_TOKEN = /^(?:~(?:\/[A-Za-z0-9_./:=,@%+-]*)?|[A-Za-z0-9_./:=,@%+-]+)$/;
const SED_PRINT = /^\$?\d*(?:,(?:\d+|\$))?p$/;

function dangerOf(command: string): string | null {
  const norm = command.replace(GIT_GLOBALS, "git ");
  for (const [pattern, label] of DESTRUCTIVE) if (pattern.test(norm)) return label;
  return null;
}

/** `sed -n <line or range>p <files>` and nothing else: no write, execute or script-file forms. */
function sedIsRead(tokens: string[]): boolean {
  const [, flag, script, ...files] = tokens;
  if (flag !== "-n" || script === undefined) return false;
  const quoted = /^(['"])(.*)\1$/.exec(script);
  const body = quoted ? quoted[2] : script;
  if (quoted?.[1] !== "'" && body.includes("$")) return false; // the shell would expand it
  return SED_PRINT.test(body) && files.every((f) => SAFE_TOKEN.test(f) && !f.startsWith("-"));
}

function gitIsRead(rest: string[]): boolean {
  let i = 0;
  while (i < rest.length && rest[i].startsWith("-")) {
    if (rest[i] === "-C") i += 2;
    else if (rest[i] === "--no-pager") i += 1;
    else return false;
  }
  const sub = rest[i];
  const args = rest.slice(i + 1);
  if (sub === undefined || !READ_GIT.has(sub)) return false;
  if (args.some((a) => a === "-c" || GIT_BLOCKED_ARGS.some((b) => a.startsWith(b)))) return false;
  return sub !== "branch" || args.every((a) => READ_GIT_BRANCH_ARGS.has(a));
}

function segmentIsRead(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/);
  if (tokens[0] === "sed") return sedIsRead(tokens);
  if (!tokens.every((t) => SAFE_TOKEN.test(t))) return false;
  const [head, ...rest] = tokens;
  if (head === "git") return gitIsRead(rest);
  if (!READ_COMMANDS.has(head)) return false;
  if (head === "find") return rest.every((a) => !a.startsWith("-") || FIND_FLAGS.has(a));
  if (head === "rg")
    return !rest.some((a) => a.startsWith("--pre") || a.startsWith("--hostname-bin"));
  if (head === "file") return !rest.some((a) => /^(-[a-zA-Z]*C|--compile)/.test(a));
  return true;
}

/**
 * Deterministic risk of a shell command. Never AI. When in doubt it classifies up:
 * write over read, destructive over write.
 */
export function classifyRisk(command: string): ApprovalRisk {
  if (dangerOf(command) !== null) return "destructive";
  // Only a complete fd duplication (`2>&1`) or a write to /dev/null is harmless; any other
  // `>` is an output write, and `>&2024-report.md` is a file named 2024-report.md.
  const plain = command
    .replace(/\d?>&(?:\d+|-)(?=\s|$|[;&|])/g, "")
    .replace(/\d?>\s*\/dev\/null(?=\s|$|[;&|])/g, "");
  if (/>|\btee\b|\$\(|`|<\(/.test(plain)) return "write";
  const segments = plain.split(/&&|\|\||[;&|\n]/).filter((s) => s.trim() !== "");
  if (segments.length === 0) return "write";
  return segments.every(segmentIsRead) ? "read" : "write";
}

interface ParsedInput {
  fields: Record<string, unknown>;
  /** The preview was cut off, so values may be partial. */
  truncated: boolean;
  /** The preview body as received, for counting keys a cut-off scan cannot rebuild. */
  raw: string;
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
      return {
        tool: m[1],
        input: { fields: parsed as Record<string, unknown>, truncated: false, raw: body },
      };
    }
    return null;
  } catch {
    const fields: Record<string, unknown> = {};
    const re = /"([A-Za-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)("?)/g;
    for (let hit = re.exec(body); hit !== null; hit = re.exec(body)) {
      fields[hit[1]] = unescapeJsonString(hit[2]);
    }
    return { tool: m[1], input: { fields, truncated: true, raw: body } };
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
    ...(truncated ? { truncated: true } : {}),
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
      code: truncated ? `${content}\n(preview cut off)` : content,
    };
  }
  if (tool === "NotebookEdit") {
    const src = str(fields.new_source) ?? "";
    return {
      ...base,
      text: `Edit notebook ${name}`,
      code: truncated ? `${src}\n(preview cut off)` : src,
    };
  }
  if (truncated && tool === "MultiEdit") {
    // A cut-off scan cannot rebuild the edits array, so say how many places and show no diff.
    const places = Math.max(1, (input.raw.match(/"old_string"\s*:/g) ?? []).length);
    return { ...base, text: `Edit ${places} places in ${name}` };
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
    code: truncated ? `${diff}\n(preview cut off)` : diff,
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
