// A phone menu row that folds its items under it: the label, the current value
// and a chevron; tapping it shows or hides the items in place and keeps the
// menu open, so Status and Move take one row each on a phone (omnigent-ae).

import { ChevronRightIcon } from "lucide-react";
import { type ComponentType, type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

export interface AeMenuFoldItemProps {
  children?: ReactNode;
  className?: string;
  textValue?: string;
  "aria-expanded"?: boolean;
  onSelect?: (event: Event) => void;
  "data-testid"?: string;
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
  const [open, setOpen] = useState(false);
  return (
    <>
      <Item
        data-testid={testId}
        aria-expanded={open}
        textValue={label}
        onSelect={(event) => {
          // Keep the menu open: this row only shows or hides its items.
          event.preventDefault();
          setOpen((was) => !was);
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
        <div role="group" aria-label={label} className="mx-1 mb-1 rounded-md bg-muted/60 py-0.5">
          {children}
        </div>
      ) : null}
    </>
  );
}
