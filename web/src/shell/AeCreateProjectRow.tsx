// A "Create project" row at the foot of the Add to project lists (omnigent-ae,
// 2026-10-24). Creating used to need a typed name in the search box first. Picking
// this row turns it into its own name box: the pointer then rests on an input, not
// a menu item, so Radix's hover focus cannot pull focus back to the menu.

import { PlusIcon } from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";

interface ItemProps {
  className?: string;
  textValue?: string;
  onSelect?: (event: Event) => void;
  children?: ReactNode;
}

/** The foot row, then the name box. Enter files into the named project (made on demand). */
export function AeCreateProjectRow({
  Item,
  projects,
  onCreate,
}: {
  Item: ComponentType<ItemProps>;
  /** Existing project names: a typed match files into that project instead of a duplicate. */
  projects: readonly string[];
  onCreate: (project: string) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (naming) inputRef.current?.focus();
  }, [naming]);

  if (!naming) {
    return (
      <div className="border-t pt-1">
        <Item
          className="px-2 py-1"
          textValue="Create project"
          onSelect={(event) => {
            // Keep the menu open so the name can be typed.
            event.preventDefault();
            setNaming(true);
          }}
        >
          <PlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
          Create project
        </Item>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 border-t px-2 py-1.5">
      <PlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        aria-label="New project name"
        className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        placeholder="New project name, then Enter"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          // The menu's typeahead and arrow keys must not take the typing.
          event.stopPropagation();
          // Enter that confirms an IME composition is not a submit.
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          const trimmed = name.trim();
          if (!trimmed) return;
          event.preventDefault();
          const existing = projects.find((p) => p.toLowerCase() === trimmed.toLowerCase());
          onCreate(existing ?? trimmed);
        }}
      />
    </div>
  );
}
