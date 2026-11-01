// Settings > Roles: reviewer personas (omnigent-ae, 2026-11-01, patch 0277). The built-in
// personas come first, read-only with a Duplicate button; the user's own follow with Edit,
// Duplicate and Delete, and Add persona makes a new one. Every change saves at once, on the
// revision the page read, through the same save as the preset list. A reviewer slot picks a
// persona in the preset editor; deleting one a preset still names asks first and names them.

import { useId, useState } from "react";
import { CopyIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { AeHint } from "@/components/AeHint";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAeRoleModels } from "@/hooks/useAeRoleModels";
import {
  AE_PERSONAS_MAX,
  AE_PERSONA_INSTRUCTIONS_MAX,
  AE_PERSONA_NAME_MAX,
  AE_PERSONA_PURPOSE_MAX,
  AE_PERSONA_TRIGGER_MAX,
  AE_PERSONA_WHEN_OPTIONS,
  type AePersona,
  type AePersonaEntry,
  type AePersonaWhen,
  aeAllPersonas,
  aeDuplicatePersona,
  aeNormalizeNewlines,
  aePersonaId,
  aePersonaProblems,
  aePersonaUsers,
} from "@/lib/aePersonas";
import { AE_ROLE_EFFORTS, type AeRoleEffort, aeModelLabel } from "@/lib/aeRoleBase";
import type { AeRolesState } from "@/lib/aeRoles";
import { aeOneLine } from "@/lib/aeRoles";
import { aeClaudeEffortLabel } from "@/lib/aeEffortDefault";
import type { AeSettingHintId } from "@/lib/aeSettingHints";

const FIELD =
  "w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground";

interface Draft {
  /** The id being edited; "" for a persona not yet saved. */
  id: string;
  name: string;
  purpose: string;
  model: string;
  effort: AeRoleEffort | "";
  when: AePersonaWhen;
  trigger: string;
  instructions: string;
}

const EMPTY: Draft = {
  id: "",
  name: "",
  purpose: "",
  model: "",
  effort: "",
  when: "always",
  trigger: "",
  instructions: "",
};

function draftOf(persona: AePersona, id: string): Draft {
  return {
    id,
    name: persona.name,
    purpose: persona.purpose,
    model: persona.model ?? "",
    effort: persona.effort ?? "",
    when: persona.when,
    trigger: persona.trigger ?? "",
    instructions: persona.instructions,
  };
}

function personaOf(draft: Draft, id: string): AePersona {
  const trigger = aeOneLine(draft.trigger);
  return {
    id,
    name: aeOneLine(draft.name),
    purpose: aeOneLine(draft.purpose),
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.effort ? { effort: draft.effort } : {}),
    when: draft.when,
    ...(draft.when === "risky" && trigger ? { trigger } : {}),
    instructions: aeNormalizeNewlines(draft.instructions).trim(),
  };
}

function Field({
  label,
  hint,
  htmlFor,
  children,
  note,
}: {
  label: string;
  hint: AeSettingHintId;
  htmlFor: string;
  children: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          <label htmlFor={htmlFor}>{label}</label>
          <AeHint id={hint} />
        </span>
        {note}
      </div>
      {children}
    </div>
  );
}

function PersonaForm({
  mode,
  initial,
  models,
  saving,
  taken,
  onCancel,
  onSubmit,
}: {
  mode: "new" | "edit";
  initial: Draft;
  models: readonly { value: string; label: string }[];
  saving: boolean;
  /** Ids in use, built-in ones included, for the id a new persona gets. */
  taken: readonly string[];
  onCancel: () => void;
  onSubmit: (persona: AePersona) => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const ids = {
    name: useId(),
    purpose: useId(),
    model: useId(),
    effort: useId(),
    when: useId(),
    trigger: useId(),
    instructions: useId(),
  };
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const persona = personaOf(draft, initial.id || "pending");
  const problems = aePersonaProblems(persona);
  const count = aeNormalizeNewlines(draft.instructions).length;
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        data-testid="ae-persona-form"
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (problems.length > 0) return;
            onSubmit({ ...persona, id: initial.id || aePersonaId(persona.name, taken) });
          }}
        >
          <DialogHeader>
            <DialogTitle>{mode === "new" ? "New persona" : "Edit persona"}</DialogTitle>
            <DialogDescription>
              A reviewer brief a preset&apos;s reviewer can use. The lead copies the instructions
              into that reviewer&apos;s brief.
            </DialogDescription>
          </DialogHeader>
          <Field label="Name" hint="persona.name" htmlFor={ids.name}>
            <input
              id={ids.name}
              autoFocus
              maxLength={AE_PERSONA_NAME_MAX}
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Docs"
              className={FIELD}
            />
          </Field>
          <Field label="Purpose, one line" hint="persona.purpose" htmlFor={ids.purpose}>
            <input
              id={ids.purpose}
              maxLength={AE_PERSONA_PURPOSE_MAX}
              value={draft.purpose}
              onChange={(e) => set({ purpose: e.target.value })}
              placeholder="Check the docs match the change"
              className={FIELD}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Model" hint="persona.model" htmlFor={ids.model}>
              <select
                id={ids.model}
                value={draft.model}
                onChange={(e) => set({ model: e.target.value })}
                className={FIELD}
              >
                <option value="">The reviewer&apos;s own</option>
                {draft.model && !models.some((m) => m.value === draft.model) && (
                  <option value={draft.model}>{aeModelLabel(draft.model)}</option>
                )}
                {models.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Effort" hint="persona.effort" htmlFor={ids.effort}>
              <select
                id={ids.effort}
                value={draft.effort}
                onChange={(e) => set({ effort: e.target.value as AeRoleEffort | "" })}
                className={FIELD}
              >
                <option value="">The reviewer&apos;s own</option>
                {AE_ROLE_EFFORTS.map((effort) => (
                  <option key={effort} value={effort}>
                    {aeClaudeEffortLabel(effort)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Runs" hint="persona.when" htmlFor={ids.when}>
            <select
              id={ids.when}
              value={draft.when}
              onChange={(e) => set({ when: e.target.value as AePersonaWhen })}
              className={FIELD}
            >
              {AE_PERSONA_WHEN_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          {draft.when === "risky" && (
            <Field
              label="Risky means the diff touches"
              hint="persona.trigger"
              htmlFor={ids.trigger}
            >
              <input
                id={ids.trigger}
                maxLength={AE_PERSONA_TRIGGER_MAX}
                value={draft.trigger}
                onChange={(e) => set({ trigger: e.target.value })}
                placeholder="database migrations or schema changes"
                className={FIELD}
              />
            </Field>
          )}
          <Field
            label="Instructions"
            hint="persona.instructions"
            htmlFor={ids.instructions}
            note={
              <span
                data-testid="ae-persona-count"
                className={
                  count > AE_PERSONA_INSTRUCTIONS_MAX
                    ? "text-xs text-red-500"
                    : "text-xs text-muted-foreground"
                }
              >
                {count} / {AE_PERSONA_INSTRUCTIONS_MAX}
              </span>
            }
          >
            <textarea
              id={ids.instructions}
              rows={7}
              value={draft.instructions}
              onChange={(e) => set({ instructions: e.target.value })}
              className={FIELD}
            />
          </Field>
          {draft.name || draft.purpose || draft.instructions
            ? problems.length > 0 && (
                <ul data-testid="ae-persona-problems" className="text-xs text-amber-500">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )
            : null}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving || problems.length > 0}>
              {mode === "new" ? "Add persona" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function meta(p: AePersona): string {
  const parts = [
    p.model ? `${aeModelLabel(p.model)}${p.effort ? ` ${p.effort}` : ""}` : "Reviewer's own model",
    p.when === "risky" ? "only if the diff is risky" : "always",
  ];
  return parts.join(" · ");
}

export function AePersonasSection({
  state,
  busy,
  onSave,
}: {
  state: AeRolesState;
  busy: boolean;
  /** Save the user's personas; true once saved. */
  onSave: (personas: AePersona[], done: string) => Promise<boolean>;
}) {
  const { models } = useAeRoleModels();
  const mine = state.personas ?? [];
  const all = aeAllPersonas(state.builtin_personas ?? [], mine);
  const taken = all.map((p) => p.id);
  const [form, setForm] = useState<{ mode: "new" | "edit"; draft: Draft } | null>(null);
  const [removing, setRemoving] = useState<AePersona | null>(null);
  const full = mine.length >= AE_PERSONAS_MAX;
  const fullNote = `You have ${AE_PERSONAS_MAX} personas of your own, the most there can be. Delete one first.`;

  const submit = async (persona: AePersona) => {
    const editing = form?.mode === "edit";
    const next = editing
      ? mine.map((p) => (p.id === persona.id ? persona : p))
      : [...mine, persona];
    if (await onSave(next, editing ? `Saved ${persona.name}.` : `Added ${persona.name}.`)) {
      setForm(null);
    }
  };
  const users = removing ? aePersonaUsers(state.presets, removing.id) : [];
  const remove = async () => {
    if (!removing) return;
    const target = removing;
    if (
      await onSave(
        mine.filter((p) => p.id !== target.id),
        `Deleted ${target.name}.`,
      )
    ) {
      setRemoving(null);
    }
  };

  const row = (p: AePersonaEntry) => (
    <li
      key={p.id}
      data-testid={`ae-persona-${p.id}`}
      className="flex flex-wrap items-start justify-between gap-2 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {p.name}
          {p.builtin && (
            <span className="rounded-full bg-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground">
              Built-in
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">{p.purpose}</div>
        <div className="text-xs text-muted-foreground">{meta(p)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          aria-label={`Duplicate ${p.name}`}
          title={full ? fullNote : "Duplicate"}
          disabled={busy || full}
          onClick={() =>
            setForm({
              mode: "new",
              draft: draftOf(aeDuplicatePersona(p, taken), ""),
            })
          }
        >
          <CopyIcon />
          Duplicate
        </Button>
        {!p.builtin && (
          <>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={`Edit ${p.name}`}
              title="Edit"
              disabled={busy}
              onClick={() => setForm({ mode: "edit", draft: draftOf(p, p.id) })}
            >
              <PencilIcon />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={`Delete ${p.name}`}
              title="Delete"
              disabled={busy}
              onClick={() => setRemoving(p)}
            >
              <Trash2Icon />
            </Button>
          </>
        )}
      </div>
    </li>
  );

  return (
    <section
      data-testid="ae-personas"
      aria-labelledby="ae-personas-title"
      className="rounded-xl border border-border p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 id="ae-personas-title" className="text-sm font-semibold">
            Reviewer personas
            <AeHint id="personas" />
          </h3>
          <p className="text-xs text-muted-foreground">
            A reviewer in a preset can take a persona: a purpose, instructions, and whether it runs
            on every diff or only a risky one.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          title={full ? fullNote : undefined}
          disabled={busy || full}
          onClick={() => setForm({ mode: "new", draft: EMPTY })}
        >
          <PlusIcon />
          Add persona
        </Button>
      </div>
      <ul aria-label="Personas" className="mt-2 divide-y divide-border">
        {all.map(row)}
      </ul>
      {form && (
        <PersonaForm
          mode={form.mode}
          initial={form.draft}
          models={models}
          saving={busy}
          taken={taken}
          onCancel={() => setForm(null)}
          onSubmit={(persona) => void submit(persona)}
        />
      )}
      <Dialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent data-testid="ae-persona-delete" className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {removing?.name}?</DialogTitle>
            <DialogDescription>
              {users.length > 0
                ? `${users.join(", ")} ${users.length > 1 ? "use" : "uses"} it. Those reviewers keep their model but run as a plain review.`
                : "No preset uses it."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void remove()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
