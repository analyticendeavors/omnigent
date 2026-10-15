// Context windows for the usage popover, one row per session: the session the
// composer is on, then each collaborator (child session) it spawned. Every row
// is that session's own window; rows are never added together, because two
// sessions on different models share no window.
//
// Sources, in order of trust: the chat store's live ring figures (active row
// only), the session snapshot (`context_window` / `last_total_tokens`), then
// the Claude Code status line the limits relay captured for that conversation.
// The status line is used only for a Claude Code session, so a conversation
// that moved to Codex never shows its old Claude reading.

import { useEffect, useState } from "react";
import { type ChildSessionInfo, fetchChildSessions } from "@/hooks/useChildSessions";
import { BRAIN_HARNESS_LABELS } from "@/lib/agentLabels";
import type { harnessFamily } from "@/lib/forkHarness";
import { nativeCodingAgentForHarness } from "@/lib/nativeCodingAgents";
import { getSessionSlim } from "@/lib/sessionsApi";
import { isTempConvId } from "@/lib/tempConversationId";
import type { Session } from "@/lib/types";
import type { AeHarness, AeSessionContext } from "./AePlanLimits";

/** A status line reading older than this is shown, but marked as possibly out of date. */
export const AE_STATUSLINE_STALE_MS = 60 * 60_000;

/** Collaborator snapshots fetched per open; the rest are counted, not shown. */
export const AE_MAX_COLLABORATORS = 6;

/** The fields of a session snapshot the context rows read. */
export interface AeSessionSnapshot {
  harness: string | null;
  llmModel: string | null;
  contextWindow: number | null;
  lastTotalTokens: number | null;
}

export interface AeCollaboratorInput {
  id: string;
  /** Rail name: task summary, else title, else the child's id. */
  name: string;
  /** The child's snapshot; `null` when it failed to load. */
  snapshot: AeSessionSnapshot | null;
  /** Router pick from the child list, used when the snapshot names no model. */
  routedModel?: string | null;
  error?: string | null;
}

/** What the popover fetched for the session it was opened on. */
export interface AeSessionContextsState {
  /** This session's snapshot, the check on the store's live (possibly stale) fields. */
  self?: AeSessionSnapshot | null;
  collaborators: AeCollaboratorInput[];
  /** Children past `AE_MAX_COLLABORATORS`. */
  hidden?: number;
  loading?: boolean;
  error?: string | null;
}

export type AeContextSource = "live" | "snapshot" | "statusline";

export interface AeContextReading {
  source: AeContextSource;
  used: number;
  size: number;
  /** When the reading was taken; only the status line carries a time. */
  observedAt: string | null;
  stale: boolean;
}

export interface AeContextEntry {
  key: string;
  role: "active" | "collaborator";
  name: string;
  /** Harness id the row resolved to, e.g. `"codex-native"`. */
  harness: string | null;
  /** "Codex", "Claude Code", "Claude SDK"; null when the harness is unknown. */
  agent: string | null;
  model: string | null;
  reading: AeContextReading | null;
  /** Why there is no reading; set exactly when `reading` is null. */
  unavailable: string | null;
  /** Prompt cache split from the Claude Code status line, when it is this session's. */
  breakdown: AeSessionContext | null;
}

/** Display name for a harness id: "codex-native" → "Codex". */
export function aeAgentLabel(harness: string | null | undefined): string | null {
  if (!harness) return null;
  if (isClaudeCodeHarness(harness)) return "Claude Code";
  return (
    nativeCodingAgentForHarness(harness)?.displayName ?? BRAIN_HARNESS_LABELS[harness] ?? harness
  );
}

const CLAUDE_MODEL_ID =
  /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?(?:-\d{8})?(?:\[1m\])?$/i;
const CLAUDE_MODEL_ALIAS = /^(opus|sonnet|haiku|fable)(?:\[1m\])?$/i;

/** A Claude model id as people read it: "claude-opus-5-5[1m]" -> "Opus 5.5". */
export function aeModelName(model: string | null | undefined): string | null {
  const raw = model?.trim();
  if (!raw) return null;
  const id = CLAUDE_MODEL_ID.exec(raw);
  const family = id?.[1] ?? CLAUDE_MODEL_ALIAS.exec(raw)?.[1];
  if (!family) return raw;
  const name = family.charAt(0).toUpperCase() + family.slice(1).toLowerCase();
  if (!id) return name;
  return id[3] ? `${name} ${id[2]}.${id[3]}` : `${name} ${id[2]}`;
}

function isClaudeCodeHarness(harness: string): boolean {
  return harness === "claude-native" || harness === "native-claude";
}

function modelFamily(model: string | null | undefined): ReturnType<typeof harnessFamily> {
  const m = (model ?? "").toLowerCase();
  if (/claude|anthropic|opus|sonnet|haiku|fable/.test(m)) return "anthropic";
  if (/gpt|codex|openai|\bo[134]\b/.test(m)) return "openai";
  if (/gemini/.test(m)) return "gemini";
  return null;
}

/**
 * Whether the relay's Claude Code status line can speak for this session: a
 * Claude Code harness, or (harness not known yet) a Claude model.
 */
export function usesClaudeStatusLine(harness: string | null, model: string | null): boolean {
  if (harness) return isClaudeCodeHarness(harness);
  return modelFamily(model) === "anthropic";
}

/** The plan-limit block (`/v1/ae/limits` harness) a session draws on, if any. */
export function aeLimitsHarnessFor(harness: string | null | undefined): AeHarness | null {
  if (!harness) return null;
  if (isClaudeCodeHarness(harness)) return "claude";
  const codex =
    harness === "codex" ||
    harness === "native-codex" ||
    nativeCodingAgentForHarness(harness)?.key === "codex";
  return codex ? "codex" : null;
}

function fromStatusLine(
  contexts: AeSessionContext[] | undefined,
  sessionId: string | null,
  harness: string | null,
  model: string | null,
): AeSessionContext | null {
  if (!sessionId || !usesClaudeStatusLine(harness, model)) return null;
  return contexts?.find((c) => c.conversation_id === sessionId) ?? null;
}

function statusLineReading(context: AeSessionContext, now: number): AeContextReading | null {
  if (!(context.window_size > 0)) return null;
  const age = now - Date.parse(context.observed_at);
  return {
    source: "statusline",
    used: context.used_tokens,
    size: context.window_size,
    observedAt: context.observed_at,
    stale: Number.isFinite(age) && age > AE_STATUSLINE_STALE_MS,
  };
}

function snapshotReading(snapshot: AeSessionSnapshot | null | undefined): AeContextReading | null {
  if (!snapshot?.contextWindow || snapshot.contextWindow <= 0) return null;
  if (snapshot.lastTotalTokens == null) return null;
  return {
    source: "snapshot",
    used: snapshot.lastTotalTokens,
    size: snapshot.contextWindow,
    observedAt: null,
    stale: false,
  };
}

const MISSING_TEXT = "No reading yet; it appears after the session's next reply.";

export interface AeActiveSessionInput {
  conversationId: string | null;
  harness: string | null;
  model: string | null;
  contextWindow: number | null;
  tokensUsed: number | null;
}

/**
 * The active session's row. The store's ring figures win unless this
 * session's own snapshot names a different harness (the agent was switched
 * and the store has not rebound yet): then the snapshot speaks for it.
 */
export function buildActiveContext(
  input: AeActiveSessionInput,
  self: AeSessionSnapshot | null | undefined,
  statusLines: AeSessionContext[] | undefined,
  now: number,
): AeContextEntry {
  const storeStale = Boolean(self?.harness && input.harness && self.harness !== input.harness);
  const harness = storeStale ? (self?.harness ?? null) : (input.harness ?? self?.harness ?? null);
  const model = storeStale ? (self?.llmModel ?? null) : (input.model ?? self?.llmModel ?? null);
  const agent = aeAgentLabel(harness);
  const statusLine = fromStatusLine(statusLines, input.conversationId, harness, model);
  const live =
    !storeStale &&
    input.contextWindow != null &&
    input.contextWindow > 0 &&
    input.tokensUsed != null
      ? {
          source: "live" as const,
          used: input.tokensUsed,
          size: input.contextWindow,
          observedAt: null,
          stale: false,
        }
      : null;
  const reading =
    live ?? snapshotReading(self) ?? (statusLine ? statusLineReading(statusLine, now) : null);
  return {
    key: input.conversationId ?? "active",
    role: "active",
    name: "This session",
    harness,
    agent,
    model,
    reading,
    unavailable: reading
      ? null
      : input.conversationId
        ? MISSING_TEXT
        : "No session yet; the reading appears after the first reply.",
    breakdown: statusLine,
  };
}

export function buildCollaboratorContext(
  input: AeCollaboratorInput,
  statusLines: AeSessionContext[] | undefined,
  now: number,
): AeContextEntry {
  const harness = input.snapshot?.harness ?? null;
  const model = input.snapshot?.llmModel ?? input.routedModel ?? null;
  const agent = aeAgentLabel(harness);
  const statusLine = input.snapshot ? fromStatusLine(statusLines, input.id, harness, model) : null;
  const reading =
    snapshotReading(input.snapshot) ?? (statusLine ? statusLineReading(statusLine, now) : null);
  return {
    key: input.id,
    role: "collaborator",
    name: input.name,
    harness,
    agent,
    model,
    reading,
    unavailable: reading
      ? null
      : input.snapshot
        ? MISSING_TEXT
        : `Could not load this session${input.error ? ` (${input.error})` : ""}.`,
    breakdown: statusLine,
  };
}

function toSnapshot(session: Session): AeSessionSnapshot {
  return {
    harness: session.harness ?? null,
    llmModel: session.llmModel ?? null,
    contextWindow: session.contextWindow ?? null,
    lastTotalTokens: session.lastTotalTokens ?? null,
  };
}

/** Claude Code's own subagents run inside its process and report no context of their own. */
const NATIVE_SUBAGENT_WRAPPER = "claude-code-native-ui-subagent";

function isNativeSubagent(child: ChildSessionInfo): boolean {
  return child.labels?.["omnigent.wrapper"] === NATIVE_SUBAGENT_WRAPPER;
}

/** The task summary or title, never a bare "type:hexid" such as "general-purpose:a45b4b17". */
function childName(child: ChildSessionInfo): string {
  const title = child.title?.trim();
  if (child.task_summary) return child.task_summary;
  if (title && !/^[\w.-]+:[0-9a-f]{8,}$/i.test(title)) return title;
  return "Collaborator";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One fetch of this session's snapshot, its children and theirs. */
export async function fetchAeSessionContexts(
  sessionId: string,
  signal?: AbortSignal,
): Promise<AeSessionContextsState> {
  const [self, children] = await Promise.all([
    getSessionSlim(sessionId, { signal }).then(toSnapshot, () => null),
    fetchChildSessions(sessionId).then(
      (rows) => ({ rows, error: null }),
      (error: unknown) => ({ rows: [] as ChildSessionInfo[], error: errorText(error) }),
    ),
  ]);
  const rows = children.rows.filter((child) => !isNativeSubagent(child));
  const shown = rows.slice(0, AE_MAX_COLLABORATORS);
  const collaborators = await Promise.all(
    shown.map(async (child): Promise<AeCollaboratorInput> => {
      const base = { id: child.id, name: childName(child), routedModel: child.routed_model };
      try {
        return { ...base, snapshot: toSnapshot(await getSessionSlim(child.id, { signal })) };
      } catch (error) {
        return { ...base, snapshot: null, error: errorText(error) };
      }
    }),
  );
  return {
    self,
    collaborators,
    hidden: rows.length - shown.length,
    error: children.error,
  };
}

/**
 * This session's and its collaborators' snapshots while `active` (the popover
 * is open), refreshed once a minute; nothing is fetched while it is closed.
 * A new session id drops the previous session's rows at once.
 */
export function useAeSessionContexts(
  active: boolean,
  sessionId: string | null,
  refreshMs = 60_000,
  binding = "",
): AeSessionContextsState {
  const id = sessionId && !isTempConvId(sessionId) ? sessionId : null;
  const key = JSON.stringify([id, binding]);
  const [state, setState] = useState<{ id: string | null; value: AeSessionContextsState }>({
    id: null,
    value: { collaborators: [] },
  });
  useEffect(() => {
    if (!active || !id) return undefined;
    const controller = new AbortController();
    const load = () => {
      setState((prev) =>
        prev.id === key
          ? { id: key, value: { ...prev.value, loading: true } }
          : { id: key, value: { collaborators: [], loading: true } },
      );
      fetchAeSessionContexts(id, controller.signal)
        .then((value) => !controller.signal.aborted && setState({ id: key, value }))
        .catch(
          (error: unknown) =>
            !controller.signal.aborted &&
            setState({ id: key, value: { collaborators: [], error: errorText(error) } }),
        );
    };
    load();
    const timer = window.setInterval(load, refreshMs);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [active, id, key, refreshMs]);
  if (!id || state.id !== key) return { collaborators: [], loading: active && id !== null };
  return state.value;
}
