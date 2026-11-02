// Class names for the small "when" chips on Settings > Roles (omnigent-ae, 2026-11-01): the
// reviewer rows and the personas list share them, so a persona reads the same in both.

import type { AePersonaWhen } from "@/lib/aePersonas";

/** Shape of every chip: a pill with a hairline border. */
export const AE_CHIP = "rounded-full border px-1.5 py-px text-[11px] whitespace-nowrap";

/** A neutral chip, e.g. a persona's model and effort. */
export const AE_CHIP_NEUTRAL = `${AE_CHIP} border-border text-muted-foreground`;

/** Teal when the persona runs on every diff, amber when only on a risky one. */
export const aeWhenChipClass = (when: AePersonaWhen): string =>
  `${AE_CHIP} ${
    when === "risky"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
      : "border-teal-500/40 bg-teal-500/10 text-teal-700 dark:text-teal-300"
  }`;
