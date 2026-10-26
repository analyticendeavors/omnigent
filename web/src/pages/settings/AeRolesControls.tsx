// Small pieces Settings > Roles draws in several places: a preset's icon tile,
// a segmented choice and a 0..n stepper.

import { HomeIcon, MinusIcon, PlusIcon } from "lucide-react";
import { aeClaudeEffortLabel } from "@/lib/aeEffortDefault";
import {
  AE_ROLE_COLOR_CLASSES,
  AE_ROLE_EFFORTS,
  type AeRoleColor,
  type AeRoleEffort,
} from "@/lib/aeRoles";
import { AeProjectIconGlyph, aeTablerValue } from "@/lib/aeTablerIcon";
import { cn } from "@/lib/utils";

/** A preset's Tabler icon in a tile tinted with its color; `dot` adds the default's teal corner dot. */
export function AeRolePresetTile({
  icon,
  color,
  dot = false,
  size = "md",
  className,
}: {
  icon: string;
  color: AeRoleColor;
  dot?: boolean;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-testid="ae-role-preset-tile"
      data-icon={icon}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-lg",
        size === "xs" && "size-5 text-[11px]",
        size === "sm" && "size-6 text-[13px]",
        size === "md" && "size-7 text-[15px]",
        size === "lg" && "size-9 text-[18px]",
        AE_ROLE_COLOR_CLASSES[color].tile,
        className,
      )}
    >
      <AeProjectIconGlyph icon={aeTablerValue(icon)} />
      {dot && (
        <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-teal-400 ring-2 ring-background" />
      )}
    </span>
  );
}

/** The small tag on a preset whose Helpers rule keeps work in house ("Own subagents only"). */
export function AeInHouseTag() {
  return (
    <span
      title="Own subagents only: no other agents or sessions"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground"
    >
      <HomeIcon className="size-2.5" aria-hidden="true" />
      Own subagents only
    </span>
  );
}

/** A one-row radio group drawn as joined buttons; arrow keys move the choice. */
export function AeSegmented<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
  disabled = false,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  testId?: string;
  disabled?: boolean;
}) {
  const index = options.findIndex((o) => o.value === value);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      className="inline-flex shrink-0 overflow-hidden rounded-md border border-border text-xs"
      onKeyDown={(e) => {
        const step =
          e.key === "ArrowRight" || e.key === "ArrowDown"
            ? 1
            : e.key === "ArrowLeft" || e.key === "ArrowUp"
              ? -1
              : 0;
        if (!step) return;
        e.preventDefault();
        if (disabled) return;
        const next = options[(index + step + options.length) % options.length];
        onChange(next.value);
        const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]");
        buttons[(index + step + options.length) % options.length]?.focus();
      }}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-disabled={disabled || undefined}
            disabled={disabled}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              "px-2.5 py-1 whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring",
              on
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function AeStepper({
  label,
  value,
  min,
  max,
  onChange,
  disabled = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex shrink-0 items-center overflow-hidden rounded-md border border-border text-xs"
    >
      <button
        type="button"
        aria-label={`Fewer: ${label}`}
        disabled={disabled || value <= min}
        onClick={() => onChange(value - 1)}
        className="px-2 py-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
      >
        <MinusIcon className="size-3" />
      </button>
      <span aria-live="polite" className="min-w-6 text-center font-medium tabular-nums">
        {value}
      </span>
      <button
        type="button"
        aria-label={`More: ${label}`}
        disabled={disabled || value >= max}
        onClick={() => onChange(value + 1)}
        className="px-2 py-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
      >
        <PlusIcon className="size-3" />
      </button>
    </div>
  );
}

/**
 * Effort bars as a radio group: the five levels Low to Max, or the `levels` a
 * model offers. A null `effort` (an agent on its own default) fills no bar.
 */
export function AeEffortBar<T extends string = AeRoleEffort>({
  role,
  effort,
  onChange,
  disabled,
  levels = AE_ROLE_EFFORTS as unknown as readonly T[],
  emptyLabel = "Default",
  unavailable = null,
}: {
  role: string;
  effort: T | null;
  onChange: (effort: T) => void;
  disabled: boolean;
  levels?: readonly T[];
  emptyLabel?: string;
  /** A stored level the model no longer offers: shown as the last step, marked so. */
  unavailable?: T | null;
}) {
  const level = effort ? levels.indexOf(effort) : -1;
  return (
    <div className="flex items-center gap-2">
      <div
        role="radiogroup"
        aria-label={`${role} effort`}
        className="flex gap-0.5"
        onKeyDown={(e) => {
          const step =
            e.key === "ArrowRight" || e.key === "ArrowUp"
              ? 1
              : e.key === "ArrowLeft" || e.key === "ArrowDown"
                ? -1
                : 0;
          if (!step) return;
          e.preventDefault();
          if (disabled) return;
          const next = Math.max(0, Math.min(levels.length - 1, level + step));
          onChange(levels[next]);
          e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
        }}
      >
        {levels.map((value, i) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={value === effort}
            disabled={disabled}
            aria-label={`${aeClaudeEffortLabel(value) ?? value}${value === unavailable ? " (unavailable)" : ""}`}
            tabIndex={value === effort || (level < 0 && i === 0) ? 0 : -1}
            onClick={() => onChange(value)}
            className={cn(
              "h-4 w-2 rounded-[2px] focus-visible:outline-2 focus-visible:outline-ring",
              i <= level ? "bg-teal-400" : "bg-muted-foreground/25 hover:bg-muted-foreground/40",
            )}
          />
        ))}
      </div>
      <span className="min-w-10 text-xs whitespace-nowrap text-muted-foreground">
        {(effort &&
          `${aeClaudeEffortLabel(effort)}${effort === unavailable ? " (unavailable)" : ""}`) ||
          emptyLabel}
      </span>
    </div>
  );
}
