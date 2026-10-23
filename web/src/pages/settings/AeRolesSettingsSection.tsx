// Settings > Roles (omnigent-ae, 2026-10-23): the user's role presets. One
// preset is open in the editor; edits to its role table and rules stay local
// until Save, while list changes (pin, reorder, default, new, duplicate,
// delete, restore starters) save at once. Every save sends the whole list on
// the revision it was read at; when another device saved first, the server's
// list replaces this one and a toast says so.

import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { showToast } from "@/components/ui/toast";
import { useAeRoles, useAeRolesSave } from "@/hooks/useAeRoles";
import { useHostModelOptions, useHosts } from "@/hooks/useHosts";
import { aeWithClaudeVersions } from "@/lib/aeClaudeModels";
import {
  AE_PRESET_LIMIT,
  type AeRolePreset,
  type AeRolesDoc,
  type AeRolesState,
  aeDeletePreset,
  aeDropPreset,
  aeDuplicatePreset,
  aeIsTopTierEverywhere,
  aeModelLabel,
  aeNormalizeOrder,
  aePresetId,
  aeReplacePreset,
  aeRestoreStarters,
  aeSameRoles,
  aeSetPinned,
} from "@/lib/aeRoles";
import { type AeRoleDraft, type AeRoleModelChoice, AeRolesEditor } from "./AeRolesEditor";
import { type AePresetDetails, AeRolesPresetForm } from "./AeRolesPresetForm";
import { AeRolesCollapsedRow, AeRolesPresetList } from "./AeRolesPresetRow";

/** The Claude catalog the role table offers. */
const CLAUDE_HARNESS = "claude-native";

const CONFLICT = "Your roles changed on another device, so the saved presets were reloaded.";

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The host's Claude models, one row per catalog id, labeled "Opus 5.5". */
function useRoleModels(): { models: AeRoleModelChoice[]; ids: string[]; note: string | null } {
  const hostsQuery = useHosts();
  const hosts = hostsQuery.data ?? [];
  const hostsLoaded = hostsQuery.isSuccess === true;
  const online = hosts.filter((h) => h.status === "online");
  const host =
    online.find((h) => h.configured_harnesses?.[CLAUDE_HARNESS] === true) ?? online[0] ?? null;
  const catalog = useHostModelOptions(host?.host_id ?? null, CLAUDE_HARNESS, true, { poll: false });
  return useMemo(() => {
    const seen = new Set<string>();
    const models: AeRoleModelChoice[] = [];
    for (const row of aeWithClaudeVersions(catalog.data ?? [])) {
      const value = (row.model ?? row.id).replace(/\[[^\]]*\]$/, "");
      if (seen.has(value)) continue;
      seen.add(value);
      models.push({ value, label: aeModelLabel(value) });
    }
    const note = !hostsLoaded
      ? null
      : !host
        ? "No host is online, so only the models already in this preset are listed."
        : catalog.isError
          ? "The model list is unavailable right now; the models already in this preset still save."
          : null;
    return { models, ids: models.map((m) => m.value), note };
  }, [catalog.data, catalog.isError, host, hostsLoaded]);
}

export function AeRolesSettingsSection() {
  const query = useAeRoles();
  const save = useAeRolesSave();
  const { models, ids: catalogIds, note } = useRoleModels();
  const [openPick, setOpenPick] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, AeRoleDraft>>({});
  const [busy, setBusy] = useState(false);
  // A second click in the same render must not send a save on the old revision.
  const saving = useRef(false);
  const [form, setForm] = useState<"new" | "edit" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const state = query.data;
  if (query.isPending) {
    return <p className="text-sm text-muted-foreground">Loading your presets…</p>;
  }
  if (!state) {
    return (
      <div className="flex flex-col items-start gap-2 text-sm">
        <p className="text-muted-foreground">
          Could not load your presets: {reasonOf(query.error)}.
        </p>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  /** Save `next` (built on `state`); true once saved. */
  const commit = async (next: AeRolesDoc, done?: string): Promise<boolean> => {
    if (saving.current) return false;
    saving.current = true;
    setBusy(true);
    try {
      const result = await save(aeNormalizeOrder({ ...next, revision: state.revision }));
      if (!result.ok) {
        showToast(`${CONFLICT} Check them and try again.`);
        return false;
      }
      if (done) showToast(done);
      return true;
    } catch (error) {
      showToast(`Could not save your presets: ${reasonOf(error)}. Nothing changed; try again.`);
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  const presets = state.presets;
  const open =
    presets.find((p) => p.id === openPick) ??
    presets.find((p) => p.id === state.default_preset) ??
    presets[0];
  const starterIds = new Set(state.starters.map((s) => s.id));
  const missingStarters = state.starters.filter((s) => !presets.some((p) => p.id === s.id));

  const restore = async (current: AeRolesState) => {
    const { doc, added } = aeRestoreStarters(current, current.starters);
    if (added.length === 0) {
      const missing = current.starters.some((s) => !current.presets.some((p) => p.id === s.id));
      showToast(
        missing && current.presets.length >= AE_PRESET_LIMIT
          ? `You have ${AE_PRESET_LIMIT} presets, the most there can be, so no starter can be restored. Delete one first.`
          : "Every starter is already in your list.",
      );
      return;
    }
    await commit(doc, `Restored ${added.map((s) => s.title).join(", ")}.`);
  };

  if (!open) {
    return (
      <div data-testid="ae-roles-settings" className="flex flex-col items-start gap-2 text-sm">
        <p className="text-muted-foreground">You have no presets.</p>
        <Button size="sm" disabled={busy} onClick={() => void restore(state)}>
          Restore starters
        </Button>
      </div>
    );
  }

  const saved: AeRoleDraft = { roles: open.roles, rules: open.rules };
  const draft = drafts[open.id] ?? saved;
  const dirty = !aeSameRoles(draft, saved);
  const dropDraft = (id: string) => setDrafts(({ [id]: _dropped, ...rest }) => rest);

  const saveDraft = async () => {
    const target = open;
    const snapshot: AeRoleDraft = { roles: draft.roles, rules: draft.rules };
    const ok = await commit(
      aeReplacePreset(state, { ...target, roles: snapshot.roles, rules: snapshot.rules }),
      `Saved ${target.title}.`,
    );
    // Clear the draft only if it is still what was submitted; a newer edit stays.
    if (ok) {
      setDrafts((all) => {
        const current = all[target.id];
        if (current && !aeSameRoles(current, snapshot)) return all;
        const { [target.id]: _dropped, ...rest } = all;
        return rest;
      });
    }
  };

  const submitForm = async (details: AePresetDetails) => {
    const meta = {
      title: details.title,
      icon: details.icon,
      color: details.color,
      description: details.description,
      when_to_use: details.when_to_use,
    };
    if (form === "edit") {
      const next = aeReplacePreset(state, { ...open, ...meta });
      const ok = await commit(
        details.makeDefault ? { ...next, default_preset: open.id } : next,
        `Saved ${details.title}.`,
      );
      if (ok) setForm(null);
      return;
    }
    const id = aePresetId(
      details.title,
      presets.map((p) => p.id),
    );
    const created: AeRolePreset = {
      id,
      ...meta,
      pinned: false,
      roles: { ...draft.roles },
      rules: { ...draft.rules },
    };
    const next = { ...state, presets: [...presets, created] };
    const ok = await commit(
      details.makeDefault ? { ...next, default_preset: id } : next,
      `Created ${details.title}.`,
    );
    if (ok) {
      setForm(null);
      setOpenPick(id);
    }
  };

  const remove = async () => {
    const target = open;
    const next = aeDeletePreset(state, target.id);
    const fallback = presets.find((p) => p.id === next.default_preset);
    const ok = await commit(
      next,
      `Deleted ${target.title}. Sessions that used it now use ${fallback?.title ?? "your default"}.`,
    );
    setConfirmDelete(false);
    if (ok) {
      dropDraft(target.id);
      setOpenPick(null);
    }
  };

  const nextDefault =
    open.id === state.default_preset
      ? presets.find((p) => p.id !== open.id)
      : presets.find((p) => p.id === state.default_preset);

  return (
    <div data-testid="ae-roles-settings" className="flex flex-col gap-4">
      <p className="text-ui text-muted-foreground">
        Pick a preset to edit it. Your default starts every new session.
      </p>
      <AeRolesCollapsedRow
        presets={presets}
        openId={open.id}
        defaultId={state.default_preset}
        listOpen={listOpen}
        onOpen={setOpenPick}
        onToggleList={() => setListOpen((v) => !v)}
        onNew={() => setForm("new")}
        canAdd={presets.length < AE_PRESET_LIMIT && !busy}
      />
      {listOpen && (
        <AeRolesPresetList
          presets={presets}
          openId={open.id}
          defaultId={state.default_preset}
          missingStarters={missingStarters.length}
          busy={busy}
          onOpen={setOpenPick}
          onPin={(id, pinned) => void commit(aeSetPinned(state, id, pinned))}
          onMove={(id, to) => {
            const over = presets[to];
            if (over) void commit(aeDropPreset(state, id, over.id));
          }}
          onDrop={(id, overId) => void commit(aeDropPreset(state, id, overId))}
          onRestore={() => void restore(state)}
        />
      )}
      <div className="rounded-xl border border-border p-4">
        <AeRolesEditor
          preset={open}
          draft={draft}
          isDefault={open.id === state.default_preset}
          isStarter={starterIds.has(open.id)}
          models={models}
          catalogNote={note}
          topTier={aeIsTopTierEverywhere(draft.roles, catalogIds)}
          dirty={dirty}
          saving={busy}
          canDelete={presets.length > 1}
          onChange={(next) => setDrafts((d) => ({ ...d, [open.id]: next }))}
          onRevert={() => dropDraft(open.id)}
          onSave={() => void saveDraft()}
          onMakeDefault={() =>
            void commit({ ...state, default_preset: open.id }, `${open.title} is now your default.`)
          }
          onEdit={() => setForm("edit")}
          onDuplicate={() => {
            if (presets.length >= AE_PRESET_LIMIT) {
              showToast(
                `You have ${AE_PRESET_LIMIT} presets, the most there can be. Delete one first.`,
              );
              return;
            }
            const { doc, id } = aeDuplicatePreset(state, {
              ...open,
              roles: draft.roles,
              rules: draft.rules,
            });
            void commit(doc, `Duplicated ${open.title}.`).then((ok) => ok && setOpenPick(id));
          }}
          onDelete={() => setConfirmDelete(true)}
        />
      </div>
      {!listOpen && missingStarters.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Removed a starter?{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => void restore(state)}
            className="text-teal-400 hover:underline disabled:opacity-50"
          >
            Restore starters
          </button>
        </p>
      )}

      {form && (
        <AeRolesPresetForm
          mode={form}
          initial={
            form === "edit"
              ? open
              : {
                  title: "",
                  icon: open.icon,
                  color: open.color,
                  description: "",
                  when_to_use: "",
                }
          }
          sourceTitle={open.title}
          position={form === "edit" ? presets.indexOf(open) : presets.length}
          isDefault={form === "edit" && open.id === state.default_preset}
          saving={busy}
          onCancel={() => setForm(null)}
          onSubmit={(details) => void submitForm(details)}
        />
      )}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent data-testid="ae-preset-delete" className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {open.title}?</DialogTitle>
            <DialogDescription>
              Sessions using it fall back to your default
              {nextDefault ? ` (${nextDefault.title})` : ""}.
              {starterIds.has(open.id) ? " Restore starters brings it back." : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void remove()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
