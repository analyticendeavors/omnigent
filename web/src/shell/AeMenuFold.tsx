// A phone menu row that folds its items under it: the label, the current value
// and a chevron; tapping it shows or hides the items in place and keeps the
// menu open, so Status and Move take one row each on a phone (omnigent-ae).

import { ChevronRightIcon } from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
} from "react";
import { cn } from "@/lib/utils";

export interface AeMenuFoldItemProps {
  children?: ReactNode;
  className?: string;
  textValue?: string;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
  onSelect?: (event: Event) => void;
  "data-testid"?: string;
}

// One fold open at a time across the open menu, so Status and Move never both
// lengthen it. Only one row menu is ever open, so one module-wide value does.
let openFold: string | null = null;
const listeners = new Set<() => void>();

function setOpenFold(next: string | null) {
  openFold = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function AeMenuFold({
  Item,
  icon,
  label,
  value,
  testId,
  children,
}: {
  Item: ComponentType<AeMenuFoldItemProps>;
  icon: ReactNode;
  label: string;
  /** What is set now, shown at the row's end (Status shows its value; Move shows none). */
  value?: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  const open = useSyncExternalStore(subscribe, () => openFold === testId);
  const groupId = useId();
  const group = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The menu scrolls when it runs out of room; bring the opened items into view.
    if (open) group.current?.scrollIntoView?.({ block: "nearest" });
  }, [open]);
  // A closed menu unmounts its folds; the next one opens with both shut.
  useEffect(
    () => () => {
      if (openFold === testId) setOpenFold(null);
    },
    [testId],
  );

  return (
    <>
      <Item
        data-testid={testId}
        aria-expanded={open}
        aria-controls={open ? groupId : undefined}
        textValue={label}
        onSelect={(event) => {
          // Keep the menu open: this row only shows or hides its items.
          event.preventDefault();
          setOpenFold(open ? null : testId);
        }}
      >
        {icon}
        <span className="flex-1 text-left">{label}</span>
        {value ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">{value}</span>
        ) : null}
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </Item>
      {open ? (
        <div
          ref={group}
          id={groupId}
          role="group"
          aria-label={label}
          className="mx-1 mb-1 rounded-md bg-muted/60 py-0.5"
        >
          {children}
        </div>
      ) : null}
    </>
  );
}
