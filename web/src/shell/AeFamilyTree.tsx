// Grouping > Family's tree rows in the sidebar (omnigent-ae, 2026-10-24): the
// indent and colored lines before a row's icon, the lead's fold chevron, the
// stand-in row for a lead that is not listed, and the section titles. The tree
// itself: lib/aeFamilyTree.ts. Since 2026-10-25 a lead row shows only its name
// and the chevron, so a narrow panel keeps the name readable; the family's cost
// and open count are on the hover card's lead line (AeSessionHoverStatus.tsx).

import { ArchiveIcon, ChevronDownIcon, ChevronRightIcon, GhostIcon, InfoIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  createContext,
  useContext,
} from "react";
import { aeAgentRole, aeRoleName } from "@/lib/aeAgentRole";
import { useAeSessionUsages } from "@/lib/aeAgentUsage";
import { aeRaiseMarks } from "@/lib/aeModelChange";
import { AE_FAMILY_COLORS, aeFamilyHint } from "@/lib/aeFamily";
import {
  AE_CLOSED_CAPPED_NOTE,
  aeClosedTitle,
  revealAeFamilyClosed,
  toggleAeFamilyClosed,
} from "@/lib/aeFamilyClosed";
import { Link, useParams } from "@/lib/routing";
import { AeConversationStatusIcon } from "@/components/AeStatusIcon";
import {
  AE_FAMILIES_HINT,
  AE_FAMILIES_SECTION,
  AE_FAMILY_REST_SECTION,
  AE_FAMILY_TREE_STEP,
  type AeClosedEntry,
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

/** A family row's marker is a dot or spinner (16px at most), so its title keeps pr-7, not the pr-8 slot. */
export function useAeFamilyMarkerReserve(conversationId: string): string | null {
  const { tree } = useContext(AeFamilyContext);
  const inFamilies = useContext(InFamilies);
  const inTree = inFamilies && (tree?.leads.has(conversationId) || tree?.rows.has(conversationId));
  return inTree ? "pr-7" : null;
}

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

function FoldChevron({ lead }: { lead: AeTreeLead }) {
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
      title={
        (lead.closed ? aeClosedTitle(lead.closed) : label) +
        (lead.archivedCapped ? AE_CLOSED_CAPPED_NOTE : "")
      }
      aria-label={label}
      // Not aria-expanded: an expanded control inside a row reveals the row's hover controls.
      data-folded={lead.folded}
      data-testid="ae-family-fold"
      data-family={root}
      className={cn(
        // The tap target runs the row's full height on a phone.
        "relative ml-auto inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center gap-0.5 rounded-full px-0.5 before:absolute before:-inset-x-2 before:-inset-y-3 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
      {lead.folded ? (
        <ChevronRightIcon className="size-3" />
      ) : (
        <ChevronDownIcon className="size-3" />
      )}
    </span>
  );
}

const USAGE_MS = 60_000;

/** A listed lead's fold chevron, or a child's role chip, after its title. */
export function AeFamilyFold({ conversationId }: { conversationId: string }) {
  const { tree } = useContext(AeFamilyContext);
  const inFamilies = useContext(InFamilies);
  const lead = inFamilies ? tree?.leads.get(conversationId) : undefined;
  if (!lead) {
    const row = inFamilies ? tree?.rows.get(conversationId) : undefined;
    const labels = row?.family.members.find((m) => m.id === conversationId)?.labels;
    const role = row && row.depth > 0 ? aeAgentRole({ labels }) : null;
    return role ? (
      <span
        data-testid="ae-family-role"
        className="ml-auto shrink-0 rounded bg-foreground/[0.07] px-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
      >
        {aeRoleName(role)}
      </span>
    ) : null;
  }
  if (lead.standIn) return null;
  return <FoldChevron lead={lead} />;
}

/**
 * A raised helper's second line: where it runs now and where it started, with a cap chip.
 * It reads usage only for a member with `ae.model_start`, under the hover card's query key.
 */
export function AeFamilyRaiseLine({ conversationId }: { conversationId: string }) {
  const { tree } = useContext(AeFamilyContext);
  const inFamilies = useContext(InFamilies);
  const row = inFamilies ? tree?.rows.get(conversationId) : undefined;
  const labels = row?.family.members.find((m) => m.id === conversationId)?.labels;
  const tracked = row !== undefined && row.depth > 0 && !!labels?.["ae.model_start"];
  const usage = useAeSessionUsages([{ id: conversationId, stamp: 0 }], {
    enabled: tracked,
    live: tracked,
    staleMs: USAGE_MS,
    pollMs: USAGE_MS,
  }).get(conversationId);
  if (!tracked) return null;
  // Until usage lands the current point is unknown; show nothing rather than guess.
  if (!usage || (!usage.model && !usage.effort)) return null;
  const marks = aeRaiseMarks(labels, { model: usage.model, effort: usage.effort });
  if (!marks.raised) return null;
  return (
    <div
      className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
      data-testid="ae-family-raise-line"
      title={marks.title}
    >
      <span className="min-w-0 truncate">{marks.line}</span>
      {marks.capReached && (
        <span
          data-testid="ae-family-cap-reached"
          className="shrink-0 rounded bg-foreground/[0.07] px-1.5 text-[10px]"
        >
          cap reached
        </span>
      )}
    </div>
  );
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
        <FoldChevron lead={lead} />
      </Link>
    </li>
  );
}

const CLOSED_ROW = cn(
  SIDEBAR_ROW,
  "relative flex w-full items-center pr-2 text-left text-muted-foreground transition-colors",
  ROW_HOVER,
);

/** The indent and lines of a closed-group row, then its content. */
function ClosedFrame({ entry, children }: { entry: AeClosedEntry; children: ReactNode }) {
  return (
    <>
      <Lines row={entry.row} />
      <span
        aria-hidden="true"
        className="shrink-0"
        style={{ width: AE_FAMILY_TREE_STEP * entry.row.depth }}
      />
      {children}
    </>
  );
}

/** A closed-group row: the "N closed" fold, a closed session, or "Show N more". */
function ClosedSlot({
  id,
  entry,
  onNavigate,
}: {
  id: string;
  entry: AeClosedEntry;
  onNavigate?: (e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const { conversationId } = useParams<{ conversationId: string }>();
  const root = entry.row.family.root;
  if (entry.kind === "row") {
    const c = entry.conversation;
    const archived = c.archived === true;
    return (
      <li className="group relative" data-testid="ae-family-closed-row" data-family={root}>
        <Link
          to={`/c/${id}`}
          componentId="sidebar.family_closed"
          onClick={onNavigate}
          aria-current={conversationId === id ? "page" : undefined}
          className={cn(CLOSED_ROW, conversationId === id && "bg-muted text-foreground")}
        >
          <ClosedFrame entry={entry}>
            {archived ? (
              <ArchiveIcon className="ui-icon mr-1.5" aria-hidden="true" />
            ) : (
              <AeConversationStatusIcon conversation={c} className="mr-1.5" />
            )}
            <span className="min-w-0 truncate">{c.title ?? c.id}</span>
          </ClosedFrame>
        </Link>
      </li>
    );
  }
  const fold = entry.kind === "fold";
  const label = fold ? `${entry.count} closed` : `Show ${entry.hidden} more`;
  const press = () => {
    if (fold) toggleAeFamilyClosed(root, !entry.open);
    else revealAeFamilyClosed(root);
  };
  return (
    <li
      className="group relative"
      data-testid={fold ? "ae-family-closed-fold" : "ae-family-closed-more"}
      data-family={root}
    >
      <button
        type="button"
        aria-expanded={fold ? entry.open : undefined}
        onClick={press}
        className={cn(CLOSED_ROW, "cursor-pointer")}
      >
        <ClosedFrame entry={entry}>
          {fold &&
            (entry.open ? (
              <ChevronDownIcon className="ui-icon mr-1.5" aria-hidden="true" />
            ) : (
              <ChevronRightIcon className="ui-icon mr-1.5" aria-hidden="true" />
            ))}
          <span className="min-w-0 truncate">{label}</span>
        </ClosedFrame>
      </button>
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
  const closed = tree.closed.get(conversationId);
  if (closed) {
    return (
      <InFamilies.Provider value>
        <ClosedSlot id={conversationId} entry={closed} onNavigate={onNavigate} />
      </InFamilies.Provider>
    );
  }
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
