// Tabler icons (tabler.io/icons) as project icons (omnigent-ae, 2026-09-24).
// A project's `config.icon` holds `tabler:<name>`, e.g. `tabler:rocket`; an
// emoji saved before then still renders as text, and no icon is the folder.
// The shapes load lazily (`aeTablerIconData`), so a same-size empty box holds
// the place until they arrive; a name the set does not know is the folder.

import { useEffect, useState } from "react";
import { FolderIcon } from "lucide-react";
import {
  type AeTablerIconNode,
  type AeTablerIconSet,
  aeTablerIconsIfLoaded,
  loadAeTablerIcons,
} from "@/lib/aeTablerIconData";
import { cn } from "@/lib/utils";

export const AE_TABLER_PREFIX = "tabler:";
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The icon name in a `tabler:<name>` value, else `null` (an emoji, empty, or malformed). */
export function aeTablerName(icon: string | null | undefined): string | null {
  if (!icon?.startsWith(AE_TABLER_PREFIX)) return null;
  const name = icon.slice(AE_TABLER_PREFIX.length);
  return NAME_RE.test(name) ? name : null;
}

/** The stored value for a Tabler icon name. */
export function aeTablerValue(name: string): string {
  return `${AE_TABLER_PREFIX}${name}`;
}

/** The outline set once loaded; `"error"` when the chunk failed to load. */
export function useAeTablerIcons(): AeTablerIconSet | "error" | null {
  const [set, setSet] = useState<AeTablerIconSet | "error" | null>(aeTablerIconsIfLoaded);
  useEffect(() => {
    if (set !== null) return undefined;
    let live = true;
    loadAeTablerIcons().then(
      (loaded) => live && setSet(loaded),
      () => live && setSet("error"),
    );
    return () => {
      live = false;
    };
  }, [set]);
  return set;
}

/** One Tabler outline icon as an inline SVG, drawn in `currentColor`. */
export function AeTablerSvg({ node, className }: { node: AeTablerIconNode; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {node.map(([, attrs], i) => (
        <path
          // Paths are static per icon, so the index is a stable key.
          // oxlint-disable-next-line react/no-array-index-key
          key={i}
          d={attrs.d}
          fill={attrs.fill}
          stroke={attrs.stroke}
          opacity={attrs.opacity}
        />
      ))}
    </svg>
  );
}

/**
 * `ProjectRowIcon`'s branch for a `tabler:` value: the icon in the folder's box
 * and muted color, sized by the same `className`, so rows stay aligned.
 */
export function AeTablerRowIcon({ icon, className }: { icon: string; className?: string }) {
  const set = useAeTablerIcons();
  const name = aeTablerName(icon);
  const node = name && set && set !== "error" ? set[name] : undefined;
  if (set === "error" || (set && !node)) {
    return (
      <FolderIcon
        aria-hidden="true"
        className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground",
        className,
      )}
      data-testid="project-icon"
      data-tabler-icon={name ?? undefined}
    >
      {node ? <AeTablerSvg node={node} className="size-full" /> : null}
    </span>
  );
}

/**
 * The glyph inside a project icon tile (the pickers' triggers, the landing
 * header): an emoji as text, a `tabler:` value as a 1em SVG so the tile's own
 * font size sizes both. An unknown name draws the folder.
 */
export function AeProjectIconGlyph({ icon }: { icon: string }) {
  const name = aeTablerName(icon);
  if (!name) return icon;
  return <AeTablerGlyph name={name} />;
}

function AeTablerGlyph({ name }: { name: string }) {
  const set = useAeTablerIcons();
  const node = set && set !== "error" ? set[name] : undefined;
  if (set === "error" || (set && !node)) {
    return <FolderIcon aria-hidden="true" className="size-[1em]" />;
  }
  return node ? (
    <AeTablerSvg node={node} className="size-[1em]" />
  ) : (
    <span aria-hidden="true" className="inline-block size-[1em]" />
  );
}
