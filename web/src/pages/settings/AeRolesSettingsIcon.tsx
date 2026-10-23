// The Roles settings section's nav icon: Tabler users-group, copied from
// @tabler/icons (tabler-nodes-outline.json).

import { AeTablerSvg } from "@/lib/aeTablerIcon";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";
import { cn } from "@/lib/utils";

const USERS_GROUP: AeTablerIconNode = [
  ["path", { d: "M10 13a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" }],
  ["path", { d: "M8 21v-1a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v1" }],
  ["path", { d: "M15 5a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" }],
  ["path", { d: "M17 10h2a2 2 0 0 1 2 2v1" }],
  ["path", { d: "M5 5a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" }],
  ["path", { d: "M3 13v-1a2 2 0 0 1 2 -2h2" }],
];

export function AeRolesSettingsIcon({ className }: { className?: string }) {
  return <AeTablerSvg node={USERS_GROUP} className={cn("size-4 shrink-0", className)} />;
}
