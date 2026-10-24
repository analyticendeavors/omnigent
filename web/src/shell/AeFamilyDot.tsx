// Session family marks in the sidebar (omnigent-ae, 2026-10-23): one colored
// dot on every row of a family and a filter the dot turns on. In Grouping >
// Family's tree only the lead keeps its dot; lines mark the rest. The families
// come from `aeFamilies` (lib/aeFamily.ts), the context from lib/aeFamilyView.ts.

import { XIcon } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useContext } from "react";
import { AE_FAMILY_COLORS, type AeFamily, aeFamilyHint } from "@/lib/aeFamily";
import { AeFamilyContext } from "@/lib/aeFamilyView";
import { cn } from "@/lib/utils";

function familyName(family: AeFamily): string {
  return family.leadTitle ?? "Unlisted session";
}

/** A family's dot, a plain span; `AeFamilyDot` makes it the filter button on a row. */
export function AeFamilySwatch({ family, className }: { family: AeFamily; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: AE_FAMILY_COLORS[family.color] }}
    />
  );
}

/** The dot as the filter button, for a row or a stand-in lead; a lead's dot carries a ring. */
export function AeFamilyDotButton({
  family,
  isLead,
  hint,
  dashed,
}: {
  family: AeFamily;
  isLead: boolean;
  hint: string;
  /** An outline dot, for a lead that is not loaded. */
  dashed?: boolean;
}) {
  const { filter, onFilter } = useContext(AeFamilyContext);
  const { root } = family;
  const color = AE_FAMILY_COLORS[family.color];
  const toggle = (event: MouseEvent | KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onFilter(filter === root ? null : root);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      title={`${hint}. Show only this family`}
      aria-label={`${hint}. Show only this family`}
      aria-pressed={filter === root}
      data-testid="ae-family-dot"
      data-family={root}
      className="mr-1.5 inline-flex size-3 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={toggle}
      // Keep a double-click on the dot from reaching the row, where it renames.
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") toggle(event);
      }}
    >
      <span
        className={cn(
          "size-2 rounded-full",
          isLead && !dashed && "ring-1 ring-current ring-offset-1 ring-offset-background",
          dashed && "border-[1.5px] border-dashed",
        )}
        style={dashed ? { borderColor: color } : { backgroundColor: color, color }}
      />
    </span>
  );
}

/**
 * The row's dot, before the title. A click narrows the list to the family (a
 * second click widens it again) without opening the session.
 */
export function AeFamilyDot({ conversationId }: { conversationId: string }) {
  const { families, dots, tree } = useContext(AeFamilyContext);
  const role = families.byRow.get(conversationId);
  const treeDepth = tree?.rows.get(conversationId)?.depth;
  if (!role || (treeDepth === undefined ? !dots : treeDepth > 0)) return null;
  return <AeFamilyDotButton family={role.family} isLead={role.isLead} hint={aeFamilyHint(role)} />;
}

/** Shown above the list while it is narrowed to one family. */
export function AeFamilyFilterBar() {
  const { families, filter, onFilter } = useContext(AeFamilyContext);
  const family = filter ? families.byRoot.get(filter) : undefined;
  if (!filter) return null;
  return (
    <div
      data-testid="ae-family-filter"
      className="mx-2 mb-2 flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs"
    >
      {family && <AeFamilySwatch family={family} />}
      <span className="min-w-0 truncate">{family ? familyName(family) : "Family"}</span>
      <span className="shrink-0 tabular-nums opacity-70">{family?.members.length ?? 0}</span>
      <button
        type="button"
        aria-label="Show every session"
        data-testid="ae-family-filter-clear"
        className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        onClick={() => onFilter(null)}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
