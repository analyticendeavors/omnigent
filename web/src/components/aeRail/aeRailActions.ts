// What the shell lets the session rail open: the workspace panel's Changes and
// Agents tabs (drawers on a phone).

import { createContext, useContext } from "react";

export type AeRailWorkspaceTab = "changes" | "subagents";

/** The shell's own controls for the workspace panel, handed to the rail. */
export interface AeRailWorkspace {
  /** The workspace panel is open. */
  open: boolean;
  /** The session has a workspace panel to open at all. */
  available: boolean;
  /** Open or close the panel the way the header's toggle does. */
  toggle: () => void;
  showTab: (tab: AeRailWorkspaceTab) => void;
  /** Phone drawers, which take the whole screen. */
  mobile: Record<AeRailWorkspaceTab, () => void>;
}

export const AeRailActionsContext = createContext<{
  openWorkspaceTab?: (tab: AeRailWorkspaceTab) => void;
}>({});

/** Opens a workspace tab, or `undefined` where the rail cannot reach one. */
export function useAeRailOpenWorkspaceTab(): ((tab: AeRailWorkspaceTab) => void) | undefined {
  return useContext(AeRailActionsContext).openWorkspaceTab;
}
