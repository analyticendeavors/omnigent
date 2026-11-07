// omnigent-ae patch (2026-11-07): `navigation.share` hands text, and one image, to the
// browser's own share sheet. The Social card runs in a sandboxed frame that cannot call
// `navigator.share` or open the LinkedIn app, and the Home Screen app opens outside links in
// Safari's in-app view, which iOS never passes to an installed app. The share sheet does
// reach it. The host calls `navigator.share` itself, the way `openExternal` calls
// `window.open`, from the same tap, so the frame's sandbox and CSP stay as they are.
import { ExtensionHostServiceError } from "./errors";

/** The longest text one share may carry, counted in code points. */
export const AE_SHARE_MAX_TEXT = 3000;
/** The longest title, in code points. */
export const AE_SHARE_MAX_TITLE = 200;
/** The largest image, in bytes. */
export const AE_SHARE_MAX_FILE_BYTES = 5 * 1024 * 1024;
const FILE_TYPES = new Set(["image/jpeg", "image/png"]);

export interface AeShareResult {
  shared: true;
  /** The device's share sheet cannot take the image, so only the text went. */
  files_dropped?: true;
}

function codePoints(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

function invalid(message: string): ExtensionHostServiceError {
  return new ExtensionHostServiceError("InvalidParams", message);
}

function textField(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid(`${name} must be a string`);
  if (codePoints(value) > max) throw invalid(`${name} is longer than ${max} characters`);
  return value;
}

/** The File to share: a Blob of an allowed type under the size cap, named for the sheet. */
function fileFrom(value: unknown): File {
  if (!(value instanceof Blob)) throw invalid("files must hold a File or Blob");
  if (!FILE_TYPES.has(value.type)) throw invalid("the image must be image/jpeg or image/png");
  if (value.size > AE_SHARE_MAX_FILE_BYTES) throw invalid("the image is larger than 5 MB");
  if (value instanceof File) return value;
  return new File([value], value.type === "image/png" ? "image.png" : "image.jpg", {
    type: value.type,
  });
}

export async function aeShare(params: Record<string, unknown>): Promise<AeShareResult> {
  const text = textField(params.text, "text", AE_SHARE_MAX_TEXT);
  const title = textField(params.title, "title", AE_SHARE_MAX_TITLE);
  const rawFiles = params.files;
  if (rawFiles !== undefined && (!Array.isArray(rawFiles) || rawFiles.length > 1)) {
    throw invalid("files must be a list of at most one image");
  }
  const files = (rawFiles ?? []).map(fileFrom);
  if (text === undefined && title === undefined && files.length === 0) {
    throw invalid("share needs text, a title or an image");
  }
  if (typeof navigator.share !== "function") {
    throw new ExtensionHostServiceError("ShareUnavailable", "This browser has no share sheet");
  }
  const data: ShareData = {};
  if (text !== undefined) data.text = text;
  if (title !== undefined) data.title = title;
  let filesDropped = false;
  if (files.length > 0) {
    if (typeof navigator.canShare === "function" && navigator.canShare({ files })) {
      data.files = files;
    } else {
      filesDropped = true;
    }
  }
  if (filesDropped && data.text === undefined && data.title === undefined) {
    throw new ExtensionHostServiceError("ShareUnavailable", "This share sheet cannot take images");
  }
  try {
    await navigator.share(data);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ExtensionHostServiceError("ShareCancelled", "The share sheet was closed");
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ExtensionHostServiceError("ShareFailed", `The share sheet failed: ${detail}`);
  }
  return filesDropped ? { shared: true, files_dropped: true } : { shared: true };
}
