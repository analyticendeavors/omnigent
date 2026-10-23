// The composer's roles preset pill (omnigent-ae, 2026-10-23): the session's
// preset icon and name beside the model picker. Its menu has a search box,
// "Lead picks", pinned and recent presets, then every preset with its Alt
// digit. A pick writes the `roles` field of the session's ae.team label.

import { ChevronDownIcon, SearchIcon, WandSparklesIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAePresetHotkey, useAeSessionPreset } from "@/hooks/useAeSessionPreset";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import { AE_PRESET_SHORTCUTS, AE_RESERVED_PRESET_ID, type AeRolePreset } from "@/lib/aeRoles";
import { aeChoiceId, aeReadRecentPresets } from "@/lib/aeSessionRoles";
import { useNavigate } from "@/lib/routing";
import { cn } from "@/lib/utils";
import { AeRolePresetTile } from "@/pages/settings/AeRolesControls";

function Row({
  preset,
  index,
  active,
  isDefault,
  onPick,
}: {
  preset: AeRolePreset;
  index: number;
  active: boolean;
  isDefault: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onPick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted",
        active && "bg-muted",
      )}
    >
      <AeRolePresetTile icon={preset.icon} color={preset.color} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm">
          <span className="truncate">{preset.title}</span>
          {isDefault && (
            <span className="shrink-0 rounded-full bg-teal-500/20 px-1.5 text-[10px] font-semibold text-teal-400">
              Default
            </span>
          )}
        </span>
        {preset.description && (
          <span className="block truncate text-xs text-muted-foreground">{preset.description}</span>
        )}
      </span>
      {index < AE_PRESET_SHORTCUTS && (
        <kbd className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
          Alt {index + 1}
        </kbd>
      )}
    </button>
  );
}

/** "Manage presets…": mounted only while the menu is open, so the pill needs no router until then. */
function ManagePresets({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => {
        onDone();
        navigate("/settings/roles");
      }}
      className="rounded-md border-t border-border px-2 pt-2 pb-1 text-left text-xs text-muted-foreground hover:text-foreground"
    >
      Manage presets…
    </button>
  );
}

export function AeSessionPresetPill({
  sessionId,
  disabled = false,
}: {
  sessionId: string;
  disabled?: boolean;
}) {
  const isMobile = useIsMobileViewport();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = useAeSessionPreset(sessionId);
  const { state, choice, pick } = current;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const onPresetKey = useAePresetHotkey(sessionId, current);
  // Alt 1 to 9 only while typing in this pill's own composer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement) || disabled) return;
      const card = triggerRef.current?.closest("[data-composer-card]");
      if (card?.contains(target)) onPresetKey(event);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [disabled, onPresetKey]);
  if (!state || !choice) return null;
  const activeId = aeChoiceId(choice);
  const name =
    choice.kind === "lead-picks"
      ? "Lead picks"
      : `${choice.preset.title}${choice.edited ? ", edited" : ""}`;
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = (text: string) => words.every((w) => text.toLowerCase().includes(w));
  const presets = state.presets;
  const shown = presets.filter((p) => matches(`${p.title} ${p.description}`));
  const recent = aeReadRecentPresets()
    .map((id) => presets.find((p) => p.id === id))
    .filter((p): p is AeRolePreset => !!p && !p.pinned);
  const choose = (id: string) => {
    setOpen(false);
    setQuery("");
    if (id !== activeId || (choice.kind === "preset" && choice.edited)) void pick(id);
  };
  const row = (preset: AeRolePreset, key: string) => (
    <Row
      key={key}
      preset={preset}
      index={presets.indexOf(preset)}
      active={preset.id === activeId}
      isDefault={preset.id === state.default_preset}
      onPick={() => choose(preset.id)}
    />
  );
  const heading = (text: string) => (
    <div className="px-2 pt-2 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
      {text}
    </div>
  );
  const pinned = shown.filter((p) => p.pinned);
  return (
    <Popover open={open} onOpenChange={(next) => (!next || !disabled) && setOpen(next)}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          data-testid="ae-preset-pill"
          aria-label={`Roles preset: ${name}`}
          title={`Roles preset: ${name}`}
          disabled={disabled}
          className="inline-flex h-8 max-w-48 min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-border py-0.5 pr-2 pl-0.5 text-xs hover:bg-accent disabled:opacity-50 max-sm:pr-0.5"
        >
          {choice.kind === "lead-picks" ? (
            <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-lg bg-teal-500/15 text-teal-400">
              <WandSparklesIcon className="size-3.5" />
            </span>
          ) : (
            <AeRolePresetTile icon={choice.preset.icon} color={choice.preset.color} size="sm" />
          )}
          {!isMobile && <span className="truncate">{name}</span>}
          {!isMobile && <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-80 max-w-[calc(100vw-2rem)] gap-1 p-1.5"
        data-testid="ae-preset-menu"
      >
        <label className="flex items-center gap-2 rounded-md border border-input px-2 py-1.5">
          <SearchIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search presets"
            aria-label="Search presets"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
        <div role="menu" aria-label="Roles presets" className="max-h-[60vh] overflow-y-auto">
          {matches("lead picks") && (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={activeId === AE_RESERVED_PRESET_ID}
              onClick={() => choose(AE_RESERVED_PRESET_ID)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted",
                activeId === AE_RESERVED_PRESET_ID && "bg-muted",
              )}
            >
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-lg bg-teal-500/15 text-teal-400">
                <WandSparklesIcon className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm">Lead picks</span>
                <span className="block truncate text-xs text-muted-foreground">
                  Chooses a preset per task and says which
                </span>
              </span>
            </button>
          )}
          {words.length === 0 && pinned.length > 0 && (
            <>
              {heading("Pinned")}
              {pinned.map((p) => row(p, `pinned-${p.id}`))}
            </>
          )}
          {words.length === 0 && recent.length > 0 && (
            <>
              {heading("Recent")}
              {recent.map((p) => row(p, `recent-${p.id}`))}
            </>
          )}
          {heading(words.length > 0 ? "Matches" : "All presets")}
          {shown.map((p) => row(p, `all-${p.id}`))}
          {shown.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">No preset matches.</p>
          )}
        </div>
        <ManagePresets onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
