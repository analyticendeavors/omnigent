import { AE_SHARE_FILE_TYPES, AE_SHARE_MAX_FILE_BYTES } from "../services/aeShare";
import {
  EXTENSION_RPC_SOURCE,
  MAX_EXTENSION_MESSAGE_BYTES,
  type ExtensionIdentity,
  type ExtensionInboundMessage,
} from "./protocol";

const MAX_EXTENSION_MESSAGE_NODES = 5_000;
const MAX_EXTENSION_SESSION_PAGE_BYTES = 512 * 1024;
const MAX_EXTENSION_SESSION_PAGE_NODES = 25_000;

function isPayloadWithinBudget(
  value: unknown,
  maximumBytes: number,
  maximumNodes: number,
): boolean {
  let budget = maximumBytes;
  let nodes = 0;
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 20 || ++nodes > maximumNodes) return false;
    if (item === null || typeof item === "boolean" || typeof item === "number") {
      budget -= 8;
      return budget >= 0;
    }
    if (typeof item === "string") {
      budget -= item.length * 2;
      return budget >= 0;
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) return false;
      seen.add(item);
      return item.every((entry) => visit(entry, depth + 1));
    }
    if (typeof item !== "object") return false;
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer || item instanceof Blob)
      return false;
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (seen.has(item)) return false;
    seen.add(item);
    const entries = Object.entries(item);
    if (entries.length > 256) return false;
    return entries.every(([key, entry]) => visit(key, depth + 1) && visit(entry, depth + 1));
  };
  return visit(value, 0);
}

export function isExtensionPayloadWithinBudget(value: unknown): boolean {
  return isPayloadWithinBudget(value, MAX_EXTENSION_MESSAGE_BYTES, MAX_EXTENSION_MESSAGE_NODES);
}

// Session pages are bounded host projections, so their outbound-only budget
// can be larger without relaxing limits on extension requests or events.
export function isExtensionSessionPageWithinBudget(value: unknown): boolean {
  return isPayloadWithinBudget(
    value,
    MAX_EXTENSION_SESSION_PAGE_BYTES,
    MAX_EXTENSION_SESSION_PAGE_NODES,
  );
}

// omnigent-ae patch (2026-11-07): `navigation.share` may carry one image as a Blob, which the
// budget walk refuses by design. The Blob is taken out before the walk (the host checks its
// type and its 5 MB cap when it shares); the rest of the request is held to the same budget.
function isRequestWithinBudget(message: Record<string, unknown>): boolean {
  const params = message.params as Record<string, unknown> | null | undefined;
  if (
    message.type === "request" &&
    message.method === "navigation.share" &&
    params &&
    typeof params === "object" &&
    Array.isArray(params.files)
  ) {
    if (
      params.files.length > 1 ||
      !params.files.every(
        (file) =>
          file instanceof Blob &&
          file.size <= AE_SHARE_MAX_FILE_BYTES &&
          AE_SHARE_FILE_TYPES.has(file.type),
      )
    ) {
      return false;
    }
    return isExtensionPayloadWithinBudget({ ...message, params: { ...params, files: [] } });
  }
  return isExtensionPayloadWithinBudget(message);
}

export function isExtensionInboundMessage(
  value: unknown,
  identity: ExtensionIdentity,
): value is ExtensionInboundMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (
    message.source !== EXTENSION_RPC_SOURCE ||
    message.extensionId !== identity.extensionId ||
    message.pageId !== identity.pageId ||
    message.view !== identity.view ||
    message.nonce !== identity.nonce ||
    message.apiVersion !== identity.apiVersion
  ) {
    return false;
  }
  if (!isRequestWithinBudget(message)) return false;
  if (message.type === "ready") return true;
  if (message.type === "incompatible") return typeof message.sdkApiVersion === "number";
  if (message.type === "error") return typeof message.message === "string";
  if (message.type === "cancel") return typeof message.requestId === "string";
  return (
    message.type === "request" &&
    typeof message.requestId === "string" &&
    typeof message.method === "string"
  );
}
