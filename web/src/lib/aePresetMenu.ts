// How the composer's preset menu splits presets (omnigent-ae, 2026-10-24):
// pinned ones up front, the rest behind a "More presets" row. Pure, so the
// pill component stays small and the split is testable without rendering.

import type { AeRolePreset } from "@/lib/aeRoles";

/** The most hidden-preset icons the More row previews. */
export const AE_MORE_ICONS_MAX = 5;

export interface AePresetMenuGroups {
  /** "Pinned" when some preset is pinned, else "All presets" (nothing is hidden then). */
  heading: "Pinned" | "All presets";
  /** Shown up front, in saved order: pinned presets plus the active one. */
  top: AeRolePreset[];
  /** Behind the More row, in saved order. */
  hidden: AeRolePreset[];
}

export function aePresetMenuGroups(
  presets: readonly AeRolePreset[],
  activeId: string | null,
): AePresetMenuGroups {
  if (!presets.some((p) => p.pinned)) {
    return { heading: "All presets", top: [...presets], hidden: [] };
  }
  // The active preset stays visible even when unpinned, so the choice is never hidden.
  const isTop = (p: AeRolePreset) => p.pinned || p.id === activeId;
  return {
    heading: "Pinned",
    top: presets.filter(isTop),
    hidden: presets.filter((p) => !isTop(p)),
  };
}
