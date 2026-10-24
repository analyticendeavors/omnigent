// Applying a START ON line (omnigent-ae, 2026-10-23). The composer queues what
// a session's first message asks for; the chat store's send applies it right
// after the session exists and before the message is posted, so the first turn
// already runs on it. A toast says "Started on X" with Undo, which puts back
// the preset, model and effort the session had. Failures never block the send.
// A preset with a fixed lead also switches the model and effort (2026-10-24).

import { toast } from "sonner";
import {
  type AeSessionRoles,
  aeRememberPreset,
  aeRolesForPick,
  aeSameSessionRoles,
  aeTeamLabelWithRoles,
  AE_TEAM_LABEL_KEY,
  readAeSessionRoles,
  readAeTeamLabelMode,
} from "@/lib/aeSessionRoles";
import { fetchAeRoles } from "@/hooks/useAeRoles";
import {
  type AeFixedLead,
  type AeLeadSwitch,
  aeFixedLead,
  aeLeadSentence,
  aePatchLeadWriter,
  aeSwitchLead,
  aeUndoLead,
} from "@/lib/aeLeadModel";
import { type AeStartOnTarget, aeParseStartOn } from "@/lib/aeStartOn";
import { supportsEffortControl } from "@/lib/sessionCapabilities";
import { getSessionSlim, updateSession } from "@/lib/sessionsApi";
import type { NativeModelOption, Session } from "@/lib/types";

/** A first message carrying a START ON line, and the model options its composer offered. */
export interface AeStartOnQueued {
  text: string;
  models: readonly NativeModelOption[];
}

export interface AeStartOnPlan {
  target: AeStartOnTarget;
  /** The user's default preset id, which a preset pick writes as "no field". */
  defaultId: string;
  /** A picked preset's fixed lead, and the model options to resolve it against. */
  lead: AeFixedLead | null;
  models: readonly NativeModelOption[];
}

/** A queued plan older than this is dropped rather than applied to a later send. */
const QUEUE_TTL_MS = 120_000;
/** Longest the first send waits for the PATCHes before it goes out anyway. */
const APPLY_BUDGET_MS = 8_000;
const NEW_SESSION = "\u0000new";

let queued: { key: string; plan: AeStartOnQueued; at: number } | null = null;

/** Queue `plan` for the next send to `sessionId` (null: the session the send creates). */
export function aeQueueStartOn(sessionId: string | null, plan: AeStartOnQueued) {
  queued = { key: sessionId ?? NEW_SESSION, plan, at: Date.now() };
}

/**
 * Forget the queued plan: when a later message has no START ON line, and when
 * the send it was queued for ends without applying it. `sessionId` limits it
 * to that destination (undefined clears whatever is queued).
 */
export function aeDropStartOn(sessionId?: string | null) {
  if (!queued) return;
  if (sessionId === undefined || queued.key === (sessionId ?? NEW_SESSION)) queued = null;
}

/** The plan queued for a send to `sessionId`, once; null when none or stale. */
export function aeTakeStartOn(sessionId: string | null): AeStartOnQueued | null {
  const entry = queued;
  if (!entry || entry.key !== (sessionId ?? NEW_SESSION)) return null;
  queued = null;
  return Date.now() - entry.at <= QUEUE_TTL_MS ? entry.plan : null;
}

type OnSession = (session: Session) => void;

interface Before {
  roles: AeSessionRoles | null;
  /** The label's mode and exact text before, so Undo can put a legacy Solo label back as it was. */
  mode: string | null;
  labelText: string | undefined;
  model: string | null;
  effort: string | null;
  /** Whether the effort was changed too (harnesses without effort control skip it). */
  effortSet: boolean;
}

/** What START ON left on the session, so Undo only touches what is still as it set it. */
interface After {
  roles: AeSessionRoles | null;
  labelText: string | undefined;
  model: string | null;
  effort: string | null;
}

interface Applied {
  before: Before;
  after: After;
  /** Set when the model landed but the effort PATCH failed. */
  effortError: string | null;
  /** What a preset's fixed lead did to the model, or why it did nothing. */
  lead: AeLeadSwitch | null;
  leadError: string | null;
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function aeApplyPlan(
  sessionId: string,
  plan: AeStartOnPlan,
  onSession: OnSession,
): Promise<Applied> {
  const session = await getSessionSlim(sessionId);
  const before: Before = {
    roles: readAeSessionRoles(session.labels),
    mode: readAeTeamLabelMode(session.labels),
    labelText: session.labels?.[AE_TEAM_LABEL_KEY],
    model: session.modelOverride ?? null,
    effort: session.reasoningEffort ?? null,
    effortSet: false,
  };
  const after: After = {
    roles: before.roles,
    labelText: before.labelText,
    model: before.model,
    effort: before.effort,
  };
  let effortError: string | null = null;
  let lead: AeLeadSwitch | null = null;
  let leadError: string | null = null;
  const { target } = plan;
  if (target.kind === "preset") {
    const roles = aeRolesForPick(target.presetId, plan.defaultId);
    const updated = await updateSession(sessionId, {
      labels: { [AE_TEAM_LABEL_KEY]: aeTeamLabelWithRoles(session.labels, roles) },
    });
    onSession(updated);
    after.roles = readAeSessionRoles(updated.labels);
    after.labelText = updated.labels?.[AE_TEAM_LABEL_KEY];
    aeRememberPreset(target.presetId);
    if (plan.lead) {
      try {
        const write = aePatchLeadWriter(sessionId, onSession);
        lead = await aeSwitchLead(sessionId, plan.lead, plan.models, write);
      } catch (error) {
        leadError = reasonOf(error);
      }
    }
  } else {
    const updated = await updateSession(sessionId, { modelOverride: target.model });
    onSession(updated);
    after.model = updated.modelOverride ?? null;
    if (target.effort && supportsEffortControl(session)) {
      try {
        const withEffort = await updateSession(sessionId, { reasoningEffort: target.effort });
        onSession(withEffort);
        after.effort = withEffort.reasoningEffort ?? null;
        before.effortSet = true;
      } catch (error) {
        effortError = reasonOf(error);
      }
    }
  }
  return { before, after, effortError, lead, leadError };
}

async function undo(
  sessionId: string,
  target: AeStartOnTarget,
  { before, after, lead }: Applied,
  on: OnSession,
) {
  try {
    const now = await getSessionSlim(sessionId);
    const restored: string[] = [];
    const kept: string[] = [];
    if (target.kind === "preset") {
      if (aeSameSessionRoles(readAeSessionRoles(now.labels), after.roles)) {
        // Untouched since START ON: put the exact previous label back; else
        // change only the roles, keeping a legacy Solo mode.
        const text =
          before.labelText !== undefined && now.labels?.[AE_TEAM_LABEL_KEY] === after.labelText
            ? before.labelText
            : aeTeamLabelWithRoles(now.labels, before.roles, before.mode);
        on(await updateSession(sessionId, { labels: { [AE_TEAM_LABEL_KEY]: text } }));
        restored.push("the roles preset");
      } else {
        kept.push("the roles preset");
      }
      if (lead?.kind === "switched") {
        const back = await aeUndoLead(sessionId, lead, aePatchLeadWriter(sessionId, on));
        restored.push(...back.restored);
        kept.push(...back.kept);
      }
    } else {
      if ((now.modelOverride ?? null) === after.model) {
        on(await updateSession(sessionId, { modelOverride: before.model }));
        restored.push("the model");
      } else {
        kept.push("the model");
      }
      if (before.effortSet) {
        if ((now.reasoningEffort ?? null) === after.effort) {
          on(await updateSession(sessionId, { reasoningEffort: before.effort }));
          restored.push("the effort");
        } else {
          kept.push("the effort");
        }
      }
    }
    const left = kept.length
      ? ` Left ${kept.join(" and ")} as it is now, since it changed after START ON.`
      : "";
    toast(
      restored.length ? `Put back ${restored.join(" and ")}.${left}` : `Nothing put back.${left}`,
    );
  } catch (error) {
    toast(`Could not undo START ON: ${reasonOf(error)}. Change it from the composer instead.`);
  }
}

/** The "Started on X" toast with Undo (and a note when the effort did not land). */
function announce(sessionId: string, plan: AeStartOnPlan, applied: Applied, on: OnSession) {
  const { target } = plan;
  const partial = target.kind === "model" && applied.effortError !== null && target.effort;
  const name = partial ? target.label.slice(0, -(target.effort!.length + 1)) : target.label;
  const leadNote = applied.leadError
    ? ` Could not switch the lead model: ${applied.leadError}.`
    : applied.lead
      ? ` ${aeLeadSentence(applied.lead) ?? ""}`.trimEnd()
      : "";
  toast(
    partial
      ? `Started on ${name}; effort ${target.effort} was not applied (${applied.effortError}).`
      : leadNote
        ? `Started on ${target.label}.${leadNote}`
        : `Started on ${target.label}`,
    {
      duration: 10_000,
      action: { label: "Undo", onClick: () => void undo(sessionId, target, applied, on) },
    },
  );
}

/**
 * Apply the START ON line queued for this send, if any, to the session it
 * posts to: only when Settings > Roles "Apply START ON lines" is on and the
 * line names a known preset or model. Never throws and never waits long: past
 * the budget the send goes out and the "Started on" toast follows when the
 * PATCHes finish.
 */
export async function aeApplyQueuedStartOn(
  queuedFor: string | null,
  sessionId: string,
  onSession: OnSession,
): Promise<void> {
  const queuedLine = aeTakeStartOn(queuedFor);
  if (!queuedLine) return;
  const held: { plan: AeStartOnPlan | null } = { plan: null };
  const work = async () => {
    const state = await fetchAeRoles();
    if (!state.apply_start_on) return;
    const target = aeParseStartOn(queuedLine.text, state.presets, queuedLine.models);
    if (!target) return;
    const preset =
      target.kind === "preset" ? state.presets.find((p) => p.id === target.presetId) : undefined;
    const plan: AeStartOnPlan = {
      target,
      defaultId: state.default_preset,
      lead: aeFixedLead(preset),
      models: queuedLine.models,
    };
    held.plan = plan;
    announce(sessionId, plan, await aeApplyPlan(sessionId, plan, onSession), onSession);
  };
  const running = work().catch((error: unknown) => {
    // Presets unreadable before anything was chosen: send as is, quietly.
    if (!held.plan) return;
    toast(
      `Could not apply START ON (${held.plan.target.label}): ${reasonOf(error)}. The message was sent as is.`,
    );
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), APPLY_BUDGET_MS);
  });
  try {
    const first = await Promise.race([running.then(() => "done" as const), budget]);
    if (first === "late" && held.plan) {
      toast(
        `START ON is taking a while; ${held.plan.target.label} may apply after the first turn.`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
