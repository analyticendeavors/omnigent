// What an agent row says about itself beyond its title (omnigent-ae): role chip,
// effort and cost, and the total line under the list. The Agents tab and the
// rail's Agents card share it; each wraps its rows in AeAgentMetaProvider.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ChildSessionInfo } from "@/hooks/useChildSessions";
import { aeRaiseMarks } from "@/lib/aeModelChange";
import { aeSpendLabel, aeUsageSpentTokens, useAeSpendDisplay } from "@/lib/aeSpendDisplay";
import { aeAgentRole, aeFormatCost, aeFormatTokens, aeRoleName } from "@/lib/aeAgentRole";
import {
  AE_MODEL_FAMILIES,
  AE_MODEL_FAMILY_BG,
  AE_MODEL_FAMILY_NAMES,
  aeModelFamily,
  type AeSessionUsage,
  useAeSessionUsages,
} from "@/lib/aeAgentUsage";
import {
  type AeNativeAgentInput,
  aeNativeAgentInput,
  aeNativeAgentInputs,
  aeNativeModelLabel,
} from "@/lib/aeNativeAgentInput";
import { agentModelLabel, isChildFinished } from "./aeAgentsPaneModel";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";

const NO_USAGE: ReadonlyMap<string, AeSessionUsage> = new Map();
const NO_INPUTS: Readonly<Record<string, AeNativeAgentInput>> = {};
const UsageContext = createContext(NO_USAGE);
const NativeInputContext = createContext(NO_INPUTS);

/** The model and effort a native subagent row's Agent call named, or null when unknown. */
export function useAeNativeInput(child: ChildSessionInfo): AeNativeAgentInput | null {
  return aeNativeAgentInput(useContext(NativeInputContext), child);
}

/** A session's usage as the provider read it. */
export function useAeAgentUsage(id: string): AeSessionUsage | undefined {
  return useContext(UsageContext).get(id);
}

/** The open lead chat's Agent tool inputs; a signature keeps a streaming reply from re-rendering rows. */
function useNativeInputs(rootSessionId: string): Readonly<Record<string, AeNativeAgentInput>> {
  const signature = useChatStore((s) =>
    s.conversationId === rootSessionId ? JSON.stringify(aeNativeAgentInputs(s.blocks)) : "{}",
  );
  return useMemo(() => JSON.parse(signature) as Record<string, AeNativeAgentInput>, [signature]);
}

/**
 * Reads the lead's usage and that of the rows *shown* (not every child), plus
 * the native inputs. A stopped row is read once; running rows and the lead
 * read again every 30 s while anything runs.
 */
export function useAeAgentMeta(
  rootSessionId: string,
  shown: readonly ChildSessionInfo[],
  live: boolean,
) {
  const sessions = useMemo(
    () => [
      { id: rootSessionId, stamp: 0 },
      ...shown.map((a) => ({
        id: a.id,
        stamp: `${a.current_task_status ?? ""}${a.busy ? "b" : ""}`,
        done: isChildFinished(a),
      })),
    ],
    [rootSessionId, shown],
  );
  const usage = useAeSessionUsages(sessions, { enabled: shown.length > 0, live });
  const inputs = useNativeInputs(rootSessionId);
  return { usage, inputs };
}

export function AeAgentMetaProvider({
  meta,
  children,
}: {
  meta: ReturnType<typeof useAeAgentMeta>;
  children: ReactNode;
}) {
  return (
    <NativeInputContext.Provider value={meta.inputs}>
      <UsageContext.Provider value={meta.usage}>{children}</UsageContext.Provider>
    </NativeInputContext.Provider>
  );
}

/** Role chip, effort and cost (tokens when known) on one line; each shows only when known, and the line is gone when none is. */
export function AeAgentMetaLine({
  child,
  className,
  withModel = false,
}: {
  child: ChildSessionInfo;
  className?: string;
  /** Also name the model (the rail card has no Model column). */
  withModel?: boolean;
}) {
  const usage = useAeAgentUsage(child.id);
  const native = useAeNativeInput(child);
  const role = aeAgentRole(child);
  const effort = usage?.effort ?? native?.effort ?? null;
  const mode = useAeSpendDisplay();
  const own = usage && (mode === "tokens" || mode === "both") ? aeSpendLabel([usage], mode) : null;
  const cost = mode === "cost" ? (usage?.costUsd ?? null) : null;
  const tokens = mode === "cost" && usage?.tokens != null && usage.tokens > 0 ? usage.tokens : null;
  const model = withModel ? (child.model ?? child.routed_model ?? native?.model ?? null) : null;
  const nowModel = child.model ?? child.routed_model ?? native?.model ?? null;
  // The count is history; the arrow shows only while the helper still runs above where it started.
  const marks = aeRaiseMarks(child.labels, { model: nowModel, effort });
  const raised = marks.raised;
  const raisedTitle = marks.title;
  if (!role && !model && !effort && cost === null && tokens === null && !own && !raised)
    return null;
  return (
    <p
      className={cn(
        "mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground",
        className,
      )}
      data-testid="subagent-meta-line"
    >
      {role && (
        <span
          data-testid="subagent-role"
          className="shrink-0 rounded bg-foreground/[0.07] px-1.5 text-[10px] font-medium uppercase tracking-wide"
        >
          {aeRoleName(role)}
        </span>
      )}
      {model && (
        <span className="inline-flex min-w-0 items-center gap-1" data-testid="subagent-model-chip">
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              AE_MODEL_FAMILY_BG[aeModelFamily(model)],
            )}
          />
          <span className="truncate">
            {/^[a-z]+$/.test(model) ? aeNativeModelLabel(model) : agentModelLabel(model)}
          </span>
        </span>
      )}
      {effort && <span data-testid="subagent-effort">{effort}</span>}
      {raised && (
        <span data-testid="subagent-raised" title={raisedTitle} className="shrink-0 text-amber-500">
          &uarr;
        </span>
      )}
      {marks.capReached && (
        <span
          data-testid="subagent-cap-reached"
          className="shrink-0 rounded bg-foreground/[0.07] px-1.5 text-[10px]"
        >
          cap reached
        </span>
      )}
      {own && (
        <span
          className="ml-auto shrink-0 tabular-nums"
          data-testid="subagent-cost"
          title={own.title}
        >
          <span className="text-[10px] opacity-70" data-testid="subagent-tokens">
            {own.text}
          </span>
        </span>
      )}
      {(cost !== null || tokens !== null) && (
        <span className="ml-auto shrink-0 tabular-nums" data-testid="subagent-cost">
          {cost !== null && aeFormatCost(cost)}
          {tokens !== null && (
            <span className="text-[10px] opacity-70" data-testid="subagent-tokens">
              {cost !== null && " · "}
              {aeFormatTokens(tokens)} tok
            </span>
          )}
        </span>
      )}
    </p>
  );
}

/**
 * "This chat and its agents" with a bar split by model family. The lead's
 * usage covers its subagents, so its own share is what is left after them.
 */
export function AeAgentsTotal({
  rootSessionId,
  childIds,
  as: Tag = "li",
}: {
  rootSessionId: string;
  childIds: readonly string[];
  as?: "li" | "div";
}) {
  const usage = useContext(UsageContext);
  const mode = useAeSpendDisplay();
  const lead = usage.get(rootSessionId);
  if (!lead || mode === "off") return null;
  // Cost is the measure; tokens stand in only when the lead reports no cost.
  // Both mode needs one number, so it uses cost only when every session has one.
  const allRead = [lead, ...childIds.map((id) => usage.get(id))];
  const byCost =
    mode === "cost"
      ? lead.costUsd !== null
      : mode === "both" && allRead.every((u) => u !== undefined && u.costUsd !== null);
  const byTokens = mode === "tokens" || (mode === "both" && !byCost);
  const measure = (u: AeSessionUsage) =>
    byCost ? (u.costUsd ?? 0) : byTokens ? (aeUsageSpentTokens(u) ?? 0) : (u.tokens ?? 0);
  const leadValue = measure(lead);
  const leadFamilies = byCost ? lead.costByFamily : lead.byFamily;
  const known = childIds.map((id) => usage.get(id)).filter((u): u is AeSessionUsage => !!u);
  const childSum = known.reduce((sum, u) => sum + measure(u), 0);
  // Every child here is in the lead's spawn tree, so its usage already holds them.
  // The max covers a lead read that is older than the children's.
  const total = Math.max(leadValue, childSum);
  // With an unread child (a folded group), the lead's share cannot be told apart.
  // Float residue under half a cent is a true zero.
  const rest = Math.max(0, total - childSum);
  const own = known.length === childIds.length ? (rest < 0.005 ? 0 : rest) : null;
  // A stale lead read has no trustworthy split, so the children's stand in.
  const byFamily: Record<string, number> = childSum > leadValue ? {} : { ...leadFamilies };
  if (childSum > leadValue) {
    for (const u of known) {
      for (const [family, n] of Object.entries(byCost ? u.costByFamily : u.byFamily)) {
        byFamily[family] = (byFamily[family] ?? 0) + (n ?? 0);
      }
    }
  }
  // Tokens mode: sessions without a count leave the total short, so it ends in "+".
  const noCount = byTokens ? [lead, ...known].filter((u) => aeUsageSpentTokens(u) === null) : [];
  const plus = noCount.length > 0 ? "+" : "";
  const fmt = (n: number) => (byCost ? aeFormatCost(n) : `${aeFormatTokens(n)}${plus} tokens`);
  // Tokens only when every model in the lead and the rows read reports them.
  const tokenTotal =
    byCost && lead.tokens !== null && known.every((u) => u.tokens !== null)
      ? Math.max(
          lead.tokens,
          known.reduce((sum, u) => sum + (u.tokens ?? 0), 0),
        )
      : null;
  if (total <= 0) return null;
  const sum = Object.values(byFamily).reduce((a, b) => a + b, 0) || 1;
  const parts = AE_MODEL_FAMILIES.map((family) => ({ family, n: byFamily[family] ?? 0 })).filter(
    (p) => p.n > 0,
  );
  return (
    <Tag data-testid="agents-total" className="mt-1 border-t border-border/60 px-2.5 py-2 text-xs">
      <div className="text-muted-foreground">
        This chat and its agents:{" "}
        <b
          className="font-medium text-foreground tabular-nums"
          title={
            byTokens
              ? noCount.length > 0
                ? `${noCount.length} session${noCount.length === 1 ? " has" : "s have"} no token count`
                : "New input plus output tokens"
              : "Estimated at API rates"
          }
          data-testid="agents-total-cost"
        >
          {fmt(total)}
        </b>{" "}
        {own !== null && <>(lead {fmt(own)})</>}
        {tokenTotal !== null && tokenTotal > 0 && (
          <span data-testid="agents-total-tokens"> · {aeFormatTokens(tokenTotal)} tokens</span>
        )}
      </div>
      <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        {parts.map((p) => (
          <span
            key={p.family}
            className={AE_MODEL_FAMILY_BG[p.family]}
            style={{ width: `${(p.n / sum) * 100}%` }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        {parts.map((p) => (
          <span key={p.family} className="inline-flex items-center gap-1">
            <span className={cn("size-1.5 rounded-full", AE_MODEL_FAMILY_BG[p.family])} />
            {AE_MODEL_FAMILY_NAMES[p.family]} {Math.round((p.n / sum) * 100)}%
          </span>
        ))}
      </div>
    </Tag>
  );
}
