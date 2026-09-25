// [ae] Run-on-box: the pure half of the Run button on chat code blocks.
//
// A session on a host with shells can reply with a command block; the Run
// button pastes that block into one of the session's own shells. Everything
// here is pure so it can be tested without a DOM or a terminal:
//
//   - which blocks get a Run button (a shell fence, or an untagged block that
//     reads as commands),
//   - the exact text that will be sent (a `$ ` prompt is stripped),
//   - whether Enter may follow the paste (never while a heredoc, a quote or a
//     line continuation is still open),
//   - the dangerous constructs the confirm sheet names (sudo, rm -rf,
//     curl | sh, dd).
//
// The transport half is `aeTerminalInput.ts`; the button is
// `components/AeRunCodeButton.tsx`.

/** Fence languages that always get a Run button. */
export const AE_RUN_SHELL_LANGUAGES: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "console",
  "powershell",
]);

/** Language of a Streamdown `<code>` element from its `language-*` class, or null. */
export function codeBlockLanguage(className: string | undefined | null): string | null {
  if (!className) return null;
  for (const cls of className.split(/\s+/)) {
    if (cls.startsWith("language-")) {
      const lang = cls.slice("language-".length).toLowerCase();
      return lang === "" ? null : lang;
    }
  }
  return null;
}

// First words that make an untagged block read as a command. Deliberately a
// list of real command names rather than a "looks like a word" rule: an
// untagged block of prose, JSON, YAML or code must not grow a Run button.
const COMMAND_WORDS: ReadonlySet<string> = new Set([
  "apt",
  "apt-get",
  "aws",
  "awk",
  "az",
  "bash",
  "brew",
  "cargo",
  "cat",
  "cd",
  "chmod",
  "chown",
  "claude",
  "cp",
  "crontab",
  "curl",
  "date",
  "dd",
  "df",
  "dig",
  "dnf",
  "docker",
  "docker-compose",
  "du",
  "echo",
  "env",
  "export",
  "find",
  "free",
  "gh",
  "git",
  "go",
  "grep",
  "head",
  "helm",
  "hostnamectl",
  "htop",
  "ip",
  "journalctl",
  "just",
  "kill",
  "kubectl",
  "less",
  "ln",
  "ls",
  "lsblk",
  "make",
  "mkdir",
  "mount",
  "mv",
  "nano",
  "node",
  "npm",
  "npx",
  "nvidia-smi",
  "ollama",
  "omnigent",
  "openssl",
  "pg_dump",
  "ping",
  "pip",
  "pip3",
  "pkill",
  "pnpm",
  "printf",
  "ps",
  "psql",
  "pwd",
  "pwsh",
  "python",
  "python3",
  "reboot",
  "restic",
  "rg",
  "rm",
  "rsync",
  "scp",
  "sed",
  "sh",
  "shutdown",
  "sleep",
  "snap",
  "source",
  "ssh",
  "sudo",
  "systemctl",
  "tail",
  "tailscale",
  "tar",
  "tee",
  "tmux",
  "top",
  "touch",
  "ufw",
  "umount",
  "unzip",
  "uv",
  "vim",
  "watch",
  "wc",
  "wget",
  "which",
  "whoami",
  "xargs",
  "yarn",
  "zip",
  "zsh",
]);

/** Longest untagged block still treated as commands; longer is a script or a listing. */
const MAX_UNTAGGED_LINES = 20;

/**
 * Whether an untagged block reads as shell commands: every non-empty,
 * non-comment line starts with a known command, a path to an executable
 * (`./x`, `~/x`, `/usr/bin/x`), an env assignment before one, or continues a
 * line ending in `\`.
 */
export function looksLikeCommand(code: string): boolean {
  const lines = code.replace(/\s+$/, "").split("\n");
  if (lines.length === 0 || lines.length > MAX_UNTAGGED_LINES) return false;
  let sawCommand = false;
  let continued = false;
  for (const raw of lines) {
    const line = raw.trim();
    const isContinuation = continued;
    continued = line.endsWith("\\");
    if (isContinuation) continue;
    if (line === "" || line.startsWith("#")) continue;
    if (!lineStartsWithCommand(stripPrompt(line))) return false;
    sawCommand = true;
  }
  return sawCommand;
}

function stripPrompt(line: string): string {
  return line.startsWith("$ ") ? line.slice(2).trimStart() : line;
}

function lineStartsWithCommand(line: string): boolean {
  const words = line.split(/\s+/);
  let i = 0;
  // `FOO=bar BAZ=1 cmd ...`
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(words[i])) i += 1;
  const word = words[i];
  if (word === undefined) return false;
  if (/^(\.{1,2}|~)?\/[\w./~-]+$/.test(word)) return true;
  return COMMAND_WORDS.has(word);
}

/** Whether a code block gets a Run button: a shell fence, or untagged and command-like. */
export function isRunnableBlock(language: string | null, code: string): boolean {
  if (code.trim() === "") return false;
  if (language !== null) return AE_RUN_SHELL_LANGUAGES.has(language);
  return looksLikeCommand(code);
}

/**
 * The exact text Run sends. Trailing whitespace goes (Enter is sent
 * separately). When a block is a transcript (`console`, or lines prompted
 * with `$ `), only the prompted lines and their `\` continuations are kept,
 * without the prompt, so output lines are never replayed as commands.
 */
export function commandText(code: string): string {
  const trimmed = code.replace(/\s+$/, "");
  const lines = trimmed.split("\n");
  if (!lines.some((line) => line.startsWith("$ "))) return trimmed;
  const kept: string[] = [];
  let continued = false;
  for (const line of lines) {
    if (line.startsWith("$ ")) {
      kept.push(line.slice(2));
      continued = line.endsWith("\\");
    } else if (continued) {
      kept.push(line);
      continued = line.endsWith("\\");
    }
  }
  return kept.join("\n");
}

/** A construct still open at the end of a block, which Enter must not submit. */
export type AeOpenConstruct =
  | { kind: "heredoc"; delimiter: string }
  | { kind: "single-quote" }
  | { kind: "double-quote" }
  | { kind: "backtick" }
  | { kind: "continuation" }
  | { kind: "here-string" };

/**
 * Scan a POSIX shell block for a construct left open at its end: a heredoc
 * whose delimiter line never comes, an unterminated quote or backtick, or a
 * trailing `\`, `|`, `&&` or `||` that would leave the shell at its `>`
 * prompt. Null when Enter is safe.
 */
export function openShellConstruct(text: string): AeOpenConstruct | null {
  const lines = text.split("\n");
  let quote: "'" | '"' | "`" | "$'" | null = null;
  const pending: { delimiter: string; stripTabs: boolean }[] = [];
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    let i = 0;
    let atWordStart = true;
    while (i < line.length) {
      const ch = line[i];
      if (quote === "'") {
        if (ch === "'") quote = null;
        i += 1;
        continue;
      }
      if (quote === '"' || quote === "`" || quote === "$'") {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        const closer = quote === "$'" ? "'" : quote;
        if (ch === closer) quote = null;
        i += 1;
        continue;
      }
      if (ch === "\\") {
        i += 2;
        atWordStart = false;
        continue;
      }
      if (ch === "#" && atWordStart) break;
      if (ch === "$" && line[i + 1] === "'") {
        quote = "$'";
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        i += 1;
        atWordStart = false;
        continue;
      }
      if (ch === "<" && line[i + 1] === "<" && line[i + 2] === "<") {
        i += 3;
        atWordStart = false;
        continue;
      }
      if (ch === "<" && line[i + 1] === "<") {
        const heredoc = parseHeredocStart(line, i + 2);
        if (heredoc) {
          pending.push({ delimiter: heredoc.delimiter, stripTabs: heredoc.stripTabs });
          i = heredoc.end;
          atWordStart = false;
          continue;
        }
      }
      atWordStart = /[\s;&|()]/.test(ch);
      i += 1;
    }
    lineIndex += 1;
    if (quote !== null) continue;
    // Heredoc bodies start on the line after the one that opened them.
    while (pending.length > 0) {
      const { delimiter, stripTabs } = pending[0];
      let closed = false;
      while (lineIndex < lines.length) {
        const body = stripTabs ? lines[lineIndex].replace(/^\t+/, "") : lines[lineIndex];
        lineIndex += 1;
        if (body === delimiter) {
          closed = true;
          break;
        }
      }
      if (!closed) return { kind: "heredoc", delimiter };
      pending.shift();
    }
  }
  if (quote === "'" || quote === "$'") return { kind: "single-quote" };
  if (quote === '"') return { kind: "double-quote" };
  if (quote === "`") return { kind: "backtick" };
  const last = lastCodeLine(text);
  if (last !== null && (/(^|[^\\])\\$/.test(last) || /(\||&&)$/.test(last))) {
    return { kind: "continuation" };
  }
  return null;
}

function parseHeredocStart(
  line: string,
  from: number,
): { delimiter: string; stripTabs: boolean; end: number } | null {
  let i = from;
  let stripTabs = false;
  if (line[i] === "-") {
    stripTabs = true;
    i += 1;
  }
  while (line[i] === " " || line[i] === "\t") i += 1;
  const rest = line.slice(i);
  const match = /^(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z0-9_.-]+))/.exec(rest);
  if (!match) return null;
  const delimiter = match[1] ?? match[2] ?? match[3];
  return { delimiter, stripTabs, end: i + match[0].length };
}

function lastCodeLine(text: string): string | null {
  const lines = text.replace(/\s+$/, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trimEnd();
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    return line;
  }
  return null;
}

/**
 * The PowerShell counterpart of {@link openShellConstruct}: an unclosed
 * here-string (`@'` / `@"` closed by `'@` / `"@` at a line start), an
 * unterminated quote, or a trailing backtick or pipe.
 */
export function openPowerShellConstruct(text: string): AeOpenConstruct | null {
  const lines = text.split("\n");
  let quote: "'" | '"' | null = null;
  let hereString: "'@" | '"@' | null = null;
  for (const line of lines) {
    if (hereString !== null) {
      if (line.startsWith(hereString)) hereString = null;
      continue;
    }
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (quote !== null) {
        if (quote === '"' && ch === "`") {
          i += 2;
          continue;
        }
        if (ch === quote) {
          if (line[i + 1] === quote) {
            i += 2;
            continue;
          }
          quote = null;
        }
        i += 1;
        continue;
      }
      if (ch === "#") break;
      if (ch === "`") {
        i += 2;
        continue;
      }
      if (
        ch === "@" &&
        (line[i + 1] === "'" || line[i + 1] === '"') &&
        i + 2 === line.trimEnd().length
      ) {
        hereString = line[i + 1] === "'" ? "'@" : '"@';
        break;
      }
      if (ch === "'" || ch === '"') quote = ch;
      i += 1;
    }
  }
  if (hereString !== null) return { kind: "here-string" };
  if (quote === "'") return { kind: "single-quote" };
  if (quote === '"') return { kind: "double-quote" };
  const last = lastCodeLine(text);
  if (last !== null && /(`|\|)$/.test(last)) return { kind: "continuation" };
  return null;
}

/** Plain-English hint for a block that is pasted without Enter. */
export function openConstructHint(open: AeOpenConstruct): string {
  switch (open.kind) {
    case "heredoc":
      return `The heredoc (<<${open.delimiter}) is never closed, so Run pastes the block without pressing Enter. Finish it in the terminal.`;
    case "here-string":
      return "The here-string is never closed, so Run pastes the block without pressing Enter. Finish it in the terminal.";
    case "single-quote":
    case "double-quote":
    case "backtick":
      return "A quote is left open, so Run pastes the block without pressing Enter. Check the end of the command in the terminal.";
    case "continuation":
      return "The last line continues onto a next line, so Run pastes the block without pressing Enter. Finish it in the terminal.";
  }
}

/** A dangerous construct the confirm sheet names before anything is sent. */
export interface AeRunDanger {
  id: "sudo" | "rm-rf" | "curl-sh" | "dd";
  message: string;
}

const DANGER_MESSAGES: Record<AeRunDanger["id"], string> = {
  sudo: "Runs as root with sudo. The terminal asks for your password there; this page never sees or keeps it.",
  "rm-rf": "Deletes files recursively with rm -rf. Nothing goes to a trash can.",
  "curl-sh":
    "Pipes a download straight into a shell (curl | sh). Whatever the server returns runs as you.",
  dd: "Writes raw bytes with dd. A wrong of= overwrites a disk.",
};

// A command word counts only at a command position: line start, or after
// ; & | ( ` $( or a leading sudo / env / time.
const COMMAND_POSITION = String.raw`(?:^|[;&|(\x60]|\$\()\s*(?:(?:sudo|env|time|exec|nohup)\s+(?:-\S+\s+)*)*`;
const SUDO_RE = /(?:^|[\s;&|(`])sudo(?=\s|$)/m;
const DD_RE = new RegExp(`${COMMAND_POSITION}dd(?=\\s|$)`, "m");
const RM_RE = new RegExp(`${COMMAND_POSITION}rm\\s+([^\\n;&|]*)`, "gm");
const CURL_PIPE_SH_RE =
  /\b(?:curl|wget)\b[^\n;]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+)?(?:ba|z|da|k|fi)?sh\b/;
const SH_OF_DOWNLOAD_RE = /\b(?:ba|z|da)?sh\b[^\n]*(?:<\(|\$\()\s*(?:curl|wget)\b/;

function isRecursiveForceRm(args: string): boolean {
  let recursive = false;
  let force = false;
  for (const word of args.split(/\s+/)) {
    if (word === "--") break;
    if (word === "--recursive") recursive = true;
    else if (word === "--force") force = true;
    else if (/^-[A-Za-z]+$/.test(word)) {
      if (/[rR]/.test(word)) recursive = true;
      if (word.includes("f")) force = true;
    }
  }
  return recursive && force;
}

/** Every dangerous construct in a block, in a fixed order (sudo, rm -rf, curl | sh, dd). */
export function detectDangers(text: string): AeRunDanger[] {
  const found = new Set<AeRunDanger["id"]>();
  if (SUDO_RE.test(text)) found.add("sudo");
  for (const match of text.matchAll(RM_RE)) {
    if (isRecursiveForceRm(match[1])) found.add("rm-rf");
  }
  if (CURL_PIPE_SH_RE.test(text) || SH_OF_DOWNLOAD_RE.test(text)) found.add("curl-sh");
  if (DD_RE.test(text)) found.add("dd");
  return (["sudo", "rm-rf", "curl-sh", "dd"] as const)
    .filter((id) => found.has(id))
    .map((id) => ({ id, message: DANGER_MESSAGES[id] }));
}

// Characters that never belong in a command a person reads before running it:
// C0 and C1 controls other than tab and newline (an ESC could end a bracketed
// paste early or repaint the terminal), zero-width and bidi-override marks.
function isHiddenChar(code: number): boolean {
  if (code === 0x09 || code === 0x0a) return false;
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/** Remove hidden characters (after folding CRLF to LF); returns the text and how many went. */
export function stripHiddenChars(code: string): { text: string; removed: number } {
  const folded = code.replace(/\r\n/g, "\n");
  let text = "";
  let removed = 0;
  for (const ch of folded) {
    if (isHiddenChar(ch.codePointAt(0) ?? 0)) removed += 1;
    else text += ch;
  }
  return { text, removed };
}

/** Everything the confirm sheet shows and the Run sends. */
export interface AeRunPlan {
  /** The exact text pasted into the terminal. */
  text: string;
  /** How many hidden characters were removed from the block before sending. */
  removedHidden: number;
  /** Whether Enter follows the paste. */
  submit: boolean;
  /** Why Enter is withheld, or null when it is sent. */
  hint: string | null;
  dangers: AeRunDanger[];
}

/** Build the plan for one code block. */
export function planRun(code: string, language: string | null): AeRunPlan {
  const { text: visible, removed } = stripHiddenChars(code);
  const text = commandText(visible);
  const open = language === "powershell" ? openPowerShellConstruct(text) : openShellConstruct(text);
  return {
    text,
    removedHidden: removed,
    submit: open === null,
    hint: open === null ? null : openConstructHint(open),
    dangers: detectDangers(text),
  };
}
