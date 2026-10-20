// The predicted next prompt drawn as grey ghost text over the empty composer,
// with a "Tab to use" chip ("Tap to use" on narrow screens). The text lets
// taps through to the box; only the chip fills it in. Nothing is sent here.

import { useRef, type MouseEvent } from "react";
import { cn } from "@/lib/utils";
import { useAeSuggestionHint } from "@/lib/aeSuggestion";

export function AeSuggestionGhost({
  text,
  onAccept,
}: {
  text: string;
  /** Fill `text` into this textarea (the composer's own, found beside the ghost). */
  onAccept: (textarea: HTMLTextAreaElement) => void;
}) {
  const hint = useAeSuggestionHint();
  const rootRef = useRef<HTMLDivElement>(null);
  const accept = (event: MouseEvent) => {
    event.preventDefault();
    const textarea = rootRef.current?.parentElement?.querySelector("textarea");
    if (textarea) onAccept(textarea);
  };
  return (
    // The row and the grey text let clicks through, so a tap anywhere but the
    // chip focuses the textarea; the chip keeps its own space at the end.
    <div
      ref={rootRef}
      data-testid="ae-suggestion"
      className="pointer-events-none absolute inset-x-3 top-3 flex items-start gap-2"
    >
      <span
        aria-hidden
        data-testid="ae-suggestion-text"
        className="composer-input-text min-w-0 truncate text-ui text-foreground/40"
      >
        {text}
      </span>
      <button
        type="button"
        tabIndex={-1}
        data-testid="ae-suggestion-hint"
        aria-label={`${hint}: ${text}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={accept}
        className={cn(
          "pointer-events-auto ml-auto shrink-0 rounded-md border border-current px-1.5 text-[11px] leading-[18px]",
          "text-muted-foreground opacity-70 hover:opacity-100",
        )}
      >
        {hint}
      </button>
    </div>
  );
}
