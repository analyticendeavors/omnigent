// Files the session created, newest first, from the workspace changes the
// Files panel loads. A row opens the file in the app's file viewer.

import { useState } from "react";
import {
  useWorkspaceChangedFiles,
  useWorkspaceEnvironment,
  useWorkspaceServeable,
} from "@/hooks/useWorkspaceChangedFiles";
import {
  type AeRailSectionProps,
  useAeRailSectionActive,
  useAeSessionRailStore,
} from "@/lib/aeSessionRail";
import { useFileViewer } from "@/shell/FileViewerContext";
import { AeRailSection } from "./AeRailSection";
import { AE_RAIL_FILE_ICON, aeRailChangesError, aeRailOutputs } from "./aeRailModel";
import { AeRailMuted, AeRailRow } from "./aeRailUi";

/** Rows shown before "Show all", so a busy session does not stretch the rail. */
export const AE_RAIL_OUTPUTS_SHOWN = 8;

export function AeRailOutputs({ sessionId }: AeRailSectionProps) {
  const active = useAeRailSectionActive("outputs");
  const changes = useWorkspaceChangedFiles(sessionId, { enabled: active });
  // The files query never runs without a workspace or a reachable host, so
  // these decide between "loading" and the reason nothing will load.
  const serveable = useWorkspaceServeable(sessionId);
  const environment = useWorkspaceEnvironment(sessionId, { enabled: active });
  const openFile = useFileViewer();
  const sheetOpen = useAeSessionRailStore((s) => s.sheetOpen);
  const setSheetOpen = useAeSessionRailStore((s) => s.setSheetOpen);
  const outputs = aeRailOutputs(changes.data?.data);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? outputs : outputs.slice(0, AE_RAIL_OUTPUTS_SHOWN);
  const hiddenCount = outputs.length - shown.length;
  const open = (path: string) => {
    if (!openFile) return;
    openFile(path);
    // On a phone the rail is a full-screen sheet over the viewer.
    if (sheetOpen) setSheetOpen(false);
  };

  let body;
  if (outputs.length > 0) {
    body = (
      <>
        {shown.map((file) => (
          <AeRailRow
            key={file.path}
            icon={AE_RAIL_FILE_ICON[file.kind]}
            title={openFile ? `${file.path}: open in the file viewer` : file.path}
            onClick={openFile ? () => open(file.path) : undefined}
          >
            {file.name}
            {file.folder && <span className="ml-1.5 text-muted-foreground">{file.folder}</span>}
          </AeRailRow>
        ))}
        {(hiddenCount > 0 || showAll) && outputs.length > AE_RAIL_OUTPUTS_SHOWN && (
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            className="mt-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {showAll ? "Show fewer" : `Show all ${outputs.length}`}
          </button>
        )}
      </>
    );
  } else if (changes.error) {
    body = <AeRailMuted>{aeRailChangesError(changes.error)}</AeRailMuted>;
  } else if (serveable === false) {
    body = <AeRailMuted>The host is offline; files show once it reconnects.</AeRailMuted>;
  } else if (changes.data?.available === false || environment.data?.available === false) {
    body = <AeRailMuted>This session has no workspace to create files in.</AeRailMuted>;
  } else if (environment.error && !changes.data) {
    body = <AeRailMuted>{aeRailChangesError(environment.error)}</AeRailMuted>;
  } else if (changes.isPending && active) {
    body = <AeRailMuted>Loading files…</AeRailMuted>;
  } else {
    body = <AeRailMuted>No new files yet.</AeRailMuted>;
  }

  return (
    <AeRailSection id="outputs" summary={outputs.length > 0 ? String(outputs.length) : undefined}>
      {body}
    </AeRailSection>
  );
}
