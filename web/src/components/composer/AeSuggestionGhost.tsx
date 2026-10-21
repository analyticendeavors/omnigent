// The predicted next prompt drawn as grey ghost text over the empty composer,
// with a "Tab to use" chip ("Tap to use" on narrow screens). With more than one
// guess the chip adds a "1/3" counter that steps to the next one, as the cycle
// keys do. The text wraps, and the textarea grows to fit it; it lets taps
// through to the box, and only the chip fills it in. Nothing is sent here.

import { useLayoutEffect, useRef, type MouseEvent } from "react";
import { cn } from "@/lib/utils";
import { useAeSuggestionHint } from "@/lib/aeSuggestion";
import { aeChordLabel, useAeSuggestionKeys } from "@/lib/aeSuggestionKeys";

export function AeSuggestionGhost({
  text,
  index = 0,
  count = 1,
  onCycle,
  onAccept,
}: {
  text: string;
  /** Which guess `text` is (0-based) out of `count`. */
  index?: number;
  count?: number;
  onCycle?: (step: 1 | -1) => void;
  /** Fill `text` into this textarea (the composer's own, found beside the ghost). */
  onAccept: (textarea: HTMLTextAreaElement) => void;
}) {
  const hint = useAeSuggestionHint();
  const keys = useAeSuggestionKeys();
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const textarea = () => rootRef.current?.parentElement?.querySelector("textarea") ?? null;
  const accept = (event: MouseEvent) => {
    event.preventDefault();
    const el = textarea();
    if (el) onAccept(el);
  };
  const cycle = (event: MouseEvent) => {
    event.preventDefault();
    onCycle?.(1);
  };

  // The ghost floats over the empty textarea, so hold the textarea at least as
  // tall as the wrapped text; the hold goes when the ghost does.
  useLayoutEffect(() => {
    const el = textarea();
    const span = textRef.current;
    if (!el || !span) return;
    // The textarea's own floor (a class), read before the inline hold hides it.
    const floor = parseFloat(getComputedStyle(el).minHeight) || 0;
    const fit = () => {
      const bottom = span.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
      const padding = parseFloat(getComputedStyle(el).paddingBottom) || 0;
      el.style.minHeight = `${Math.max(floor, Math.ceil(bottom + padding))}px`;
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(span);
    return () => {
      observer?.disconnect();
      el.style.minHeight = "";
    };
  }, []);

  const many = count > 1 && onCycle;
  const counter = `${index + 1}/${count}`;
  return (
    // The row and the grey text let clicks through, so a tap anywhere but the
    // chip focuses the textarea; the chip keeps its own space at the end.
    <div
      ref={rootRef}
      data-testid="ae-suggestion"
      className="pointer-events-none absolute inset-x-3 top-3 flex items-start gap-2"
    >
      <span
        ref={textRef}
        aria-hidden
        data-testid="ae-suggestion-text"
        className="composer-input-text min-w-0 flex-1 whitespace-normal break-words text-ui text-foreground/40"
      >
        {text}
      </span>
      <span
        className={cn(
          "pointer-events-auto ml-auto flex shrink-0 items-stretch rounded-md border border-current text-[11px] leading-[18px]",
          "text-muted-foreground opacity-70 hover:opacity-100",
        )}
      >
        <button
          type="button"
          tabIndex={-1}
          data-testid="ae-suggestion-hint"
          aria-label={`${hint}: ${text}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={accept}
          className="px-1.5"
        >
          {hint}
        </button>
        {many && (
          <button
            type="button"
            tabIndex={-1}
            data-testid="ae-suggestion-next"
            aria-label={`Suggestion ${counter}, show the next one`}
            title={`Next suggestion (${aeChordLabel(keys.next)}), previous (${aeChordLabel(keys.previous)})`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={cycle}
            className="border-l border-current px-1.5 tabular-nums"
          >
            {counter} ›
          </button>
        )}
      </span>
    </div>
  );
}
