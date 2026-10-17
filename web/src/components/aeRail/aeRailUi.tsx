// Small pieces the session rail's sections share, so every section draws its
// rows, bars and quiet lines the same way.

import type { ReactNode } from "react";
import { type AeTone, contextTone } from "@/lib/aeContextTone";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import { cn } from "@/lib/utils";
import { AE_RAIL_ICONS, type AeRailIconName } from "./aeRailIcons";

export function AeRailIcon({ name, className }: { name: AeRailIconName; className?: string }) {
  return <AeTablerSvg node={AE_RAIL_ICONS[name]} className={cn("size-4 shrink-0", className)} />;
}

/**
 * One line: a muted icon, the label (truncated), then trailing content.
 * With `onClick` it is a button with a hover state.
 */
export function AeRailRow({
  icon,
  children,
  trailing,
  title,
  onClick,
  className,
}: {
  icon?: AeRailIconName | ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  title?: string;
  onClick?: () => void;
  className?: string;
}) {
  const content = (
    <>
      {typeof icon === "string" ? (
        <AeRailIcon name={icon as AeRailIconName} className="text-muted-foreground" />
      ) : (
        icon
      )}
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      {trailing}
    </>
  );
  const base = "flex min-h-7 w-full items-center gap-2 py-1";
  if (!onClick) {
    return (
      <div className={cn(base, className)} title={title}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        base,
        "-mx-1.5 w-[calc(100%+0.75rem)] rounded-md px-1.5 hover:bg-muted",
        className,
      )}
    >
      {content}
    </button>
  );
}

const TONE_BAR: Record<AeTone, string> = {
  normal: "bg-chart-1",
  warning: "bg-warning",
  critical: "bg-destructive",
};

/** A toned percentage as text: an amber that reads on white. */
export const AE_RAIL_TONE_TEXT: Record<AeTone, string | undefined> = {
  normal: undefined,
  warning: "text-amber-700 dark:text-amber-400",
  critical: "text-destructive",
};

/** A thin meter; colors follow the context ring's steps unless a tone is given. */
export function AeRailBar({
  pct,
  tone,
  className,
}: {
  pct: number;
  tone?: AeTone;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-foreground/10", className)}>
      <div
        className={cn("h-full rounded-full", TONE_BAR[tone ?? contextTone(clamped)])}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/** A quiet line: an empty state, a hint, or what the section cannot know. */
export function AeRailMuted({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("py-1 text-xs text-muted-foreground", className)}>{children}</p>;
}

/** Small muted text for timestamps, counts and sources. */
export function AeRailMeta({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-xs text-muted-foreground", className)}>{children}</span>;
}
