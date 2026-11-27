import { describe, expect, it } from "vitest";
import { summarizeApproval, type ApprovalSummaryInput } from "./aeApprovalSummary";
import { classifyToolName } from "./aeApprovalSummaryTools";

const claude = (tool: string, input: unknown, phase = "pre_tool_use"): ApprovalSummaryInput => ({
  phase,
  policyName: "claude_native_permission",
  message: `Claude wants to call **${tool}**`,
  contentPreview: `${tool}(${JSON.stringify(input)})`,
});
const raw = (phase: string, params: unknown, message = ""): ApprovalSummaryInput => ({
  phase,
  policyName: `${phase.split("_")[0]}_native_x`,
  message,
  contentPreview: JSON.stringify(params),
});

// [name, input, expected text, source, risk]
const SHAPES: [string, ApprovalSummaryInput, string, string, string][] = [
  [
    "claude WebFetch",
    claude("WebFetch", { url: "https://github.com/a/b?x=1" }),
    "Fetch github.com/a/b",
    "derived",
    "read",
  ],
  [
    "claude WebSearch",
    claude("WebSearch", { query: "vitest mock" }),
    "Search the web for vitest mock",
    "derived",
    "read",
  ],
  [
    "claude Task",
    claude("Task", { description: "Audit the docs", prompt: "x" }),
    "Start a helper: Audit the docs",
    "derived",
    "write",
  ],
  ["claude Read", claude("Read", { file_path: "/a/b/c.ts" }), "Read c.ts", "derived", "read"],
  [
    "claude Grep",
    claude("Grep", { pattern: "TODO", path: "/a/src" }),
    "Search for TODO in src",
    "derived",
    "read",
  ],
  [
    "claude Glob",
    claude("Glob", { pattern: "**/*.ts" }),
    "Find files matching **/*.ts",
    "derived",
    "read",
  ],
  [
    "claude TodoWrite",
    claude("TodoWrite", { todos: [{}, {}] }),
    "Update the to-do list (2 items)",
    "derived",
    "read",
  ],
  [
    "claude mcp send",
    claude("mcp__m365__m365_email_send", { to: "ana", subject: "Hi", body: "x" }),
    "M365 email send via m365 (to: ana)",
    "derived",
    "write",
  ],
  [
    "claude mcp delete",
    claude("mcp__gh__delete_branch", { name: "old" }),
    "Delete branch via gh (name: old)",
    "derived",
    "destructive",
  ],
  [
    "claude mcp read",
    claude("mcp__gh__list_issues", { query: "bug" }),
    "List issues via gh (query: bug)",
    "derived",
    "read",
  ],
  [
    "claude mcp with reason",
    claude("mcp__x__do_thing", { reason: "Needed for the report" }),
    "Needed for the report",
    "agent",
    "write",
  ],
  [
    "claude other tool",
    claude("SlashCommand", { command_name: "x", name: "deploy" }),
    "Use slash command (name: deploy)",
    "derived",
    "write",
  ],
  [
    "sdk shell tool",
    claude("run_shell", { command: "ls -la", description: "List files" }, "tool_call"),
    "List files",
    "agent",
    "read",
  ],
  [
    "sdk tool call",
    claude("read_file", { path: "/x/y.md" }, "tool_call"),
    "Use read file (path: /x/y.md)",
    "derived",
    "read",
  ],
  [
    "codex file change",
    raw("codex_file_change_approval", { itemId: "i", grantRoot: "/repo" }),
    "Allow writes under /repo",
    "derived",
    "write",
  ],
  [
    "codex apply patch",
    raw("codex_apply_patch_approval", { fileChanges: { "src/b.ts": {}, "src/a.ts": {} } }),
    "Change 2 files: a.ts, b.ts",
    "derived",
    "write",
  ],
  [
    "codex patch reason",
    raw("codex_apply_patch_approval", { reason: "Fix the typo", fileChanges: { "a.ts": {} } }),
    "Fix the typo",
    "agent",
    "write",
  ],
  [
    "codex permissions",
    raw("codex_permissions_approval", {
      cwd: "/repo",
      permissions: { network: { enabled: true }, fileSystem: {} },
    }),
    "Grant network and file system access for /repo",
    "derived",
    "write",
  ],
  [
    "codex mcp",
    raw("codex_mcp_elicitation", {
      mode: "form",
      message: "Allow?",
      serverName: "docs",
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        tool_name: "search_docs",
        tool_params: { query: "auth" },
      },
    }),
    "Search docs via docs (query: auth)",
    "derived",
    "read",
  ],
  [
    "codex mcp no tool",
    raw(
      "codex_mcp_elicitation",
      { mode: "form", message: "Allow docs to run?", serverName: "docs" },
      "Allow docs to run?",
    ),
    "Allow docs to run?",
    "derived",
    "write",
  ],
  [
    "antigravity permission",
    {
      phase: "agy_permission",
      policyName: "agy_native_permission",
      message: "Antigravity wants to run: git status",
      contentPreview: "",
    },
    "Antigravity wants to run a command",
    "derived",
    "read",
  ],
  [
    "ae policy request",
    {
      phase: "request",
      policyName: "rabbit_hole",
      message: "This looks like a rabbit hole. Continue?",
      contentPreview: "go deeper",
    },
    "This looks like a rabbit hole. Continue?",
    "derived",
    "write",
  ],
  [
    "nothing known",
    { phase: "weird", policyName: "x", message: "", contentPreview: "" },
    "The agent wants approval",
    "generic",
    "write",
  ],
  [
    "tool, unparseable",
    {
      phase: "pre_tool_use",
      policyName: "claude_native_permission",
      message: "",
      contentPreview: "Foo(not json",
    },
    "Claude wants to use Foo",
    "generic",
    "write",
  ],
];

describe("summarizeApproval for every approval shape", () => {
  it.each(SHAPES)("%s", (_name, input, text, source, risk) => {
    const s = summarizeApproval(input);
    expect(s).not.toBeNull();
    expect(s).toMatchObject({ text, source, risk });
  });

  it("gives every approval phase a summary line", () => {
    const phases = [
      "pre_tool_use", "tool_call", "request", "codex_command_approval",
      "codex_file_change_approval", "codex_permissions_approval", "codex_apply_patch_approval",
      "codex_mcp_elicitation", "agy_permission", "something_new", "",
    ]; // prettier-ignore
    for (const phase of phases) {
      for (const contentPreview of ["", "{}", "Tool({})", "garbage"]) {
        const s = summarizeApproval({ phase, contentPreview });
        expect(s?.text, `${phase} / ${contentPreview}`).toBeTruthy();
      }
    }
  });

  it("never prints a secret-looking argument in the line", () => {
    const s = summarizeApproval(
      claude("mcp__x__connect", { api_key: "sk-123", token: "t0k", name: "prod", password: "pw" }),
    );
    expect(s?.text).toBe("Connect via x (name: prod)");
    expect(s?.text).not.toMatch(/sk-123|t0k|pw/);
  });

  it("truncates a long argument to about 60 characters", () => {
    const s = summarizeApproval(claude("mcp__x__send_note", { title: "y".repeat(200) }));
    expect(s?.text.length).toBeLessThan(90);
  });

  it("shows pretty-printed arguments as details", () => {
    const s = summarizeApproval(claude("WebFetch", { url: "https://a.test" }));
    expect(s?.code).toBe(JSON.stringify({ url: "https://a.test" }, null, 2));
  });

  it("classifies tool names by verb", () => {
    expect(classifyToolName("deleteAll").risk).toBe("destructive");
    expect(classifyToolName("force_push").risk).toBe("destructive");
    expect(classifyToolName("send_email").risk).toBe("write");
    expect(classifyToolName("merge_pr").risk).toBe("write");
    expect(classifyToolName("get_user").risk).toBe("read");
    expect(classifyToolName("frobnicate").risk).toBe("write");
    expect(classifyToolName("get_and_delete").risk).toBe("destructive");
  });
});
