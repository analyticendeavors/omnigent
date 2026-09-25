// The project icon picker over Tabler icons (omnigent-ae, 2026-09-24), in place
// of the emoji-mart picker: a search box and an 8-column grid of every outline
// icon, searched by name and by the package's tags. `onSelect` gets the stored
// value, `tabler:<name>`. It fills the height the callers' popovers publish in
// `--emoji-picker-height`, so it fits a phone screen and scrolls inside.
// Arrow keys move through the grid, Enter or Space picks, Up from the top row
// returns to the search box, and Down or Enter in the box reaches the results.

import { type KeyboardEvent, type UIEvent, useEffect, useMemo, useRef, useState } from "react";
import { Loader2Icon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AeTablerSvg, aeTablerValue, useAeTablerIcons } from "@/lib/aeTablerIcon";
import { type AeTablerIconTags, loadAeTablerIconTags } from "@/lib/aeTablerIconData";
import { cn } from "@/lib/utils";

const COLUMNS = 8;
/** Cells rendered per step; more are added as the grid scrolls near its end. */
const PAGE = 320;

/** Shown first when the search box is empty: icons that suit a project. */
// prettier-ignore
export const AE_TABLER_SUGGESTED = [
  "folder", "briefcase", "rocket", "code", "terminal-2", "database", "server", "cloud",
  "chart-bar", "home", "book", "notes", "bulb", "brand-github", "world", "heart",
  "star", "flame", "bolt", "settings", "tools", "brush", "palette", "camera",
  "music", "device-laptop", "device-mobile", "users", "user", "school", "building", "shopping-cart",
  "coin", "currency-dollar", "calendar", "clock", "mail", "message", "clipboard-list", "checklist",
  "target", "flag", "map-pin", "plane", "car", "leaf", "tree", "bug",
  "robot", "brain", "flask", "puzzle", "package", "lock", "key", "shield",
  "trophy", "gift", "coffee", "pizza",
];

/**
 * Icon names matching every word of `query` in the name, the category or a
 * tag. Exact and prefix name matches first, then other name matches, then
 * tag-only matches; an empty query keeps the given order.
 */
export function searchAeTablerIcons(
  names: readonly string[],
  tags: AeTablerIconTags | null,
  query: string,
): string[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...names];
  const joined = words.join("-");
  const ranked: [rank: number, name: string][] = [];
  for (const name of names) {
    const meta = tags?.[name];
    const tagText = meta ? [meta.category ?? "", ...(meta.tags ?? [])].join(" ").toLowerCase() : "";
    if (!words.every((w) => name.includes(w) || tagText.includes(w))) continue;
    const rank =
      name === joined
        ? 0
        : name.startsWith(words[0])
          ? 1
          : words.every((w) => name.includes(w))
            ? 2
            : 3;
    ranked.push([rank, name]);
  }
  ranked.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return ranked.map(([, name]) => name);
}

/** A themed Tabler icon picker. Calls `onSelect` with `tabler:<name>`. */
export function AeTablerIconPicker({ onSelect }: { onSelect: (value: string) => void }) {
  // Remounting the body retries a failed load; the loader forgets a failure.
  const [attempt, setAttempt] = useState(0);
  return (
    <div
      data-testid="ae-tabler-picker"
      className="flex w-[min(352px,calc(100vw-16px))] flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground"
      style={{ height: "var(--emoji-picker-height, 420px)" }}
    >
      <PickerBody key={attempt} onSelect={onSelect} onRetry={() => setAttempt((n) => n + 1)} />
    </div>
  );
}

function PickerBody({
  onSelect,
  onRetry,
}: {
  onSelect: (value: string) => void;
  onRetry: () => void;
}) {
  const set = useAeTablerIcons();
  const [tags, setTags] = useState<AeTablerIconTags | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [active, setActive] = useState(0);
  const [label, setLabel] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);

  useEffect(() => {
    let live = true;
    // Tags only widen the search; names still match while they load or if they fail.
    loadAeTablerIconTags().then(
      (loaded) => live && setTags(loaded),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  const names = useMemo(() => {
    if (!set || set === "error") return [];
    const suggested = AE_TABLER_SUGGESTED.filter((name) => name in set);
    const first = new Set(suggested);
    return [...suggested, ...Object.keys(set).filter((name) => !first.has(name))];
  }, [set]);
  const results = useMemo(() => searchAeTablerIcons(names, tags, query), [names, tags, query]);
  const shown = results.slice(0, limit);

  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-index="${active}"]`)?.focus();
  }, [active, limit]);

  const focusCell = (index: number) => {
    const next = Math.max(0, Math.min(index, results.length - 1));
    setActive(next);
    const cell = gridRef.current?.querySelector<HTMLButtonElement>(`[data-index="${next}"]`);
    if (cell) {
      cell.focus();
      return;
    }
    // Past the rendered cells: render the next step, then focus once it exists.
    focusPending.current = true;
    setLimit((n) => n + PAGE);
  };

  const pick = (name: string) => onSelect(aeTablerValue(name));

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && results.length > 0) {
      e.preventDefault();
      focusCell(0);
    } else if (e.key === "Enter" && results.length > 0) {
      e.preventDefault();
      pick(results[0]);
    }
  };

  const onCellKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const moves: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      ArrowDown: index + COLUMNS,
      ArrowUp: index - COLUMNS,
      Home: index - (index % COLUMNS),
      End: index - (index % COLUMNS) + COLUMNS - 1,
    };
    if (!(e.key in moves)) return;
    e.preventDefault();
    if (e.key === "ArrowUp" && index < COLUMNS) {
      inputRef.current?.focus();
      return;
    }
    focusCell(moves[e.key]);
  };

  const onGridScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (limit < results.length && el.scrollTop + el.clientHeight > el.scrollHeight - 200) {
      setLimit((n) => n + PAGE);
    }
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          type="search"
          aria-label="Search icons"
          data-testid="ae-tabler-search"
          placeholder="Search icons"
          autoComplete="off"
          className="w-full min-w-0 bg-transparent text-ui outline-none placeholder:text-muted-foreground"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(PAGE);
            setActive(0);
            gridRef.current?.scrollTo?.({ top: 0 });
          }}
          onKeyDown={onSearchKey}
        />
      </div>
      {set === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-ui text-muted-foreground">
          <p role="alert">Couldn&apos;t load the icon set. Check the connection and try again.</p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : set === null ? (
        <div
          className="flex flex-1 items-center justify-center gap-2 text-ui text-muted-foreground"
          data-testid="ae-tabler-loading"
        >
          <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
          Loading icons
        </div>
      ) : (
        <div
          ref={gridRef}
          role="group"
          aria-label="Tabler icons"
          className="grid min-h-0 flex-1 auto-rows-min grid-cols-8 gap-0.5 overflow-y-auto overscroll-contain p-2"
          onScroll={onGridScroll}
        >
          {shown.length === 0 ? (
            <p className="col-span-8 py-6 text-center text-ui text-muted-foreground">
              No icons match &ldquo;{query.trim()}&rdquo;
            </p>
          ) : (
            shown.map((name, index) => (
              <button
                key={name}
                type="button"
                data-index={index}
                data-testid={`ae-tabler-icon-${name}`}
                tabIndex={index === active ? 0 : -1}
                aria-label={name}
                title={name}
                className={cn(
                  "flex aspect-square items-center justify-center rounded-md text-foreground outline-none transition-colors",
                  "hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50",
                )}
                onClick={() => pick(name)}
                onKeyDown={(e) => onCellKey(e, index)}
                onFocus={() => {
                  setActive(index);
                  setLabel(name);
                }}
                onMouseEnter={() => setLabel(name)}
                onMouseLeave={() => setLabel(null)}
                onBlur={() => setLabel(null)}
              >
                <AeTablerSvg node={set[name]} className="size-5" />
              </button>
            ))
          )}
        </div>
      )}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
        <span className="truncate">
          {label ?? (set && set !== "error" ? `${results.length} icons` : "")}
        </span>
        <span className="shrink-0">Tabler Icons</span>
      </div>
    </>
  );
}
