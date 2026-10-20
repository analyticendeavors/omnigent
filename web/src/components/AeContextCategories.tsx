// Claude Code's context snapshot drawn by category: the bar and short legend
// the usage popover shows, and the full rows and lists the session rail shows.

import { useState } from "react";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";
import { cn } from "@/lib/utils";
import { categoryColor, type ContextCategory, type ContextUsage } from "./aeContextUsage";

/** Tabler's `chevron-right`. */
const CHEVRON_RIGHT: AeTablerIconNode = [["path", { d: "M9 6l6 6l-6 6" }]];

/** "950", "25.9k", "1M", as the usage popover prints tokens. */
export function formatCategoryTokens(n: number): string {
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

export function categorySwatch(category: ContextCategory): string {
  if (category.kind === "free") return "bg-muted";
  if (category.kind === "buffer") return "bg-muted-foreground/20";
  if (category.kind === "deferred") return "bg-muted-foreground/40";
  return categoryColor(category.name);
}

/** Share of the whole window, 0 to 100. */
export function windowPercent(tokens: number, data: ContextUsage): number {
  return data.maxTokens > 0 ? (tokens / data.maxTokens) * 100 : 0;
}

/** Used categories, largest first; Claude's own order breaks ties. */
export function usedCategories(data: ContextUsage): ContextCategory[] {
  return data.categories
    .map((category, index) => ({ category, index }))
    .filter(({ category }) => category.kind === "used")
    .sort((a, b) => b.category.tokens - a.category.tokens || a.index - b.index)
    .map(({ category }) => category);
}

/** The used categories by size, with the autocompact buffer at the right end. */
export function AeCategoryBar({ data, className }: { data: ContextUsage; className?: string }) {
  const buffer = data.categories.filter((c) => c.kind === "buffer");
  return (
    <div
      className={cn("flex h-2 w-full overflow-hidden rounded-full bg-muted", className)}
      role="img"
      aria-label="Estimated context by category"
      data-testid="ae-category-bar"
    >
      {[...usedCategories(data), ...buffer].map((c) => (
        <span
          key={c.name}
          title={`${c.name}: ${formatCategoryTokens(c.tokens)}`}
          data-category={c.name}
          className={cn("h-full", c.kind === "buffer" && "ml-auto", categorySwatch(c))}
          style={{ width: `${Math.min(100, windowPercent(c.tokens, data))}%` }}
        />
      ))}
    </div>
  );
}

const OTHER_SWATCH = "bg-chart-5";

/** The three largest used categories, then the rest as Other, each as a share of the window. */
export function categoryLegend(
  data: ContextUsage,
  top = 3,
): { name: string; pct: number; swatch: string }[] {
  const used = usedCategories(data);
  const rows = used.slice(0, top).map((c) => ({
    name: c.name,
    pct: windowPercent(c.tokens, data),
    swatch: categorySwatch(c),
  }));
  const rest = used.slice(top).reduce((sum, c) => sum + c.tokens, 0);
  if (rest > 0) rows.push({ name: "Other", pct: windowPercent(rest, data), swatch: OTHER_SWATCH });
  return rows;
}

export function AeCategoryLegend({ data }: { data: ContextUsage }) {
  return (
    <ul
      aria-label="Context window color legend"
      data-testid="ae-category-legend"
      className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
    >
      {categoryLegend(data).map((row) => (
        <li key={row.name} className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              "size-2.5 shrink-0 rounded-sm ring-1 ring-inset ring-foreground/10",
              row.swatch,
            )}
          />
          <span className="break-words">{row.name}</span>
          <span className="font-semibold text-foreground tabular-nums">{Math.round(row.pct)}%</span>
        </li>
      ))}
    </ul>
  );
}

/** Lists the snapshot can open, in the rail's order. */
export const CATEGORY_LISTS = ["MCP tools", "Memory files", "Skills", "Custom agents"] as const;

function CategoryRow({
  category,
  data,
  onOpenList,
}: {
  category: ContextCategory;
  data: ContextUsage;
  onOpenList?: () => void;
}) {
  const deferred = category.kind === "deferred";
  return (
    <li
      className={cn("flex min-h-6 items-center gap-2 text-sm", deferred && "text-muted-foreground")}
      data-testid="ae-category-row"
      data-kind={category.kind}
    >
      <span
        aria-hidden="true"
        className={cn("size-2.5 shrink-0 rounded-sm", categorySwatch(category))}
      />
      <span className="min-w-0 flex-1 truncate">
        {onOpenList ? (
          <button
            type="button"
            onClick={onOpenList}
            className="cursor-pointer rounded-sm underline decoration-dotted underline-offset-3 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {category.name}
          </button>
        ) : (
          category.name
        )}
      </span>
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {formatCategoryTokens(category.tokens)}
      </span>
      <span
        className={cn(
          "w-12 shrink-0 text-right tabular-nums",
          deferred ? "font-normal" : "font-semibold",
        )}
      >
        {deferred ? "-" : `${windowPercent(category.tokens, data).toFixed(1)}%`}
      </span>
    </li>
  );
}

/** Name of the fold over the window's rows; starts folded. */
export const CATEGORIES_FOLD = "Categories";

/** A folding header: chevron, name, and a count at the right end. */
function FoldToggle({
  name,
  count,
  expanded,
  controls,
  onToggle,
}: {
  name: string;
  count: number;
  expanded: boolean;
  controls: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
      className="flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-sm text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-10"
    >
      <AeTablerSvg
        node={CHEVRON_RIGHT}
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          expanded && "rotate-90",
        )}
      />
      {name}
      <span className="ml-auto text-muted-foreground tabular-nums">{count}</span>
    </button>
  );
}

/**
 * Every category as a row under a folded Categories section (used ones
 * largest first, then the autocompact buffer and free space, then deferred
 * tools, muted since they are not in the window), then the folding lists of
 * tools, memory files, skills and agents.
 */
export function AeContextCategoryRows({ data }: { data: ContextUsage }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const lists = CATEGORY_LISTS.filter((name) => (data.details[name]?.length ?? 0) > 0);
  const toggle = (name: string, next?: boolean) =>
    setOpen((current) => {
      const copy = new Set(current);
      if (next ?? !copy.has(name)) copy.add(name);
      else copy.delete(name);
      return copy;
    });
  const byKind = (kind: ContextCategory["kind"]) => data.categories.filter((c) => c.kind === kind);
  const deferred = byKind("deferred");
  const windowRows = [...usedCategories(data), ...byKind("buffer"), ...byKind("free")];
  const categoriesOpen = open.has(CATEGORIES_FOLD);
  const rowFor = (c: ContextCategory) => (
    <CategoryRow
      key={`${c.kind}:${c.name}`}
      category={c}
      data={data}
      onOpenList={
        (lists as readonly string[]).includes(c.name) ? () => toggle(c.name, true) : undefined
      }
    />
  );
  return (
    <div className="flex flex-col" data-testid="ae-context-categories">
      {/* Spaced from the lists only while open; folded, it sits in their column. */}
      <div className={cn(categoriesOpen && lists.length > 0 && "mb-2")}>
        <FoldToggle
          name={CATEGORIES_FOLD}
          count={windowRows.length + deferred.length}
          expanded={categoriesOpen}
          controls="ae-context-categories-rows"
          onToggle={() => toggle(CATEGORIES_FOLD)}
        />
        {categoriesOpen && (
          <div id="ae-context-categories-rows" className="ml-5 flex flex-col gap-2">
            <ul aria-label="Context categories">{windowRows.map(rowFor)}</ul>
            {deferred.length > 0 && (
              <ul aria-label="Deferred tools" title="Loaded on demand; not in the context window">
                {deferred.map(rowFor)}
              </ul>
            )}
          </div>
        )}
      </div>
      {lists.length > 0 && (
        <div className="flex flex-col">
          {lists.map((name) => {
            const rows = data.details[name] ?? [];
            const expanded = open.has(name);
            const listId = `ae-context-list-${name.replace(/\W+/g, "-").toLowerCase()}`;
            return (
              <div key={name}>
                <FoldToggle
                  name={name}
                  count={rows.length}
                  expanded={expanded}
                  controls={listId}
                  onToggle={() => toggle(name)}
                />
                {expanded && (
                  <ul
                    id={listId}
                    aria-label={name}
                    className="mb-1.5 ml-5 max-h-32 overflow-y-auto text-xs"
                  >
                    {rows.map((row) => (
                      <li
                        key={row.name}
                        className="flex items-baseline justify-between gap-3 py-px text-muted-foreground"
                      >
                        <span className="min-w-0 break-all">{row.name}</span>
                        <span className="shrink-0 tabular-nums">
                          {formatCategoryTokens(row.tokens)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
