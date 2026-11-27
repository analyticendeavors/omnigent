// Summary lines for approvals that are not a shell command or a file edit (2026-11-27).
// The owner: only Bash, Edit and Codex commands led with a plain line; an MCP call, a
// WebFetch, a Codex patch or an Antigravity ask still showed raw JSON. Everything here is
// deterministic text built from the tool name and its arguments. No AI.
//
// Attacker model: a prompt-injected agent or a malicious MCP server picks the tool name, the
// argument keys and values, and any reason text. "read" is the quiet one-line class, so it is
// handed out only when the name starts with a read verb and nothing in it, or in the
// arguments, can change or send anything. When unsure, write.

export type ToolRisk = "read" | "write" | "destructive";

export interface ToolLine {
  /** Always built from the tool and its arguments, never from the agent's own words. */
  text: string;
  /** The agent's own reason, scrubbed; shown on a separate "Agent says" line. */
  agentText?: string;
  /** Card heading naming the tool. */
  title?: string;
  source: "agent" | "derived";
  risk: ToolRisk;
  danger?: string;
}

type Fields = Record<string, unknown>;
interface Class {
  risk: ToolRisk;
  danger?: string;
}

const MAX_VALUE_CHARS = 60;
const MAX_AGENT_CHARS = 120;
const MAX_HOST_CHARS = 40;
const SECRET_KEY = /token|secret|passw|pwd|key|auth|cookie|session|bearer|credential/i;
// The agent's own justification for a call.
const AGENT_KEYS = ["reason", "justification", "rationale", "explanation"] as const;
const TELLING_KEYS = ["to", "subject", "title", "name", "path", "url", "query", "id"] as const;
// The obvious main argument of any other tool, in order of preference.
const PRIMARY_KEYS = [
  "file_path", "path", "url", "query", "pattern", "name", "title", "subject", "to", "id",
] as const; // prettier-ignore
const BODY_KEYS = /^(body|data|payload|json|form)$/i;

const READ_VERBS = new Set([
  "get", "list", "search", "read", "view", "show", "find", "describe", "count", "query",
  "lookup", "inspect", "status",
]); // prettier-ignore
const WRITE_WORDS = new Set([
  "create", "update", "set", "write", "edit", "replace", "move", "rename", "archive",
  "execute", "exec", "run", "invoke", "upload", "insert", "upsert", "patch", "put", "apply",
  "approve", "grant", "revoke", "share", "invite", "add", "send", "post", "publish", "merge",
  "pay", "transfer", "deploy", "cancel", "disable", "enable", "install", "close", "open",
  "assign", "comment", "reply", "submit", "sync", "import", "export", "fetch",
]); // prettier-ignore
const DESTRUCTIVE_WORDS: Record<string, string> = {
  delete: "deletes data",
  remove: "deletes data",
  drop: "drops data",
  purge: "purges data",
  force: "forces the action",
  destroy: "destroys data",
  wipe: "wipes data",
  erase: "erases data",
  clear: "clears data",
  reset: "resets data",
  kill: "kills processes",
  truncate: "truncates data",
  terminate: "terminates it",
  uninstall: "uninstalls it",
  unlink: "unlinks data",
  rm: "deletes data",
  rmdir: "deletes data",
  overwrite: "overwrites data",
};
// A name with one of these talks to the network, so it is never a quiet read.
const NETWORK_WORDS = new Set(["fetch", "http", "https", "url", "urls", "web", "curl"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

// ---- scrub: nothing secret-shaped reaches a line, the Inbox row or an OS toast ----

const SECRET_WORD = "token|secret|password|passwd|pwd|key|auth|cookie|session|bearer|credential";
const KEY_VALUE = new RegExp(
  `\\b([A-Za-z0-9_-]*(?:${SECRET_WORD})[A-Za-z0-9_-]*)\\s*[=:]\\s*("[^"]*"|'[^']*'|[^\\s)]+)`,
  "gi",
);
const TOKEN_SHAPES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bsk[-_][A-Za-z0-9_-]{6,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{4,}/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bBearer\s+\S+/gi,
];
const LONG_RUN = /[A-Za-z0-9_\-+/=]{32,}/g;

/** Removes URL userinfo, secret key=value pairs and token-shaped strings from shown text. */
export function scrub(text: string): string {
  let out = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, "$1");
  out = out.replace(KEY_VALUE, (_m, key: string) => `${key}=…`);
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, "[redacted]");
  return out.replace(LONG_RUN, (run) =>
    /[A-Za-z]/.test(run) && /\d/.test(run) ? "[redacted]" : run,
  );
}

// ---- URLs: the host is always shown, shortened from the left ----

const TWO_PART_TLD = /^(co|com|org|net|ac|gov|edu)\.[a-z]{2}$/i;
const URL_RE =
  /\b([a-z][a-z0-9+.-]*):\/\/(?:([^/?#@\s]*)@)?(\[[^\]\s]+\]|[^/?#:\s]+)(?::\d+)?([^?#\s]*)([?#]\S*)?/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

interface ParsedUrl {
  host: string;
  path: string;
  /** Query, fragment or userinfo present, so data can ride along. */
  carries: boolean;
}

function parseUrl(text: string): ParsedUrl | null {
  const m = URL_RE.exec(text);
  if (!m) return null;
  return {
    host: m[3].toLowerCase(),
    path: m[4] === "/" ? "" : m[4],
    carries: Boolean(m[2]) || Boolean(m[5]),
  };
}

/** The host with the registrable domain always kept: "…aaaa.attacker.example". */
export function shortHost(host: string): string {
  if (host.length <= MAX_HOST_CHARS) return host;
  const labels = host.split(".");
  const tail = TWO_PART_TLD.test(labels.slice(-2).join(".")) ? 3 : 2;
  let kept = labels.slice(-tail);
  for (let i = labels.length - tail - 1; i >= 0; i--) {
    if ([labels[i], ...kept].join(".").length > MAX_HOST_CHARS) break;
    kept = [labels[i], ...kept];
  }
  const out = kept.join(".");
  return kept.length < labels.length ? `…${out}` : out;
}

/** "host/path", with "(sends query data)" when the URL carries a query, fragment or userinfo. */
function urlLine(url: string): string | null {
  const u = parseUrl(url);
  if (!u) return null;
  return `${shortHost(u.host)}${cut(scrub(u.path), 40)}${u.carries ? " (sends query data)" : ""}`;
}

const isLocal = (host: string): boolean => LOCAL_HOSTS.has(host);

/** The first non-local URL host found in any text argument, one level deep. */
function remoteHostIn(fields: Fields): string | undefined {
  const scan = (obj: Fields, depth: number): string | undefined => {
    for (const [key, v] of Object.entries(obj)) {
      if (SECRET_KEY.test(key)) continue;
      if (typeof v === "string") {
        const u = parseUrl(v);
        if (u && !isLocal(u.host)) return u.host;
      } else if (depth === 0 && v && typeof v === "object" && !Array.isArray(v)) {
        const hit = scan(v as Fields, 1);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return scan(fields, 0);
}

/** Arguments that send data out: a body, or a method other than GET and HEAD. */
function sendsData(fields: Fields): boolean {
  const method = str(fields.method);
  if (method && !/^(get|head)$/i.test(method)) return true;
  return Object.keys(fields).some((k) => BODY_KEYS.test(k));
}

// ---- names ----

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

const RANK: Record<ToolRisk, number> = { read: 0, write: 1, destructive: 2 };
export const worseRisk = (a: ToolRisk, b: ToolRisk): ToolRisk => (RANK[a] >= RANK[b] ? a : b);

/**
 * Deterministic risk of a non-command tool from the words in its name. Destructive beats
 * write beats read; "read" needs a read verb FIRST and nothing mutating anywhere else in the
 * name. Unknown is write.
 */
export function classifyToolName(name: string): Class {
  const w = words(name);
  const hit = w.find((x) => x in DESTRUCTIVE_WORDS);
  if (hit) return { risk: "destructive", danger: DESTRUCTIVE_WORDS[hit] };
  if (w.some((x) => WRITE_WORDS.has(x))) return { risk: "write" };
  if (w.length > 0 && READ_VERBS.has(w[0])) return { risk: "read" };
  return { risk: "write" };
}

/** Name risk, raised to write by a network name, a remote URL or a body in the arguments. */
function toolRisk(name: string, fields: Fields): Class {
  const base = classifyToolName(name);
  if (base.risk !== "read") return base;
  if (words(name).some((x) => NETWORK_WORDS.has(x))) return { risk: "write" };
  if (remoteHostIn(fields) !== undefined || sendsData(fields)) return { risk: "write" };
  return base;
}

// ---- values and agent text ----

/** A printable value for a line: a short scrubbed string or a number, or nothing. */
function shown(key: string, value: unknown): string | undefined {
  if (SECRET_KEY.test(key)) return undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const s = str(value);
  if (s === undefined) return undefined;
  return urlLine(s) ?? cut(scrub(oneLine(s)), MAX_VALUE_CHARS);
}

function telling(fields: Fields, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = shown(key, fields[key]);
    if (v !== undefined) return `${key}: ${v}`;
  }
  return undefined;
}

/** The agent's own reason on the tool input or elicitation params, scrubbed, if it wrote one. */
export function agentReason(fields: Fields, withDescription = false): string | undefined {
  const keys = withDescription ? [...AGENT_KEYS, "description"] : AGENT_KEYS;
  for (const key of keys) {
    const v = str(fields[key]);
    if (v) return cut(scrub(oneLine(v)), MAX_AGENT_CHARS);
  }
  return undefined;
}

const MCP_NAME = /^mcp__(.+?)__(.+)$/;
const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Where the data goes, for a tool that carries a remote URL in an argument. */
function destination(fields: Fields, arg?: string): string {
  const host = remoteHostIn(fields);
  if (!host || arg?.includes(shortHost(host))) return "";
  return ` (to ${shortHost(host)})`;
}

export function mcpLine(server: string, tool: string, fields: Fields): ToolLine {
  const { risk, danger } = toolRisk(tool, fields);
  const arg = telling(fields, TELLING_KEYS);
  const agentText = agentReason(fields);
  return {
    text: `${inWords(tool)} via ${scrub(server)}${arg ? ` (${arg})` : ""}${destination(fields, arg)}`,
    ...(agentText ? { agentText } : {}),
    title: `${titleCase(scrub(server))}: ${inWords(tool).toLowerCase()}`,
    source: "derived",
    risk,
    ...(danger ? { danger } : {}),
  };
}

/**
 * The line for a tool call that is not a shell command or a file edit: a Claude built-in,
 * an MCP tool, or any other harness tool. `fields` are its parsed arguments.
 */
export function deriveToolLine(tool: string, fields: Fields): ToolLine {
  const mcp = MCP_NAME.exec(tool);
  if (mcp) return mcpLine(mcp[1], mcp[2], fields);
  const desc = str(fields.description);
  const agentText = agentReason(fields, tool !== "Task" && tool !== "Agent");
  const line = (text: string, c: Class): ToolLine => ({
    text,
    ...(agentText ? { agentText } : {}),
    title: scrub(inWords(tool)),
    source: "derived",
    risk: c.risk,
    ...(c.danger ? { danger: c.danger } : {}),
  });
  const url = str(fields.url);
  const query = str(fields.query);
  const pattern = str(fields.pattern);
  const path = str(fields.file_path) ?? str(fields.path);
  switch (tool) {
    case "WebFetch": {
      const where = url ? urlLine(url) : null;
      const local = url !== undefined && isLocal(parseUrl(url)?.host ?? "");
      return line(where ? `Fetch ${where}` : "Fetch a web page", {
        risk: local ? "read" : "write",
      });
    }
    case "WebSearch":
      return line(
        query ? `Search the web for ${cut(scrub(query), MAX_VALUE_CHARS)}` : "Search the web",
        { risk: "read" },
      );
    case "Task":
    case "Agent":
      return line(desc ? `Start a helper: ${cut(scrub(oneLine(desc)), 100)}` : "Start a helper", {
        risk: "write",
      });
    case "Read":
      return line(path ? `Read ${cut(scrub(baseName(path)), MAX_VALUE_CHARS)}` : "Read a file", {
        risk: "read",
      });
    case "Glob":
      return line(
        pattern ? `Find files matching ${cut(scrub(pattern), MAX_VALUE_CHARS)}` : "Find files",
        { risk: "read" },
      );
    case "Grep": {
      const where = path ? ` in ${cut(scrub(baseName(path)), MAX_VALUE_CHARS)}` : "";
      return line(
        pattern ? `Search for ${cut(scrub(pattern), MAX_VALUE_CHARS)}${where}` : "Search files",
        { risk: "read" },
      );
    }
    case "TodoWrite": {
      const n = Array.isArray(fields.todos) ? fields.todos.length : 0;
      return line(n > 0 ? `Update the to-do list (${n} items)` : "Update the to-do list", {
        risk: "read",
      });
    }
    default: {
      const primary = telling(fields, PRIMARY_KEYS);
      return line(
        `Use ${inWords(tool).toLowerCase()}${primary ? ` (${primary})` : ""}${destination(fields, primary)}`,
        toolRisk(tool, fields),
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

/** A Codex file-change, apply-patch, permissions or MCP approval (no tool name, raw params). */
export function deriveCodexLine(phase: string, fields: Fields): ToolLine | null {
  const agentText = agentReason(fields);
  const make = (text: string, title: string): ToolLine => ({
    text,
    ...(agentText ? { agentText } : {}),
    title,
    source: "derived",
    risk: "write",
  });
  if (phase === "codex_file_change_approval" || phase === "codex_apply_patch_approval") {
    const files = patchFiles(fields);
    const root = str(fields.grantRoot) ?? str(fields.grant_root);
    if (files.length > 0) {
      const shownFiles = files
        .slice(0, 3)
        .map((f) => scrub(baseName(f)))
        .join(", ");
      const more = files.length > 3 ? ` and ${files.length - 3} more` : "";
      return make(
        `Change ${files.length} ${files.length === 1 ? "file" : "files"}: ${shownFiles}${more}`,
        "Change files",
      );
    }
    return make(
      root ? `Allow writes under ${cut(scrub(root), MAX_VALUE_CHARS)}` : "Change files",
      "Change files",
    );
  }
  if (phase === "codex_permissions_approval") {
    const names = permissionNames(fields);
    const scope = str(fields.cwd) ?? "this turn";
    return make(
      `Grant ${names.length > 0 ? names.join(" and ") : "extra"} access for ${cut(scrub(scope), MAX_VALUE_CHARS)}`,
      "Grant access",
    );
  }
  if (phase === "codex_mcp_elicitation") {
    const meta = (fields["_meta"] ?? {}) as Fields;
    const server = str(fields.serverName) ?? str(fields.server_name);
    const name = str(meta.tool_name);
    const title = str(meta.tool_title);
    const shownName = title ?? name;
    if (server && shownName) {
      const args = (meta.tool_params ?? {}) as Fields;
      const line = mcpLine(server, shownName, {
        ...args,
        ...(agentText ? { reason: agentText } : {}),
      });
      // The title is a label the server chose; the name is what runs. Take the worse risk.
      let worst: Class = { risk: line.risk, danger: line.danger };
      for (const label of [name, title]) {
        if (!label) continue;
        const c = toolRisk(label, args);
        if (RANK[c.risk] > RANK[worst.risk]) worst = c;
      }
      return { ...line, risk: worst.risk, ...(worst.danger ? { danger: worst.danger } : {}) };
    }
  }
  return null;
}

/** An Antigravity permission ask that is not a command: a file write, a fetch, or unknown. */
export function deriveAgyLine(action: string | undefined, target: string | undefined): ToolLine {
  const a = (action ?? "").toLowerCase();
  const t = target ? cut(scrub(oneLine(target)), MAX_VALUE_CHARS) : undefined;
  if (/url|fetch|web|browse|http/.test(a)) {
    const where = target ? urlLine(target) : null;
    return {
      text: where ? `Antigravity wants to fetch ${where}` : "Antigravity wants to fetch a page",
      title: "Fetch a page",
      source: "derived",
      risk: "write",
    };
  }
  if (/write|edit|create|file/.test(a)) {
    return {
      text: t ? `Antigravity wants to write ${t}` : "Antigravity wants to write a file",
      title: "Write a file",
      source: "derived",
      risk: "write",
    };
  }
  return {
    text: t
      ? `Antigravity wants to ${cut(scrub(oneLine(a || "act")), 20)}: ${t}`
      : "Antigravity wants approval",
    title: "Approval needed",
    source: "derived",
    risk: "write",
  };
}

/** A message the policy or harness wrote, as one scrubbed line. */
export function plainMessage(message: string | undefined): string | undefined {
  // Only the bridges' own "<who> wants to call **<tool>**" markers are removed; a policy's
  // message can carry a command with literal asterisks, which stays as written.
  const first = (message ?? "")
    .replace(/^(.{1,40}? wants (?:to \w+|write access under)) \*\*([^*\n]+)\*\*/, "$1 $2")
    .split("\n")[0]
    .trim();
  return first === "" ? undefined : cut(scrub(first), 160);
}

/** Who is asking, for the last-resort line. */
export function askerLabel(policyName: string, phase: string): string {
  if (policyName.startsWith("agy_") || phase.startsWith("agy_")) return "Antigravity";
  if (policyName.startsWith("codex_") || phase.startsWith("codex_")) return "Codex";
  if (policyName.startsWith("cursor_") || phase.startsWith("cursor_")) return "Cursor";
  if (policyName.startsWith("claude_")) return "Claude";
  const sdk = /^(.+)_sdk_permission$/.exec(policyName);
  if (sdk) return sdk[1].charAt(0).toUpperCase() + sdk[1].slice(1);
  return "The agent";
}
