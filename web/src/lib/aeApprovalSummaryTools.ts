// Summary lines for approvals that are not a shell command or a file edit (2026-11-27).
// The owner: only Bash, Edit and Codex commands led with a plain line; an MCP call, a
// WebFetch, a Codex patch or an Antigravity ask still showed raw JSON. Everything here is
// deterministic text built from the tool name and its arguments. No AI. A value under a
// key that looks secret is never put in a line.

export type ToolRisk = "read" | "write" | "destructive";

export interface ToolLine {
  text: string;
  /** "agent": the agent's own reason; "derived": built from the tool and its arguments. */
  source: "agent" | "derived";
  risk: ToolRisk;
  danger?: string;
}

type Fields = Record<string, unknown>;

const MAX_VALUE_CHARS = 60;
const MAX_AGENT_CHARS = 200;
const SECRET_KEY = /token|secret|passw|key|auth|cookie|credential/i;
// The agent's own justification for a call. `description` is not here: on an MCP tool it is
// usually the content (a ticket's description), not a reason.
const AGENT_KEYS = ["reason", "justification", "rationale", "explanation"] as const;
const TELLING_KEYS = ["to", "subject", "title", "name", "path", "url", "query", "id"] as const;
// The obvious main argument of any other tool, in order of preference.
const PRIMARY_KEYS = [
  "file_path", "path", "url", "query", "pattern", "name", "title", "subject", "to", "id",
] as const; // prettier-ignore

const DESTRUCTIVE_VERBS: Record<string, string> = {
  delete: "deletes data",
  remove: "deletes data",
  drop: "drops data",
  purge: "purges data",
  force: "forces the action",
};
const WRITE_VERBS = new Set(["send", "post", "publish", "merge", "pay", "transfer"]);
const READ_VERBS = new Set(["get", "list", "search", "read", "fetch", "view"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** `send_email` or `sendEmail` as lowercase words: ["send", "email"]. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function inWords(name: string): string {
  const text = words(name).join(" ");
  return text === "" ? name : text.charAt(0).toUpperCase() + text.slice(1);
}

/** Deterministic risk of a non-command tool from the verbs in its name. Unknown is write. */
export function classifyToolName(name: string): { risk: ToolRisk; danger?: string } {
  const verbs = words(name);
  const hit = verbs.find((w) => w in DESTRUCTIVE_VERBS);
  if (hit) return { risk: "destructive", danger: DESTRUCTIVE_VERBS[hit] };
  if (verbs.some((w) => WRITE_VERBS.has(w))) return { risk: "write" };
  if (verbs.some((w) => READ_VERBS.has(w))) return { risk: "read" };
  return { risk: "write" };
}

/** A printable value for a line: a short string or a number, or nothing. */
function shown(key: string, value: unknown): string | undefined {
  if (SECRET_KEY.test(key)) return undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const s = str(value);
  return s === undefined ? undefined : cut(s.replace(/\s+/g, " ").trim(), MAX_VALUE_CHARS);
}

function telling(fields: Fields, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = shown(key, fields[key]);
    if (v !== undefined) return `${key}: ${v}`;
  }
  return undefined;
}

/** The agent's own reason on the tool input or elicitation params, if it wrote one. */
export function agentReason(fields: Fields): string | undefined {
  for (const key of AGENT_KEYS) {
    const v = str(fields[key]);
    if (v) return cut(v.replace(/\s+/g, " ").trim(), MAX_AGENT_CHARS);
  }
  return undefined;
}

function hostAndPath(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  if (!m) return cut(url, MAX_VALUE_CHARS);
  const path = m[2] === "/" ? "" : m[2];
  return cut(`${m[1]}${path}`, MAX_VALUE_CHARS);
}

const MCP_NAME = /^mcp__(.+?)__(.+)$/;

export function mcpLine(server: string, tool: string, fields: Fields): ToolLine {
  const { risk, danger } = classifyToolName(tool);
  const reason = agentReason(fields);
  const arg = telling(fields, TELLING_KEYS);
  return {
    text: reason ?? `${inWords(tool)} via ${server}${arg ? ` (${arg})` : ""}`,
    source: reason ? "agent" : "derived",
    risk,
    ...(danger ? { danger } : {}),
  };
}

/** Plain, read-only built-ins of Claude Code. */
const READ_BUILTINS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite"]);

/**
 * The line for a tool call that is not a shell command or a file edit: a Claude built-in,
 * an MCP tool, or any other harness tool. `fields` are its parsed arguments.
 */
export function deriveToolLine(tool: string, fields: Fields): ToolLine {
  const mcp = MCP_NAME.exec(tool);
  if (mcp) return mcpLine(mcp[1], mcp[2], fields);
  const reason = agentReason(fields);
  const line = (text: string, risk: ToolRisk, danger?: string): ToolLine => ({
    text: reason ?? text,
    source: reason ? "agent" : "derived",
    risk,
    ...(danger ? { danger } : {}),
  });
  const url = str(fields.url);
  const query = str(fields.query);
  const pattern = str(fields.pattern);
  const path = str(fields.file_path) ?? str(fields.path);
  const desc = str(fields.description);
  switch (tool) {
    case "WebFetch":
      return line(url ? `Fetch ${hostAndPath(url)}` : "Fetch a web page", "read");
    case "WebSearch":
      return line(
        query ? `Search the web for ${cut(query, MAX_VALUE_CHARS)}` : "Search the web",
        "read",
      );
    case "Task":
    case "Agent":
      return line(desc ? `Start a helper: ${cut(desc, 100)}` : "Start a helper", "write");
    case "Read":
      return line(path ? `Read ${baseName(path)}` : "Read a file", "read");
    case "Glob":
      return line(
        pattern ? `Find files matching ${cut(pattern, MAX_VALUE_CHARS)}` : "Find files",
        "read",
      );
    case "Grep":
      return line(
        pattern
          ? `Search for ${cut(pattern, MAX_VALUE_CHARS)}${path ? ` in ${baseName(path)}` : ""}`
          : "Search files",
        "read",
      );
    case "TodoWrite": {
      const n = Array.isArray(fields.todos) ? fields.todos.length : 0;
      return line(n > 0 ? `Update the to-do list (${n} items)` : "Update the to-do list", "read");
    }
    default: {
      const { risk, danger } = READ_BUILTINS.has(tool)
        ? { risk: "read" as ToolRisk, danger: undefined }
        : classifyToolName(tool);
      const primary = telling(fields, PRIMARY_KEYS);
      return line(
        `Use ${inWords(tool).toLowerCase()}${primary ? ` (${primary})` : ""}`,
        risk,
        danger,
      );
    }
  }
}

/** The files a Codex patch touches, from a changes dict or list, sorted. */
function patchFiles(fields: Fields): string[] {
  for (const key of ["files", "fileChanges", "changes"]) {
    const v = fields[key];
    if (Array.isArray(v)) {
      const names = v.map((e) =>
        typeof e === "string" ? e : (str((e as Fields | null)?.path) ?? ""),
      );
      const out = names.filter(Boolean);
      if (out.length > 0) return out.sort();
    } else if (v && typeof v === "object") {
      const out = Object.keys(v as Fields);
      if (out.length > 0) return out.sort();
    }
  }
  return [];
}

function permissionNames(fields: Fields): string[] {
  const p = fields.permissions;
  return p && typeof p === "object" && !Array.isArray(p)
    ? Object.keys(p as Fields).map((k) => words(k).join(" "))
    : [];
}

/** A Codex file-change, apply-patch or permissions approval (no tool name, raw params). */
export function deriveCodexLine(phase: string, fields: Fields): ToolLine | null {
  const reason = agentReason(fields);
  const make = (text: string, risk: ToolRisk = "write"): ToolLine => ({
    text: reason ?? text,
    source: reason ? "agent" : "derived",
    risk,
  });
  if (phase === "codex_file_change_approval" || phase === "codex_apply_patch_approval") {
    const files = patchFiles(fields);
    const root = str(fields.grantRoot) ?? str(fields.grant_root);
    if (files.length > 0) {
      const shownFiles = files.slice(0, 3).map(baseName).join(", ");
      const more = files.length > 3 ? ` and ${files.length - 3} more` : "";
      return make(
        `Change ${files.length} ${files.length === 1 ? "file" : "files"}: ${shownFiles}${more}`,
      );
    }
    return make(root ? `Allow writes under ${cut(root, MAX_VALUE_CHARS)}` : "Change files");
  }
  if (phase === "codex_permissions_approval") {
    const names = permissionNames(fields);
    const scope = str(fields.cwd) ?? "this turn";
    return make(
      `Grant ${names.length > 0 ? names.join(" and ") : "extra"} access for ${cut(scope, MAX_VALUE_CHARS)}`,
    );
  }
  if (phase === "codex_mcp_elicitation") {
    const meta = (fields["_meta"] ?? {}) as Fields;
    const server = str(fields.serverName) ?? str(fields.server_name);
    const tool = str(meta.tool_title) ?? str(meta.tool_name);
    if (server && tool) {
      const args = (meta.tool_params ?? {}) as Fields;
      return mcpLine(server, tool, { ...args, ...(reason ? { reason } : {}) });
    }
  }
  return null;
}

/** A message the policy or harness wrote, as one plain line (markdown marks removed). */
export function plainMessage(message: string | undefined): string | undefined {
  // Only the bridges' own "<who> wants to call **<tool>**" markers are removed; a policy's
  // message can carry a command with literal asterisks, which stays as written.
  const first = (message ?? "")
    .replace(/^(.{1,40}? wants (?:to \w+|write access under)) \*\*([^*\n]+)\*\*/, "$1 $2")
    .split("\n")[0]
    .trim();
  return first === "" ? undefined : cut(first, 160);
}

/** Who is asking, for the last-resort line. */
export function askerLabel(policyName: string, phase: string): string {
  const p = `${policyName} ${phase}`;
  if (/\bagy_|^agy_/.test(p) || policyName.startsWith("agy_")) return "Antigravity";
  if (policyName.startsWith("codex_") || phase.startsWith("codex_")) return "Codex";
  if (policyName.startsWith("cursor_") || phase.startsWith("cursor_")) return "Cursor";
  if (policyName.startsWith("claude_")) return "Claude";
  const sdk = /^(.+)_sdk_permission$/.exec(policyName);
  if (sdk) return sdk[1].charAt(0).toUpperCase() + sdk[1].slice(1);
  return "The agent";
}

export { inWords as toolInWords };
