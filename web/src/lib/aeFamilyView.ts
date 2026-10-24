// The sidebar's view of session families (omnigent-ae, 2026-10-23): the
// context every row reads, a hook that keeps the families stable across list
// updates. The families themselves: `aeFamily.ts`; Grouping > Family's tree:
// `aeFamilyTree.ts`.

import { createContext, useMemo, useRef } from "react";
import type { Conversation } from "@/hooks/useConversations";
import { type AeFamilies, NO_FAMILIES, aeFamilies } from "@/lib/aeFamily";
import type { AeFamilyTree } from "@/lib/aeFamilyTree";

export interface AeFamilyView {
  families: AeFamilies;
  /** The Show menu's "Family dots" switch. */
  dots: boolean;
  /** The family the list is narrowed to, by its top session's id. */
  filter: string | null;
  onFilter: (root: string | null) => void;
  /** Grouping > Family's tree rows, `null` in every other view. */
  tree?: AeFamilyTree | null;
}

export const AeFamilyContext = createContext<AeFamilyView>({
  families: NO_FAMILIES,
  dots: false,
  filter: null,
  onFilter: () => {},
});

function signature(families: AeFamilies): string {
  const parts: string[] = [];
  for (const family of families.byRoot.values()) {
    parts.push(`${family.root}:${family.color}:${family.leadTitle ?? ""}`);
    for (const member of family.members) {
      const role = families.byRow.get(member.id);
      parts.push(`${member.id}:${role?.forked ? 1 : 0}:${role?.parentTitle ?? ""}`);
    }
  }
  return parts.join("\n");
}

/**
 * The families among *rows*, `NO_FAMILIES` while nothing shows them. The same
 * object comes back until a family, member, color or title changes, so a list
 * update that only bumps a row's time does not re-render every row's dot.
 */
export function useAeFamilies(
  rows: readonly Conversation[],
  enabled: boolean,
  orphans = false,
): AeFamilies {
  const kept = useRef<{ key: string; families: AeFamilies }>({ key: "", families: NO_FAMILIES });
  return useMemo(() => {
    const families = enabled ? aeFamilies(rows, orphans) : NO_FAMILIES;
    const key = signature(families);
    if (key !== kept.current.key) kept.current = { key, families };
    return kept.current.families;
  }, [rows, enabled, orphans]);
}
