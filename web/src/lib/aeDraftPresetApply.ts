// Applying the new chat's bound preset pick (omnigent-ae, 2026-10-24). The chat
// store calls this right after the first send creates the session and before
// the message posts, so the first turn already runs on the pick. The pill pick
// wins over a START ON line in the same message. Failures never block the send.

import { toast } from "sonner";
import { fetchAeRoles } from "@/hooks/useAeRoles";
import { aeTakeBoundPreset } from "@/lib/aeDraftPreset";
import { aeFixedLead, aeLeadSentence } from "@/lib/aeLeadModel";
import { AE_RESERVED_PRESET_ID } from "@/lib/aeRoles";
import { aeApplyPlan, aeApplyQueuedStartOn, aeDropStartOn } from "@/lib/aeStartOnApply";
import type { NativeModelOption, Session } from "@/lib/types";

/** Longest the first send waits for the PATCHes before it goes out anyway. */
const BUDGET_MS = 8_000;

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function applyBound(
  pickId: string,
  models: readonly NativeModelOption[],
  sessionId: string,
  onSession: (s: Session) => void,
  title: { current: string },
) {
  const state = await fetchAeRoles();
  const preset = state.presets.find((p) => p.id === pickId);
  const known = pickId === AE_RESERVED_PRESET_ID ? "Lead picks" : preset?.title;
  // A pick that no longer exists, or the default, writes nothing.
  if (!known || pickId === state.default_preset) return;
  title.current = known;
  const applied = await aeApplyPlan(
    sessionId,
    {
      target: { kind: "preset", presetId: pickId, label: known },
      defaultId: state.default_preset,
      lead: aeFixedLead(preset),
      models,
    },
    onSession,
  );
  // The label landed; a lead switch that did not is still a failure to report.
  const lead = applied.lead;
  const problem =
    applied.leadError ??
    (lead?.kind === "missing" || lead?.kind === "not_taken" ? aeLeadSentence(lead) : null) ??
    (lead?.kind === "switched" ? lead.effortError : null);
  if (problem) throw new Error(problem.replace(/\.$/, ""));
}

/**
 * Apply the preset pick bound to this new session, else the queued START ON
 * line. `queuedFor` is the conversation id the send was submitted for; the
 * bound pick applies only when it was bound to exactly that id.
 */
export async function aeApplyNewChatStart(
  queuedFor: string | null,
  sessionId: string,
  onSession: (s: Session) => void,
): Promise<void> {
  const bound = aeTakeBoundPreset(queuedFor);
  if (!bound) return aeApplyQueuedStartOn(queuedFor, sessionId, onSession);
  aeDropStartOn(queuedFor);
  const title = { current: bound.pick };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), BUDGET_MS);
  });
  const work = applyBound(bound.pick, bound.models, sessionId, onSession, title).then(
    () => "done" as const,
    (error: unknown) => {
      toast(
        `Could not apply the ${title.current} preset: ${reasonOf(error)}. The message was sent as is.`,
      );
      return "done" as const;
    },
  );
  try {
    if ((await Promise.race([work, late])) === "late") {
      toast(`The ${title.current} preset is taking a while and may apply after the first turn.`);
    }
  } finally {
    clearTimeout(timer);
  }
}
