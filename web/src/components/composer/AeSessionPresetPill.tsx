// The composer's roles preset pill (omnigent-ae, 2026-10-23): the session's
// preset icon and name beside the model picker. Its menu has a search box,
// "Lead picks", pinned and recent presets, then every preset with its Alt
// digit. A pick writes the `roles` field of the session's ae.team label.
// Since the Auto / Solo / Team button folded into presets (2026-10-23) it is
// the composer's one "who works on this" control: the menu also lists this
// chat's sessions and opens the full dialog, the pill counts added sessions,
// and on a phone the menu is a bottom sheet.

import { ChevronDownIcon, SearchIcon, UsersRoundIcon, WandSparklesIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAePresetHotkey, useAeSessionPreset } from "@/hooks/useAeSessionPreset";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import {
  AE_PRESET_SHORTCUTS,
  AE_RESERVED_PRESET_ID,
  type AeRolePreset,
  aeRoleSummary,
} from "@/lib/aeRoles";
import { aeChoiceId, aeReadRecentPresets } from "@/lib/aeSessionRoles";
import { useNavigate } from "@/lib/routing";
import { cn } from "@/lib/utils";
import { aeSessionsLockedHint } from "@/lib/aeTeamPresets";
import { AeRolePresetTile } from "@/pages/settings/AeRolesControls";
import { aeReviewerNumbers } from "@/lib/aeReviewers";
import { AePresetSessionsSection } from "./AePresetSessionsSection";

function Row({
  preset,
  index,
  active,
  isDefault,
  compact,
  onPick,
}: {
  preset: AeRolePreset;
  index: number;
  active: boolean;
  isDefault: boolean;
  compact: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      title={aeRoleSummary(preset.roles)}
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
      {!compact && index < AE_PRESET_SHORTCUTS && (
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
  working = false,
  onOpenTeam,
}: {
  sessionId: string;
  disabled?: boolean;
  /** A turn is running: sessions cannot be added or removed from the menu until it finishes. */
  working?: boolean;
  /** Opens the "Who works on this?" dialog; without it the menu has no sessions section. */
  onOpenTeam?: () => void;
}) {
  const isMobile = useIsMobileViewport();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = useAeSessionPreset(sessionId);
  const { state, choice, pick, team, setMember, locked, pending, rolesQuery } = current;
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
  if (!state || !choice) {
    // Presets did not load (yet): keep a pill-shaped way into "Who works on this?"
    // so Change lead and the sessions list stay reachable, and retry the read.
    const failed = rolesQuery.isError === true;
    const label = failed ? "Roles unavailable. Retry" : "Roles";
    return (
      <button
        ref={triggerRef}
        type="button"
        data-testid="ae-preset-pill-fallback"
        aria-label={failed ? "Retry roles presets" : "Loading roles presets"}
        title={
          failed
            ? "Could not load roles presets. Click to retry and open Who works on this?"
            : "Loading roles presets…"
        }
        disabled={disabled}
        onClick={() => {
          if (failed) void rolesQuery.refetch();
          onOpenTeam?.();
        }}
        className="inline-flex h-8 max-w-48 min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-border py-0.5 pr-2 pl-2 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50 max-sm:pr-2"
      >
        <UsersRoundIcon className="size-3.5 shrink-0" aria-hidden="true" />
        {!isMobile && <span className="truncate">{failed ? "Retry" : label}</span>}
      </button>
    );
  }
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
  // Sessions wait unused while the preset keeps work in house, so the pill counts none.
  const count = locked ? 0 : team.members.length;
  const openTeam = () => {
    // The dialog reads the label: wait for a session change still saving.
    if (pending) return;
    setOpen(false);
    setQuery("");
    onOpenTeam?.();
  };
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
      compact={isMobile}
      onPick={() => choose(preset.id)}
    />
  );
  const heading = (text: string) => (
    <div className="px-2 pt-2 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
      {text}
    </div>
  );
  const pinned = shown.filter((p) => p.pinned);
  const label = `Roles preset: ${name}${count ? `, ${count} session${count === 1 ? "" : "s"}` : ""}`;
  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      data-testid="ae-preset-pill"
      aria-label={label}
      title={
        count
          ? `${label}: ${team.members.map((m) => m.displayName).join(", ")}`
          : `Roles preset: ${name}`
      }
      disabled={disabled}
      onClick={isMobile ? () => setOpen(true) : undefined}
      className="relative inline-flex h-8 max-w-48 min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-border py-0.5 pr-2 pl-0.5 text-xs hover:bg-accent disabled:opacity-50 max-sm:pr-0.5"
    >
      {choice.kind === "lead-picks" ? (
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-lg bg-teal-500/15 text-teal-400">
          <WandSparklesIcon className="size-3.5" />
        </span>
      ) : (
        <AeRolePresetTile icon={choice.preset.icon} color={choice.preset.color} size="sm" />
      )}
      {!isMobile && <span className="truncate">{name}</span>}
      {count > 0 && (
        <span
          data-testid="ae-preset-pill-count"
          aria-hidden="true"
          className={cn(
            "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-semibold text-white tabular-nums",
            isMobile && "absolute -top-1 -right-1 ring-2 ring-background",
          )}
        >
          {count}
        </span>
      )}
      {!isMobile && <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />}
    </button>
  );
  const body: ReactNode = (
    <>
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
      <div
        role="menu"
        aria-label="Roles presets"
        className={cn("overflow-y-auto", isMobile ? "max-h-[65dvh]" : "max-h-[60vh]")}
      >
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
        {onOpenTeam && words.length === 0 && (
          <AePresetSessionsSection
            sessionId={sessionId}
            members={team.members}
            open={open}
            locked={locked}
            lockedHint={aeSessionsLockedHint(choice)}
            compact={isMobile}
            working={working}
            pending={pending}
            onToggle={(member, on) => void setMember(member, on)}
            onNewSession={openTeam}
            reviewerNumbers={aeReviewerNumbers(choice)}
          />
        )}
      </div>
      {onOpenTeam && (
        <button
          type="button"
          onClick={openTeam}
          disabled={pending}
          className="flex items-center gap-2.5 rounded-md border-t disabled:opacity-50 border-border px-2 pt-2 pb-1 text-left hover:text-foreground"
        >
          <UsersRoundIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm">Who works on this?</span>
            {!isMobile && (
              <span className="block truncate text-xs text-muted-foreground">
                Customize roles, change lead, Own subagents only or Any agent or session
              </span>
            )}
          </span>
        </button>
      )}
      <ManagePresets onDone={() => setOpen(false)} />
    </>
  );
  if (isMobile) {
    return (
      <>
        {trigger}
        <Dialog open={open} onOpenChange={(next) => (!next || !disabled) && setOpen(next)}>
          <DialogContent
            showCloseButton={false}
            data-testid="ae-preset-menu"
            // Radix would focus the first field, the search box, and the phone
            // keyboard would cover the list. Focus the sheet itself instead
            // (it takes focus, tabIndex -1) so the focus trap and screen
            // readers still work; the keyboard waits for a tap on the box.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              if (event.currentTarget instanceof HTMLElement) {
                event.currentTarget.focus({ preventScroll: true });
              }
            }}
            className="top-auto bottom-0 left-0 flex max-w-full translate-x-0 translate-y-0 flex-col gap-1 rounded-t-2xl rounded-b-none p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:max-w-full"
            style={{ top: "auto", maxHeight: "85dvh" }}
          >
            <DialogTitle className="sr-only">Roles preset and sessions</DialogTitle>
            <div className="mx-auto mb-1 h-1 w-9 rounded-full bg-muted-foreground/40" />
            {body}
          </DialogContent>
        </Dialog>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={(next) => (!next || !disabled) && setOpen(next)}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-80 max-w-[calc(100vw-2rem)] gap-1 p-1.5"
        data-testid="ae-preset-menu"
      >
        {body}
      </PopoverContent>
    </Popover>
  );
}
