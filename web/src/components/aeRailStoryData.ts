// Illustrative data for the session rail and usage popover stories: one Claude
// Code session with two collaborators and three subagents. Nothing here is a
// real person, client or file. `installAeRailStoryData` seeds the stores and
// the query cache, and stubs `window.fetch` for every other URL the sections
// read (authenticatedFetch ends in fetch).

import { QueryClient } from "@tanstack/react-query";
import type { Conversation } from "@/hooks/useConversations";
import type { AnyBlock, BlockContext, MessageContentBlock } from "@/lib/blocks";
import { useAeSessionRailStore } from "@/lib/aeSessionRail";
import type { ConversationsInfiniteData } from "@/lib/sessionListCache";
import { useChatStore } from "@/store/chatStore";
import type { AeLimitsAnswer } from "./AePlanLimits";
import { resetAeContextSnapshots, type ContextUsage } from "./aeContextUsage";
import { SNAPSHOT } from "./aeRailTestFixtures";

export const AE_STORY_SESSION = "conv_rail_demo";
const CODEX = "conv_rail_codex";
const SONNET = "conv_rail_sonnet";
const REPO = "ae-demo/omnigent-ae";
const OPEN_PR = `https://github.com/${REPO}/pull/108`;
const MERGED_PR = `https://github.com/${REPO}/pull/106`;
const FOLDER = "/home/demo/repos/omnigent-ae";

const nowS = () => Math.floor(Date.now() / 1000);
const iso = (ms: number) => new Date(ms).toISOString();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A small gradient PNG as a data URL, drawn on a canvas. */
function gradient(from: string, to: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 120;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const fill = ctx.createLinearGradient(0, 0, 160, 120);
  fill.addColorStop(0, from);
  fill.addColorStop(1, to);
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, 160, 120);
  return canvas.toDataURL("image/png");
}

export const STORY_LIMITS = (now: number): AeLimitsAnswer => ({
  now: iso(now),
  harnesses: {
    claude: {
      harness: "claude",
      source: "statusline+usage",
      observed_at: iso(now - 3 * 60_000),
      plan: "Max 20x",
      windows: [
        {
          id: "five_hour",
          label: "5-hour limit",
          used_percent: 0,
          resets_at: iso(now + 3 * 3_600_000),
          window_minutes: 300,
        },
        {
          id: "seven_day",
          label: "Weekly, all models",
          used_percent: 100,
          resets_at: iso(now + 3 * 86_400_000),
          window_minutes: 10080,
        },
        {
          id: "seven_day_fable",
          label: "Weekly · Fable",
          used_percent: 0,
          resets_at: iso(now + 3 * 86_400_000),
          window_minutes: 10080,
        },
      ],
      note: null,
      credits: {
        enabled: true,
        used_minor: 15613,
        limit_minor: 20000,
        used_percent: 78,
        currency: "USD",
      },
      contexts: [],
    },
    codex: {
      harness: "codex",
      source: "app-server",
      observed_at: iso(now - 4 * 60_000),
      plan: "Pro",
      windows: [
        {
          id: "five_hour",
          label: "5-hour limit",
          used_percent: 12,
          resets_at: iso(now + 4 * 3_600_000),
          window_minutes: 300,
        },
        {
          id: "weekly",
          label: "Weekly limit",
          used_percent: 30,
          resets_at: iso(now + 86_400_000),
          window_minutes: 10080,
        },
      ],
      note: null,
    },
  },
});

/** The category snapshot with the deferred system tools row and nine MCP servers. */
export function storyContextSnapshot(): ContextUsage {
  return {
    ...SNAPSHOT,
    observedAt: iso(Date.now() - 60_000),
    categories: [
      ...SNAPSHOT.categories.slice(0, 5),
      { name: "System tools (deferred)", tokens: 24_000, kind: "deferred" },
      ...SNAPSHOT.categories.slice(5),
    ],
    details: {
      "Memory files": [
        { name: "~/.claude/CLAUDE.md", tokens: 11_200 },
        { name: "~/repos/omnigent-ae/CLAUDE.md", tokens: 3_100 },
        { name: "upstream/CLAUDE.md", tokens: 1_400 },
        { name: "memory/MEMORY.md", tokens: 1_200 },
        { name: "upstream/AGENTS.md", tokens: 2_500 },
      ],
      "MCP tools": [
        { name: "mcp__demo__create_task", tokens: 1_100 },
        { name: "mcp__demo__list_tasks", tokens: 600 },
      ],
      "Custom agents": [],
      Skills: [{ name: "dual-review", tokens: 200 }],
    },
    mcpServers: [
      { name: "task-store", status: "connected" },
      { name: "docs-search", status: "connected" },
      { name: "browser", status: "connected" },
      { name: "github", status: "connected" },
      { name: "calendar", status: "connected" },
      { name: "mail", status: "connected" },
      { name: "notes", status: "connected" },
      { name: "billing", status: "failed" },
      { name: "analytics", status: "failed" },
    ],
  };
}

const ctx = (createdAtS: number): BlockContext => ({
  agent: null,
  depth: 0,
  turn: 0,
  timestamp: 0,
  responseId: "r",
  itemId: null,
  createdAtS,
});

function asked(content: MessageContentBlock[], ageS: number): AnyBlock {
  return { type: "user_message", ctx: ctx(nowS() - ageS), content };
}

function said(text: string, ageS: number): AnyBlock {
  return { type: "text_done", ctx: ctx(nowS() - ageS), fullText: text, hasCodeBlocks: false };
}

function storyBlocks(): AnyBlock[] {
  return [
    asked([{ type: "input_text", text: "Build the session rail." }], 7200),
    said(
      "Absorbed: fixed the icon size, two minutes and no deliverable of its own.\n" +
        "Absorbed: renamed the toggle label, same file already open.",
      6900,
    ),
    asked(
      [
        { type: "input_text", text: "Here is how the rail looks now." },
        {
          type: "input_image",
          image_url: gradient("#0ea5e9", "#6366f1"),
          filename: "rail-dark-1440.png",
        },
        {
          type: "input_image",
          image_url: gradient("#f59e0b", "#ef4444"),
          filename: "rail-phone-375.png",
        },
      ],
      5400,
    ),
    asked(
      [
        { type: "input_text", text: "And the capacity numbers." },
        { type: "input_file", file_id: "file_demo_csv", filename: "capacity-export.csv" },
      ],
      3600,
    ),
  ];
}

function sessionWire(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    agent_id: "claude",
    agent_name: "claude",
    status: "idle",
    created_at: nowS() - 7800,
    title: "Session rail build",
    labels: {},
    items: [],
    harness: "claude-native",
    ...extra,
  };
}

function child(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    task_summary: title,
    tool: null,
    session_name: null,
    labels: {},
    current_task_status: "in_progress",
    busy: true,
    last_message_preview: null,
    pending_elicitations_count: 0,
    created_at: nowS() - 1800,
    updated_at: nowS() - 60,
    ...extra,
  };
}

const CHANGED = (() => {
  const t = nowS();
  const row = (
    path: string,
    status: "created" | "modified",
    added: number,
    removed: number,
    ageS: number,
  ) => ({
    path: `${FOLDER}/${path}`,
    name: path.split("/").pop() ?? path,
    status,
    bytes: 4096,
    modified_at: t - ageS,
    lines_added: added,
    lines_removed: removed,
  });
  const modified = [
    ["upstream/web/src/shell/AppShell.tsx", 38, 9],
    ["upstream/web/src/components/AePlanLimits.tsx", 182, 49],
    ["upstream/web/src/lib/aeSessionRail.ts", 12, 3],
    ["upstream/web/src/components/aeRail/AeRailTriage.tsx", 19, 7],
    ["upstream/web/src/components/aeRail/AeRailContext.tsx", 22, 5],
    ["upstream/web/src/components/aeRail/AeRailUsage.tsx", 15, 4],
    ["upstream/web/src/index.css", 6, 2],
    ["docs/PLAN-LIMITS.md", 24, 6],
    ["patches/0071-session-rail.patch", 41, 11],
    ["upstream/web/package.json", 2, 0],
  ] as const;
  return [
    row("upstream/web/src/shell/AeSessionRail.tsx", "created", 221, 0, 600),
    row("upstream/web/src/components/aeRail/AeRailSection.tsx", "created", 138, 0, 900),
    row("docs/screenshots/session-rail/README.md", "created", 52, 0, 1200),
    row("notes/rail-capacity-plan.md", "created", 40, 0, 1500),
    ...modified.map(([p, a, r], i) => row(p, "modified", a, r, 2000 + i * 100)),
  ];
})();

/** Fetch stub for every URL the rail's sections and the popover read. */
function route(input: string, init?: RequestInit): Response | null {
  const method = init?.method ?? "GET";
  const url = input.slice(Math.max(0, input.indexOf("/v1/")));
  const path = url.split("?")[0];
  if (path === `/v1/sessions/${AE_STORY_SESSION}`) {
    return json(
      sessionWire(AE_STORY_SESSION, {
        host_id: "host_box_host",
        workspace: FOLDER,
        git_branch: "ae/session-rail",
        llm_model: "claude-opus-5-5[1m]",
        context_window: 1_000_000,
        last_total_tokens: 495_200,
        labels: { "omnigent.claude_native.permission_mode": "auto" },
      }),
    );
  }
  if (path === `/v1/sessions/${CODEX}`) {
    return json(
      sessionWire(CODEX, {
        harness: "codex-native",
        llm_model: "gpt-6-astra",
        context_window: 400_000,
        last_total_tokens: 88_000,
      }),
    );
  }
  if (path === `/v1/sessions/${SONNET}`) {
    return json(
      sessionWire(SONNET, {
        llm_model: "claude-sonnet-5-5",
        context_window: 1_000_000,
        last_total_tokens: 410_000,
      }),
    );
  }
  if (path === `/v1/sessions/${AE_STORY_SESSION}/child_sessions`) {
    const sub = (n: number) =>
      child(`conv_rail_sub${n}`, `Subagent ${n}`, {
        labels: { "omnigent.wrapper": "claude-code-native-ui-subagent" },
      });
    return json({
      object: "list",
      data: [
        child(CODEX, "Review the diff", { model: "gpt-6-astra" }),
        child(SONNET, "Write the docs", { model: "claude-sonnet-5-5" }),
        sub(1),
        sub(2),
        sub(3),
      ],
    });
  }
  if (path === `/v1/sessions/${AE_STORY_SESSION}/context-usage`) {
    return json(storyContextSnapshot());
  }
  if (path === `/v1/sessions/${AE_STORY_SESSION}/resources/environments/default`) {
    return json({ metadata: { root: FOLDER, home: "/home/demo" } });
  }
  if (path === `/v1/sessions/${AE_STORY_SESSION}/resources/environments/default/changes`) {
    return json({ object: "list", data: CHANGED, has_more: false });
  }
  if (path === `/v1/sessions/${AE_STORY_SESSION}/resources/github`) {
    return json({
      object: "session.github.info",
      available: true,
      gh_available: true,
      authenticated: true,
      branch: "ae/session-rail",
      repo: { name_with_owner: REPO },
      prs: [
        {
          url: OPEN_PR,
          host: "github.com",
          repository: REPO,
          number: 108,
          relationship: "created",
        },
        {
          url: MERGED_PR,
          host: "github.com",
          repository: REPO,
          number: 106,
          relationship: "worked_on",
        },
      ],
    });
  }
  const pr = /^\/v1\/ae\/prs\/[^/]+\/[^/]+\/(\d+)$/.exec(path);
  if (pr && method === "GET") return json(prCard(Number(pr[1])));
  if (path === "/v1/hosts") {
    return json({
      hosts: [{ host_id: "host_box_host", name: "box-host", owner: "demo", status: "online" }],
    });
  }
  if (path === "/v1/ae/limits") return json(STORY_LIMITS(Date.now()));
  if (path === "/v1/ae/capacity") return json({ limit: 3, working: [] });
  if (path === "/v1/ae/lot") return json({ tasks: [] });
  if (path === "/v1/scheduled-tasks") return json({ scheduled_tasks: scheduledTasks() });
  return path.startsWith("/v1/") ? json({ detail: "Not Found" }, 404) : null;
}

function prCard(number: number) {
  const merged = number === 106;
  return {
    repo: REPO,
    number,
    url: merged ? MERGED_PR : OPEN_PR,
    title: merged
      ? "Render PR descriptions as markdown and show passed checks"
      : "Add the session rail",
    state: merged ? "merged" : "open",
    draft: false,
    author: "demo",
    head_ref: "ae/session-rail",
    base_ref: "dev",
    head_sha: "abc1234",
    ci: merged
      ? { state: "passing", passing: 6, failing: 0, pending: 0, total: 6 }
      : { state: "pending", passing: 3, failing: 0, pending: 3, total: 6 },
    mergeable: { state: merged ? "merged" : "checking", detail: "" },
    review: { state: "none", approvals: 0, changes_requested: 0, requested: [] },
    merge: { methods: [], default_method: null, allowed: false, reason: null },
  };
}

function scheduledTasks() {
  const base = {
    owner_user_id: null,
    agent_id: "claude",
    timezone: "America/Los_Angeles",
    created_at: nowS() - 7000,
    updated_at: nowS() - 7000,
    model_override: null,
    reasoning_effort: null,
    permission_mode: null,
    workspace: null,
    host_id: null,
    execution_target: "host",
    state: "active",
    last_run_at: null,
    last_run_status: null,
    last_run_conversation_id: null,
  };
  const until = new Date(Date.now() + 3 * 86_400_000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+/, "");
  return [
    {
      ...base,
      id: "a".repeat(32),
      name: "AE orchestrator check-in",
      prompt: `call post_message once with session_id ${AE_STORY_SESSION}`,
      rrule: `FREQ=HOURLY;INTERVAL=1;UNTIL=${until}`,
      next_run_at: iso(Date.now() + 40 * 60_000),
    },
    {
      ...base,
      id: "b".repeat(32),
      name: "Recheck CI on the rail pull request",
      prompt: `Check the checks for the rail pull request, then post to ${AE_STORY_SESSION}`,
      rrule: "FREQ=DAILY;COUNT=1",
      next_run_at: iso(Date.now() + 90 * 60_000),
    },
  ];
}

let installed = false;

function stubFetch(): void {
  if (installed) return;
  installed = true;
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const answer = route(url, init);
    return answer ? Promise.resolve(answer) : real(input, init);
  };
}

/**
 * Seed everything and return a fresh query client. Call it once per story
 * render, before the first section mounts.
 */
export function installAeRailStoryData(opts: { sheetOpen?: boolean } = {}): QueryClient {
  stubFetch();
  resetAeContextSnapshots();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const row: Conversation = {
    id: AE_STORY_SESSION,
    object: "conversation",
    title: "Session rail build",
    created_at: nowS() - 7800,
    updated_at: nowS() - 60,
    permission_level: null,
    labels: {
      "ae.status": "working",
      "ae.started": String(nowS() - (2 * 3600 + 10 * 60)),
      "ae.gate": "open",
      "ae.fork": "Show which merged pull requests are live on the box",
      "ae.overflow": "1",
      "ae.absorbed": "2",
      "ae.next": "Say go to build the rail",
    },
  };
  const pages: ConversationsInfiniteData = {
    pages: [{ data: [row], first_id: null, last_id: null, has_more: false }],
    pageParams: [undefined],
  };
  client.setQueryData(["conversations"], pages);
  useChatStore.setState({
    conversationId: AE_STORY_SESSION,
    blocks: storyBlocks(),
    hasMoreHistory: false,
    sessionHarness: "claude-native",
    llmModel: "claude-opus-5-5[1m]",
    contextWindow: 1_000_000,
    tokensUsed: 495_200,
    claudePermissionMode: "auto",
  });
  useAeSessionRailStore.setState({ open: true, folded: {}, sheetOpen: opts.sheetOpen ?? false });
  return client;
}
