// The session rail's Sent files section, the pure part: the images and files
// on the session's loaded user messages, oldest first, each with when it went.

import {
  type AnyBlock,
  type ImageContentBlock,
  type ImagePreview,
  PENDING_FILE_PREFIX,
  attachmentLabel,
  imagePreview,
} from "@/lib/blocks";

export type AeSentFile =
  | { kind: "image"; key: string; name: string; sentAtS: number | null; preview: ImagePreview }
  | { kind: "file"; key: string; name: string; sentAtS: number | null; fileId: string | null };

/** Every `input_image` and `input_file` part on the loaded user messages. */
export function sentFilesOf(blocks: readonly AnyBlock[]): AeSentFile[] {
  const files: AeSentFile[] = [];
  const seen = new Map<string, number>();
  // The same file sent twice is two rows; the suffix keeps their keys apart.
  const keyFor = (base: string) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  };
  for (const block of blocks) {
    if (block.type !== "user_message") continue;
    const sentAtS = block.ctx.createdAtS ?? block.ctx.clientCreatedAtS ?? null;
    for (const part of block.content) {
      if (part.type === "input_image") {
        const preview = imagePreview(part as ImageContentBlock);
        const name =
          preview.kind === "uploaded" || preview.kind === "inline" ? preview.alt : preview.label;
        const base = `img:${part.file_id ?? part.filename ?? name}`;
        files.push({ kind: "image", key: keyFor(base), name, sentAtS, preview });
      } else if (part.type === "input_file") {
        // An upload still in flight has nothing to open yet.
        const raw = typeof part.file_id === "string" ? part.file_id : null;
        const fileId = raw && !raw.startsWith(PENDING_FILE_PREFIX) ? raw : null;
        const name = attachmentLabel(part);
        files.push({
          kind: "file",
          key: keyFor(`file:${fileId ?? name}`),
          name,
          sentAtS,
          fileId,
        });
      }
    }
  }
  return files;
}

/** A session file's content path, the one the chat's image previews load. */
export function sessionFileContentPath(sessionId: string, fileId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/resources/files/${encodeURIComponent(fileId)}/content`;
}

/** "6:46 AM" today, else "Oct 14, 6:46 AM"; empty when the time is unknown. */
export function formatSentAt(sentAtS: number | null, now: Date): string {
  if (sentAtS === null) return "";
  const at = new Date(sentAtS * 1000);
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return today
    ? time
    : `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}
