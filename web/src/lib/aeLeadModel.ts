// A preset's fixed lead model (omnigent-ae, 2026-10-24). A preset whose lead
// role is "fixed" (YOLO: Fable at max) used to change only the label, so the
// composer stayed on its old model while the lead notice said otherwise. Picking
// such a preset now also sets the session's model and effort, resolved against
// the model options the picker offers, with a toast and an Undo that puts back
// only what is still as the switch left it. A lead of "session" or "auto"
// changes nothing about the model.

import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { aeWithClaudeVersions } from "@/lib/aeClaudeModels";
import { type AeRoleEffort, type AeRolePreset, aeModelLabel } from "@/lib/aeRoles";
import { comparableModelId } from "@/lib/codexNativeModels";
import { supportsEffortControl } from "@/lib/sessionCapabilities";
import { getSessionSlim, updateSession } from "@/lib/sessionsApi";
import type { NativeModelOption, Session } from "@/lib/types";

export interface AeFixedLead {
  model: string;
  effort: AeRoleEffort;
}

/** The preset's lead model and effort when its lead role is fixed, else null. */
export function aeFixedLead(preset: Pick<AeRolePreset, "roles"> | null | undefined) {
  const lead = preset?.roles?.lead;
  return lead?.mode === "fixed" ? { model: lead.model, effort: lead.effort } : null;
}

/** The picker option that runs `model` (a catalog id), or null when the host offers none. */
export function aeFindLeadOption(
  model: string,
  options: readonly NativeModelOption[],
): NativeModelOption | null {
  const want = comparableModelId(model);
  if (!want) return null;
  const matches = options.filter(
    (o) => comparableModelId(o.model) === want || comparableModelId(o.id) === want,
  );
  // The plain row over a "[1m]" context variant of the same model.
  return matches.find((o) => !/\[1m\]$/i.test(o.id)) ?? matches[0] ?? null;
}

/**
 * The model options the composer's picker shows: the session's own catalog
 * (`sessionRows`) once it is bound, else the host's cached probe rows for the
 * session's harness only. No harness, no fallback: a model another harness
 * offers is never one this session can run.
 */
export function aeLeadModelOptions(
  queryClient: QueryClient,
  hostId: string | null | undefined,
  sessionRows: readonly NativeModelOption[] = [],
  harness?: string | null,
): NativeModelOption[] {
  const rows: NativeModelOption[] = [...sessionRows];
  if (!rows.length && hostId && harness) {
    const data = queryClient.getQueryData<NativeModelOption[]>([
      "host-model-options",
      hostId,
      harness,
    ]);
    if (Array.isArray(data)) rows.push(...data);
  }
  return aeWithClaudeVersions(rows);
}

type OnSession = (session: Session) => void;

interface Setting {
  model: string | null;
  effort: string | null;
}

export type AeLeadSwitch =
  | { kind: "none" }
  | { kind: "same" }
  | { kind: "missing"; name: string }
  /** The model write returned, but the session is not on the target model. */
  | { kind: "not_taken"; name: string }
  | {
      kind: "switched";
      label: string;
      before: Setting;
      after: Setting;
      /** Whether the effort was written (harnesses without effort control skip it). */
      effortSet: boolean;
      effortError: string | null;
    };

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Writes the session's model or effort and resolves to the value the server kept. */
export type AeLeadWriter = (
  field: "model" | "effort",
  value: string | null,
) => Promise<string | null>;

/** A writer that PATCHes the session and hands each saved session to `on`. */
export function aePatchLeadWriter(sessionId: string, on: OnSession): AeLeadWriter {
  return async (field, value) => {
    const updated = await updateSession(
      sessionId,
      field === "model" ? { modelOverride: value } : { reasoningEffort: value },
    );
    on(updated);
    return (field === "model" ? updated.modelOverride : updated.reasoningEffort) ?? null;
  };
}

/**
 * Put the session's model and effort on `lead`, resolved against `options`.
 * A missing option changes nothing; the caller says so. Throws only when the
 * model write fails; an effort failure is reported in the result.
 */
export async function aeSwitchLead(
  sessionId: string,
  lead: AeFixedLead | null,
  options: readonly NativeModelOption[],
  write: AeLeadWriter,
): Promise<AeLeadSwitch> {
  if (!lead) return { kind: "none" };
  const option = aeFindLeadOption(lead.model, options);
  if (!option) return { kind: "missing", name: aeModelLabel(lead.model) };
  const session = await getSessionSlim(sessionId);
  const before: Setting = {
    model: session.modelOverride ?? null,
    effort: session.reasoningEffort ?? null,
  };
  const withEffort = supportsEffortControl(session);
  // The same model in another context variant ("[1m]") counts as the same: it stays.
  // The picker id may be a tier alias ("fable") for the model the session names in full.
  const current = comparableModelId(before.model);
  const sameModel =
    current === comparableModelId(option.id) ||
    (option.model != null && current === comparableModelId(option.model));
  if (sameModel && (!withEffort || before.effort === lead.effort)) {
    return { kind: "same" };
  }
  const name = option.displayName ?? aeModelLabel(option.model ?? option.id);
  const after: Setting = { ...before };
  if (!sameModel) {
    after.model = await write("model", option.id);
    if (comparableModelId(after.model) !== comparableModelId(option.id)) {
      return { kind: "not_taken", name };
    }
  }
  let effortSet = false;
  let effortError: string | null = null;
  if (withEffort && before.effort !== lead.effort) {
    try {
      after.effort = await write("effort", lead.effort);
      effortSet = true;
    } catch (error) {
      effortError = reasonOf(error);
    }
  }
  return {
    kind: "switched",
    label: withEffort ? `${name} ${lead.effort}` : name,
    before,
    after,
    effortSet,
    effortError,
  };
}

/** Undo a switch: put back the model and effort that are still as it left them. */
export async function aeUndoLead(
  sessionId: string,
  applied: Extract<AeLeadSwitch, { kind: "switched" }>,
  write: AeLeadWriter,
): Promise<{ restored: string[]; kept: string[] }> {
  const now = await getSessionSlim(sessionId);
  const restored: string[] = [];
  const kept: string[] = [];
  const { before, after } = applied;
  if (before.model !== after.model) {
    if ((now.modelOverride ?? null) === after.model) {
      await write("model", before.model);
      restored.push("the model");
    } else {
      kept.push("the model");
    }
  }
  if (applied.effortSet) {
    if ((now.reasoningEffort ?? null) === after.effort) {
      await write("effort", before.effort);
      restored.push("the effort");
    } else {
      kept.push("the effort");
    }
  }
  return { restored, kept };
}

/** The sentence a toast uses for a switch result, or null when there is nothing to say. */
export function aeLeadSentence(result: AeLeadSwitch): string | null {
  if (result.kind === "missing") {
    return `This host does not offer ${result.name}, so the model was not changed.`;
  }
  if (result.kind === "not_taken") {
    return `The switch to ${result.name} did not take, so the model is as it was. Use the model picker.`;
  }
  if (result.kind !== "switched") return null;
  const effortNote = result.effortError ? ` (effort not changed: ${result.effortError})` : "";
  return `Lead switched to ${result.label}${effortNote}.`;
}

/** The "Lead switched to X" toast with Undo, after a preset pick from the pill, Alt digit or dialog. */
export function aeAnnounceLead(
  sessionId: string,
  presetTitle: string,
  result: AeLeadSwitch,
  write: AeLeadWriter,
) {
  const sentence = aeLeadSentence(result);
  if (!sentence) {
    // A fixed lead already on its model: the pick still gets its toast.
    if (result.kind === "same") toast(`Roles preset: ${presetTitle}`, { duration: 2_000 });
    return;
  }
  if (result.kind !== "switched") {
    toast(`Roles preset: ${presetTitle}. ${sentence}`, { duration: 6_000 });
    return;
  }
  toast(sentence.slice(0, -1), {
    duration: 10_000,
    action: {
      label: "Undo",
      onClick: () =>
        void aeUndoLead(sessionId, result, write).then(
          ({ restored, kept }) => {
            const left = kept.length
              ? ` Left ${kept.join(" and ")} as it is now, since it changed after the switch.`
              : "";
            toast(
              restored.length
                ? `Put back ${restored.join(" and ")}.${left}`
                : `Nothing put back.${left}`,
            );
          },
          (error: unknown) =>
            toast(`Could not undo the lead switch: ${reasonOf(error)}. Use the model picker.`),
        ),
    },
  });
}
