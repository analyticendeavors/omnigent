// Grouping > Family's tree rows in the sidebar (omnigent-ae, 2026-10-24): the
// indent and colored lines before a row's icon, the lead's fold pill, the
// stand-in row for a lead that is not listed, and the section titles. The tree
// itself: lib/aeFamilyTree.ts.

import { ArchiveIcon, ChevronDownIcon, ChevronRightIcon, GhostIcon, InfoIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  createContext,
  useContext,
} from "react";
import { AE_FAMILY_COLORS, aeFamilyHint } from "@/lib/aeFamily";
import { Link } from "@/lib/routing";
import {
  AE_FAMILIES_HINT,
  AE_FAMILIES_SECTION,
  AE_FAMILY_REST_SECTION,
  AE_FAMILY_TREE_STEP,
  type AeFamilyTree,
  type AeTreeLead,
  type AeTreeRow,
  toggleAeFamilyFold,
} from "@/lib/aeFamilyTree";
import { AeFamilyContext } from "@/lib/aeFamilyView";
import { cn } from "@/lib/utils";
import { AeFamilyDotButton } from "@/shell/AeFamilyDot";
import { SIDEBAR_ROW } from "@/shell/sidebarStyles";

// Half the 16px status icon past the row's left padding: the icon's center at depth 0.
const ICON_HALF = 8;
// The row's left padding, and its wider one while the checkboxes show.
const PAD_LEFT = 8;
const PAD_LEFT_SELECTING = 32;
// Literal class names, so Tailwind finds them; 10px is half the 20px first line.
const ELBOW_HEIGHT = "h-[calc(0.375rem+10px)] md:h-[calc(0.25rem+10px)]";
const STEM_TOP = "top-[calc(0.375rem+18px)] md:top-[calc(0.25rem+18px)]";
const LINE = "1.5px solid";
// The sidebar rows' hover, as Sidebar.tsx spells it.
const ROW_HOVER = "hover:bg-muted hover:text-foreground dark:hover:bg-muted/50";

function color(row: Pick<AeTreeRow, "family">): string {
  return AE_FAMILY_COLORS[row.family.color];
}

function Lines({
  row,
  selecting = false,
}: {
  row: Pick<AeTreeRow, "family" | "depth" | "through" | "more" | "stem">;
  selecting?: boolean;
}) {
  const c = color(row);
  const x = (step: number) =>
    (selecting ? PAD_LEFT_SELECTING : PAD_LEFT) + ICON_HALF + AE_FAMILY_TREE_STEP * (step - 1);
  const parts: ReactNode[] = [];
  const steps = row.through.flatMap((on, index) => (on ? [index + 1] : []));
  for (const step of steps) {
    parts.push(
      <span
        key={`t${step}`}
        className="absolute top-0 -bottom-px"
        style={{ left: x(step), borderLeft: `${LINE} ${c}` }}
      />,
    );
  }
  if (row.depth > 0) {
    const left = x(row.depth);
    const width = AE_FAMILY_TREE_STEP - 10;
    parts.push(
      row.more ? (
        <span
          key="v"
          className="absolute top-0 -bottom-px"
          style={{ left, borderLeft: `${LINE} ${c}` }}
        />
      ) : null,
      <span
        key="e"
        className={cn("absolute top-0", ELBOW_HEIGHT)}
        style={{
          left,
          width,
          borderLeft: row.more ? undefined : `${LINE} ${c}`,
          borderBottom: `${LINE} ${c}`,
          borderBottomLeftRadius: row.more ? undefined : 6,
        }}
      />,
    );
  }
  if (row.stem) {
    parts.push(
      <span
        key="s"
        className={cn("absolute -bottom-px", STEM_TOP)}
        style={{ left: x(row.depth + 1), borderLeft: `${LINE} ${c}` }}
      />,
    );
  }
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-60">
      {parts}
    </span>
  );
}

// Whether the rows below sit in the Families section: a pinned lead's copy in
// Pinned draws as a plain row.
const InFamilies = createContext(false);

/** A tree row's lines and indent, before its status icon; nothing outside the tree view. */
export function AeFamilyTreeIndent({
  conversationId,
  selectionMode = false,
}: {
  conversationId: string;
  selectionMode?: boolean;
}) {
  const { tree } = useContext(AeFamilyContext);
  const inFamilies = useContext(InFamilies);
  const row = inFamilies ? tree?.rows.get(conversationId) : undefined;
  if (!row) return null;
  return (
    <>
      <Lines row={row} selecting={selectionMode} />
      {row.depth > 0 && (
        <span
          aria-hidden="true"
          data-testid="ae-family-indent"
          data-depth={row.depth}
          className="shrink-0"
          style={{ width: AE_FAMILY_TREE_STEP * row.depth }}
        />
      )}
    </>
  );
}

function stop(event: MouseEvent | KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function FoldPill({ lead }: { lead: AeTreeLead }) {
  if (lead.count === 0) return null;
  const { root } = lead.family;
  const toggle = (event: MouseEvent | KeyboardEvent) => {
    stop(event);
    toggleAeFamilyFold(root, !lead.folded);
  };
  const label = `${lead.folded ? "Show" : "Hide"} ${lead.count} session${lead.count === 1 ? "" : "s"}`;
  return (
    <span
      role="button"
      tabIndex={0}
      title={label}
      aria-label={label}
      // Not aria-expanded: an expanded control inside a row reveals the row's hover controls.
      data-folded={lead.folded}
      data-testid="ae-family-fold"
      data-family={root}
      className={cn(
        // The tap target runs the row's full height on a phone.
        "relative ml-auto inline-flex h-[18px] shrink-0 items-center gap-0.5 rounded-full pr-1 pl-1.5 text-[11.5px] tabular-nums before:absolute before:-inset-x-2 before:-inset-y-3 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        lead.folded
          ? "bg-foreground/10 text-foreground"
          : "bg-foreground/[0.06] text-muted-foreground",
      )}
      onClick={toggle}
      onDoubleClick={stop}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") toggle(event);
      }}
    >
      {lead.folded && lead.needsResponse && (
        <span
          data-testid="ae-family-fold-waiting"
          className="mr-0.5 size-1.5 rounded-full bg-brand-accent"
        />
      )}
      {lead.folded && lead.running && (
        <span
          data-testid="ae-family-fold-running"
          className="mr-0.5 size-2.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none"
        />
      )}
      {lead.count}
      {lead.folded ? (
        <ChevronRightIcon className="size-3" />
      ) : (
        <ChevronDownIcon className="size-3" />
      )}
    </span>
  );
}

/** A listed lead's fold pill, after its title. */
export function AeFamilyFold({ conversationId }: { conversationId: string }) {
  const { tree } = useContext(AeFamilyContext);
  const inFamilies = useContext(InFamilies);
  const lead = inFamilies ? tree?.leads.get(conversationId) : undefined;
  if (!lead || lead.standIn) return null;
  return <FoldPill lead={lead} />;
}

function StandIn({
  lead,
  onNavigate,
}: {
  lead: AeTreeLead;
  onNavigate?: (e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const { family } = lead;
  const known = lead.standIn!.lead;
  const archived = known?.archived === true;
  return (
    <li className="group relative" data-testid="ae-family-stand-in" data-family={family.root}>
      <Link
        to={`/c/${family.root}`}
        componentId="sidebar.family_lead"
        title={known ? undefined : "Open the lead session"}
        onClick={onNavigate}
        className={cn(
          SIDEBAR_ROW,
          "relative flex w-full items-center pr-2 text-left text-muted-foreground transition-colors",
          ROW_HOVER,
        )}
      >
        {!lead.folded && lead.count > 0 && (
          <Lines row={{ family, depth: 0, through: [], more: false, stem: true }} />
        )}
        {archived ? (
          <ArchiveIcon className="ui-icon mr-1.5" aria-hidden="true" />
        ) : known ? null : (
          <GhostIcon className="ui-icon mr-1.5" aria-hidden="true" />
        )}
        <AeFamilyDotButton
          family={family}
          isLead
          dashed={!known}
          hint={aeFamilyHint({ family, isLead: true, forked: false, parentTitle: null })}
        />
        <span className={cn("min-w-0 truncate", !known && "italic")}>
          {known ? (known.title ?? known.id) : "Lead not loaded"}
        </span>
        {archived && (
          <span className="ml-1.5 shrink-0 rounded bg-foreground/[0.07] px-1.5 text-[11px]">
            Archived
          </span>
        )}
        <FoldPill lead={lead} />
      </Link>
    </li>
  );
}

/**
 * A row in a section's list: a stand-in lead draws as its own entry, any other
 * row as given. `section` is the section the row is in.
 */
export function AeFamilyTreeSlot({
  conversationId,
  section,
  onNavigate,
  children,
}: {
  conversationId: string;
  section: string | undefined;
  onNavigate?: (e: MouseEvent<HTMLAnchorElement>) => void;
  children: ReactNode;
}) {
  const { tree } = useContext(AeFamilyContext);
  if (!tree || section !== AE_FAMILIES_SECTION) return children;
  const standIn = tree.standIns.has(conversationId) ? tree.leads.get(conversationId) : undefined;
  return (
    <InFamilies.Provider value>
      {standIn ? <StandIn lead={standIn} onNavigate={onNavigate} /> : children}
    </InFamilies.Provider>
  );
}

/** The tree view's section titles with their counts; null for any other group. */
export function aeFamilySectionTitle(
  tree: AeFamilyTree | null | undefined,
  group: { title: string; conversations: readonly unknown[] },
): ReactNode {
  if (!tree) return null;
  const count =
    group.title === AE_FAMILIES_SECTION
      ? tree.familyCount
      : group.title === AE_FAMILY_REST_SECTION
        ? group.conversations.length
        : null;
  if (count === null) return null;
  return (
    <span
      data-testid="ae-family-section"
      data-section={group.title}
      className="inline-flex max-w-full items-center gap-1.5 align-middle"
    >
      <span className="truncate">{group.title}</span>
      <span className="shrink-0 tabular-nums opacity-70">{count}</span>
    </span>
  );
}

/** The empty "Families" section's one line. */
export function aeFamiliesHint(
  tree: AeFamilyTree | null | undefined,
  title: string,
): ReactNode | undefined {
  if (!tree || title !== AE_FAMILIES_SECTION) return undefined;
  return (
    <span data-testid="ae-families-hint" className="flex items-start gap-1.5 text-xs leading-snug">
      <InfoIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      {AE_FAMILIES_HINT}
    </span>
  );
}
