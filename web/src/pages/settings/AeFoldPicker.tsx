// A model picker with an "Older models" fold per platform (omnigent-ae,
// 2026-10-26), used on the Reviewer rows. The closed trigger looks like the
// native dropdown it replaced; the popover (a Radix dialog in a portal, so the
// settings page's scroll containers never clip it) holds a WAI-ARIA tree:
// platform groups labelled by their visible heading, models as treeitems, and
// one "Older models" treeitem per platform that expands a nested group.
// Focus is roving: one item is tabbable and the arrows move real focus.
// Keys: Up/Down, Home/End, Right opens a fold (or enters it), Left closes it
// (or goes from an older model to its fold row), Enter/Space pick or toggle,
// a letter jumps, Escape closes, Tab closes and returns to the trigger.
// A fold has no stored state: it is open when the row's current model is in it,
// unless the person toggled it while the popover is open.

import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { aeFoldRowLabel } from "@/lib/aeModelFold";
import { cn } from "@/lib/utils";

export interface AeFoldOption {
  value: string;
  label: string;
  /** Keys the row when two rows share a value (a Codex row's own id). */
  id?: string;
  /** Small text on the right of the row, e.g. "used by Reviewer 1" or "needs setup". */
  note?: string;
  disabled?: boolean;
}

export interface AeFoldGroup {
  id: string;
  label: string;
  /** Always listed. */
  options: readonly AeFoldOption[];
  /** Behind the "Older models" row; the row is left out when empty. */
  older: readonly AeFoldOption[];
}

interface Entry {
  key: string;
  option: AeFoldOption;
  level: 1 | 2;
  group?: AeFoldGroup;
}
interface FoldEntry {
  key: string;
  group: AeFoldGroup;
  open: boolean;
}
type Focusable = ({ kind: "option" } & Entry) | ({ kind: "fold" } & FoldEntry);

const ROW =
  "flex w-full min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none md:min-h-8 md:py-1 hover:ring-1 hover:ring-inset hover:ring-foreground/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const QUIET = "text-foreground";

const inFold = (group: AeFoldGroup, value: string) => group.older.some((o) => o.value === value);

export function AeFoldPicker({
  value,
  ariaLabel,
  nameSuffix = "",
  groups,
  auto,
  disabled,
  triggerClassName,
  nameClassName,
  headingHint,
  onPick,
}: {
  value: string;
  /** The control's name without the model, e.g. "Reviewer 2 model". */
  ariaLabel: string;
  /** Said after the current model in the trigger's name, e.g. ", runs through Codex". */
  nameSuffix?: string;
  groups: readonly AeFoldGroup[];
  /** An option above the groups (the first reviewer's "Auto"). */
  auto?: AeFoldOption;
  disabled?: boolean;
  /** Padding for the dot and tag the row draws over the trigger. */
  triggerClassName?: string;
  /** Room on the right of the name for the tag the row draws over the trigger. */
  nameClassName?: string;
  /** An info icon in the popover header, outside the tree (reached by Shift+Tab or pointer). */
  headingHint?: ReactNode;
  onPick: (value: string) => void;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  // Folds the person toggled in this open popover; unset folds follow the current model.
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const typed = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  const seen = new Set<string>();
  const keyOf = (scope: string, option: AeFoldOption) => {
    let key = `${scope}/${option.id ?? option.value}`;
    for (let n = 2; seen.has(key); n++) key = `${scope}/${option.id ?? option.value}#${n}`;
    seen.add(key);
    return key;
  };
  const autoEntry: Entry | null = auto
    ? { key: keyOf("auto", auto), option: auto, level: 1 }
    : null;
  const sections = groups
    .filter((g) => g.options.length > 0 || g.older.length > 0)
    .map((group) => {
      const isOpen = folds[group.id] ?? inFold(group, value);
      return {
        group,
        open: isOpen,
        head: `${uid}-h-${group.id}`,
        older: `${uid}-o-${group.id}`,
        latest: group.options.map((option): Entry => ({
          key: keyOf(group.id, option),
          option,
          level: 1,
          group,
        })),
        fold: { key: `fold/${group.id}`, group, open: isOpen } as FoldEntry,
        nested: group.older.map((option): Entry => ({
          key: keyOf(`${group.id}-older`, option),
          option,
          level: 2,
          group,
        })),
      };
    });

  const focusable: Focusable[] = [];
  if (autoEntry) focusable.push({ kind: "option", ...autoEntry });
  for (const s of sections) {
    for (const e of s.latest) focusable.push({ kind: "option", ...e });
    if (s.group.older.length > 0) {
      focusable.push({ kind: "fold", ...s.fold });
      if (s.open) for (const e of s.nested) focusable.push({ kind: "option", ...e });
    }
  }
  // Only the first row holding the value is the selected one.
  const selectedKey = focusable.find((f) => f.kind === "option" && f.option.value === value)?.key;
  const current = [
    ...(auto ? [auto] : []),
    ...groups.flatMap((g) => [...g.options, ...g.older]),
  ].find((o) => o.value === value);
  const currentLabel = current?.label ?? "Unavailable model";
  const tabbableKey =
    (activeKey && focusable.some((f) => f.key === activeKey) ? activeKey : null) ??
    selectedKey ??
    focusable[0]?.key;

  // One flag for the header hint and for the Tab logic that depends on it.
  const hintShown = !!headingHint && sections.some((s) => s.group.older.length > 0);

  const focusKey = (key: string) => {
    setActiveKey(key);
    const el = treeRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    el?.focus();
    el?.scrollIntoView?.({ block: "nearest" });
  };

  const onOpenChange = (next: boolean) => {
    if (!next) {
      setFolds({});
      setActiveKey(null);
    }
    setOpen(next);
  };

  const pick = (option: AeFoldOption) => {
    if (option.disabled) return;
    onOpenChange(false);
    if (option.value !== value) onPick(option.value);
  };
  const toggle = (fold: FoldEntry, to = !fold.open) => {
    setFolds((f) => ({ ...f, [fold.group.id]: to }));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-key]");
    const at = focusable.findIndex((f) => f.key === target?.dataset.key);
    const item = at >= 0 ? focusable[at] : null;
    const move = (to: number) => {
      event.preventDefault();
      const next = focusable[Math.max(0, Math.min(focusable.length - 1, to))];
      if (next) focusKey(next.key);
    };
    switch (event.key) {
      case "ArrowDown":
        return move(at + 1);
      case "ArrowUp":
        return move(at - 1);
      case "Home":
        return move(0);
      case "End":
        return move(focusable.length - 1);
      case "ArrowRight":
        if (item?.kind === "fold") {
          event.preventDefault();
          if (!item.open) toggle(item, true);
          else move(at + 1);
        }
        return;
      case "ArrowLeft":
        event.preventDefault();
        if (item?.kind === "fold" && item.open) toggle(item, false);
        else if (item?.kind === "option" && item.level === 2 && item.group)
          focusKey(`fold/${item.group.id}`);
        return;
      case "Tab":
        // Tab leaves the list for the trigger; Shift+Tab goes back to the header's hint when there is one.
        if (!event.shiftKey || !hintShown) {
          event.preventDefault();
          onOpenChange(false);
          triggerRef.current?.focus();
        }
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        if (item?.kind === "fold") toggle(item);
        else if (item) pick(item.option);
        return;
      default:
    }
    if (event.key.length === 1 && /\S/.test(event.key) && !event.ctrlKey && !event.metaKey) {
      // Type-ahead over the visible, enabled rows only (a closed fold's models are not in the list).
      const now = Date.now();
      typed.current.text =
        (now - typed.current.at > 700 ? "" : typed.current.text) + event.key.toLowerCase();
      typed.current.at = now;
      const from = typed.current.text.length > 1 ? Math.max(at, 0) : at + 1;
      const order = [...focusable.slice(from), ...focusable.slice(0, from)];
      const hit = order.find(
        (f) =>
          f.kind === "option" &&
          !f.option.disabled &&
          f.option.label.toLowerCase().startsWith(typed.current.text),
      );
      if (hit) {
        event.preventDefault();
        focusKey(hit.key);
      }
    }
  };

  const contentId = `${uid}-popover`;
  const optionRow = (e: Entry) => {
    const { option } = e;
    const selected = e.key === selectedKey;
    return (
      <div
        key={e.key}
        role="treeitem"
        tabIndex={e.key === tabbableKey ? 0 : -1}
        data-key={e.key}
        aria-level={e.level}
        aria-selected={selected}
        aria-disabled={option.disabled || undefined}
        onClick={() => pick(option)}
        onFocus={() => setActiveKey(e.key)}
        className={cn(
          ROW,
          e.key.startsWith("auto/") ? "pl-2" : e.level === 2 ? "pl-8" : "pl-5",
          selected && "font-semibold shadow-[inset_3px_0_0_0_currentColor]",
          option.disabled && cn("cursor-not-allowed hover:bg-transparent", QUIET),
        )}
      >
        <span className="min-w-0 flex-1 truncate">{option.label}</span>
        {option.note && <span className={cn("shrink-0 text-xs", QUIET)}>{option.note}</span>}
      </div>
    );
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={`${ariaLabel}, ${currentLabel}${nameSuffix}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? contentId : undefined}
          title={current ? undefined : value}
          disabled={disabled}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              onOpenChange(true);
            }
          }}
          className={cn(
            "flex w-full min-w-0 items-center gap-1.5 rounded-md border border-input bg-background py-1.5 text-left text-sm leading-[normal] text-foreground min-h-[33px] md:min-h-8 disabled:opacity-50",
            triggerClassName,
          )}
        >
          <span className={cn("min-w-0 flex-1 truncate", nameClassName)}>{currentLabel}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        id={contentId}
        aria-label={`${ariaLabel} choices`}
        aria-modal="false"
        align="start"
        collisionPadding={8}
        onOpenAutoFocus={(event) => {
          // Focus the current model (or the first row) instead of the container.
          event.preventDefault();
          if (tabbableKey) focusKey(tabbableKey);
        }}
        className="max-h-[min(26rem,var(--radix-popover-content-available-height))] w-[max(var(--radix-popover-trigger-width),16rem)] max-w-[calc(100vw-1rem)] gap-0 overflow-y-auto overscroll-contain bg-background p-1"
      >
        {hintShown && (
          <div
            className="flex items-center justify-end px-2 pb-0.5"
            data-testid="ae-fold-hint"
            onKeyDown={(event) => {
              // The popover is portaled, so the page's own tab order does not lead back here.
              if (event.key !== "Tab") return;
              event.preventDefault();
              if (event.shiftKey) {
                onOpenChange(false);
                triggerRef.current?.focus();
              } else if (tabbableKey) {
                // After the popover's own focus loop has seen this key press, or it moves focus back.
                const key = tabbableKey;
                setTimeout(() => focusKey(key), 0);
              }
            }}
          >
            {headingHint}
          </div>
        )}
        <div
          ref={treeRef}
          role="tree"
          aria-label={`${ariaLabel} list`}
          data-testid="ae-fold-list"
          onKeyDown={onKeyDown}
        >
          {autoEntry && optionRow(autoEntry)}
          {sections.map((s) => (
            <div key={s.group.id}>
              <div id={s.head} className="px-2 pt-2 pb-1 text-xs font-semibold text-foreground">
                {s.group.label}
              </div>
              <div role="group" aria-labelledby={s.head}>
                {s.latest.map(optionRow)}
                {s.group.older.length > 0 && (
                  <>
                    <div
                      role="treeitem"
                      tabIndex={s.fold.key === tabbableKey ? 0 : -1}
                      data-key={s.fold.key}
                      data-testid={`ae-fold-${s.group.id}`}
                      aria-level={1}
                      aria-expanded={s.open}
                      aria-controls={s.older}
                      aria-label={aeFoldRowLabel(s.group.older.length, s.open)}
                      onClick={() => toggle(s.fold)}
                      onFocus={() => setActiveKey(s.fold.key)}
                      className={cn(ROW, "pl-3 text-xs", QUIET)}
                    >
                      <ChevronRightIcon
                        className={cn(
                          "size-3 shrink-0 transition-transform",
                          s.open && "rotate-90",
                        )}
                        aria-hidden="true"
                      />
                      <span className="font-semibold">Older models</span>
                      <span aria-hidden="true">{s.group.older.length}</span>
                    </div>
                    <div role="group" id={s.older} aria-label="Older models" hidden={!s.open}>
                      {s.open && s.nested.map(optionRow)}
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
