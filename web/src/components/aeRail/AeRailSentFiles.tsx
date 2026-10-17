// The rail's Sent files section: what this session's loaded user messages
// carried. Images are thumbnails that open in the chat's lightbox; other files
// are rows that open the stored file in a new tab.

import { useState } from "react";
import { InlineImage, SessionImage } from "@/components/SessionImage";
import {
  type AeSentFile,
  formatSentAt,
  sentFilesOf,
  sessionFileContentPath,
} from "@/lib/aeRailSentFiles";
import type { AeRailSectionProps } from "@/lib/aeSessionRail";
import { withBasePath } from "@/lib/basePath";
import { getOmnigentHostConfig } from "@/lib/host";
import { authenticatedFetch } from "@/lib/identity";
import { AeRailSection } from "./AeRailSection";
import { useAeRailLoadedBlocks } from "./aeRailSessionData";
import { AeRailIcon, AeRailMuted, AeRailRow } from "./aeRailUi";

export function AeRailSentFiles({ sessionId }: AeRailSectionProps) {
  const loaded = useAeRailLoadedBlocks(sessionId);
  const files = loaded ? sentFilesOf(loaded.blocks) : [];
  return (
    <AeRailSection id="sent" summary={files.length > 0 ? String(files.length) : undefined}>
      <AeSentFilesBody
        sessionId={sessionId}
        files={files}
        loaded={loaded !== null}
        moreHistory={loaded?.moreHistory ?? false}
      />
    </AeRailSection>
  );
}

function AeSentFilesBody({
  sessionId,
  files,
  loaded,
  moreHistory,
}: {
  sessionId: string;
  files: AeSentFile[];
  loaded: boolean;
  moreHistory: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  if (!loaded) {
    return <AeRailMuted>Files show once this session&apos;s messages load.</AeRailMuted>;
  }
  if (files.length === 0) {
    return (
      <AeRailMuted>
        {moreHistory
          ? "No files in the messages loaded so far."
          : "No files sent in this session yet."}
      </AeRailMuted>
    );
  }
  const now = new Date();
  const images = files.filter((file) => file.kind === "image");
  const others = files.filter((file) => file.kind === "file");
  const open = (file: Extract<AeSentFile, { kind: "file" }>) => {
    if (!file.fileId) {
      setError(`${file.name} has not finished uploading; open it once the message is sent.`);
      return;
    }
    setError(null);
    openSessionFile(sessionId, file.fileId, file.name).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      setError(`Could not open ${file.name}: ${reason}. Reload the page and try again.`);
    });
  };
  return (
    <div className="text-sm">
      {images.length > 0 && (
        <div className="mt-0.5 mb-1.5 grid grid-cols-3 gap-1.5">
          {images.map((file) => (
            <AeThumbnail key={file.key} sessionId={sessionId} file={file} now={now} />
          ))}
        </div>
      )}
      {others.map((file) => {
        const at = formatSentAt(file.sentAtS, now);
        return (
          <AeRailRow
            key={file.key}
            icon="paperclip"
            title={at ? `${file.name} · ${at}` : file.name}
            onClick={() => open(file)}
          >
            {file.name}
            {at && <span className="text-muted-foreground"> · {at}</span>}
          </AeRailRow>
        );
      })}
      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function AeThumbnail({
  sessionId,
  file,
  now,
}: {
  sessionId: string;
  file: Extract<AeSentFile, { kind: "image" }>;
  now: Date;
}) {
  const at = formatSentAt(file.sentAtS, now);
  const { preview } = file;
  return (
    <div
      data-testid="ae-sent-thumb"
      title={at ? `${file.name} · ${at}` : file.name}
      // The chat's own image (and its lightbox button) stretched to fill the tile.
      className="relative aspect-[4/3] overflow-hidden rounded-md border border-border bg-background hover:border-foreground/40 [&_button]:size-full [&_img]:size-full [&_img]:object-cover [&>div]:size-full"
    >
      {preview.kind === "uploaded" ? (
        <SessionImage path={sessionFileContentPath(sessionId, preview.fileId)} alt={file.name} />
      ) : preview.kind === "inline" ? (
        <InlineImage src={preview.src} alt={file.name} />
      ) : (
        <div className="flex items-center justify-center text-muted-foreground">
          <AeRailIcon name="photo" />
        </div>
      )}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-background/80 px-1 text-[10px] leading-normal text-foreground">
        {file.name}
      </span>
    </div>
  );
}

/**
 * Open a stored session file. Same origin, a new tab loads the path, whose
 * download headers keep uploaded HTML or SVG from running in the app's origin.
 * Embedded, the bytes come through the host's fetcher and are saved as a
 * download, never navigated to, for the same reason.
 */
export async function openSessionFile(
  sessionId: string,
  fileId: string,
  name: string,
): Promise<void> {
  const path = sessionFileContentPath(sessionId, fileId);
  if (!getOmnigentHostConfig().fetcher) {
    window.open(withBasePath(path), "_blank", "noopener,noreferrer");
    return;
  }
  const res = await authenticatedFetch(path);
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  const blob = new Blob([await res.arrayBuffer()], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
