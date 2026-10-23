// The sidebar's view of session families (omnigent-ae, 2026-10-23): the
// context every row reads, a hook that keeps the families stable across list
// updates, and the "By family" groups. The families themselves: `aeFamily.ts`.

import { createContext, useMemo, useRef } from "react";
import type { Conversation } from "@/hooks/useConversations";
import { type AeFamilies, type AeFamily, NO_FAMILIES, aeFamilies } from "@/lib/aeFamily";

export interface AeFamilyView {
  families: AeFamilies;
  /** The Show menu's "Family dots" switch. */
  dots: boolean;
  /** The family the list is narrowed to, by its top session's id. */
  filter: string | null;
  onFilter: (root: string | null) => void;
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
export function useAeFamilies(rows: readonly Conversation[], enabled: boolean): AeFamilies {
  const kept = useRef<{ key: string; families: AeFamilies }>({ key: "", families: NO_FAMILIES });
  return useMemo(() => {
    const families = enabled ? aeFamilies(rows) : NO_FAMILIES;
    const key = signature(families);
    if (key !== kept.current.key) kept.current = { key, families };
    return kept.current.families;
  }, [rows, enabled]);
}

/** The rest of the list under "By family": sessions in no family. */
export const AE_FAMILY_REST = "Sessions";

/**
 * "By family": one group per family, named after its lead and in the order its
 * first row appears, then everything else. `leadsFirst` is *ordered* with each
 * lead ahead of its family, for the caller to split by `groupTitles`.
 */
export function aeFamilyGroups(ordered: readonly Conversation[], families: AeFamilies) {
  const groupTitles = new Map<string, string>();
  const titleOfRoot = new Map<string, string>();
  const familyByTitle = new Map<string, AeFamily>();
  const groupOrder: string[] = [];
  for (const c of ordered) {
    const family = families.byRow.get(c.id)?.family;
    if (!family) {
      groupTitles.set(c.id, AE_FAMILY_REST);
      continue;
    }
    let title = titleOfRoot.get(family.root);
    if (title === undefined) {
      const base = family.leadTitle ?? "Unlisted session";
      title = base;
      for (let n = 2; familyByTitle.has(title) || title === AE_FAMILY_REST; n += 1) {
        title = `${base} (${n})`;
      }
      titleOfRoot.set(family.root, title);
      familyByTitle.set(title, family);
      groupOrder.push(title);
    }
    groupTitles.set(c.id, title);
  }
  groupOrder.push(AE_FAMILY_REST);
  const isLead = (c: Conversation) => Number(families.byRow.get(c.id)?.isLead ?? false);
  const leadsFirst = [...ordered].sort((a, b) => isLead(b) - isLead(a));
  return { leadsFirst, groupTitles, groupOrder, familyByTitle };
}
