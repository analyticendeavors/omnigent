// `server.request`: the one bridge between an extension page and the server's
// HTTP API (omnigent-ae patch P2, 2026-09-23). Pages run in an opaque-origin
// iframe with no network egress, so the host makes the call on their behalf
// over its own authenticated fetch. The bridge is an allowlist, not a proxy:
// a request that is not one of the shapes below is refused before any fetch,
// with `PermissionDenied` for a route or method outside the list and
// `InvalidParams` for a malformed body inside it.
//
// Allowed:
//   GET|POST  /v1/ae/...                     the AE layer's own routes
//   PATCH     /v1/sessions/{id}              body {labels: {"ae.*": string}} only
//   POST      /v1/sessions/{id}/events       a user message ({type: "message",
//                                            data: {role: "user", content}})
//
// The response is handed back as `{status, ok, body}` with the body parsed as
// JSON when the server sent JSON (text otherwise, bounded), so the page reads
// the server's own `{"error": {"code", "message"}}` shape and decides what to
// show. Both directions are held to the RPC message budget.

import { authenticatedFetch } from "@/lib/identity";
import { MAX_EXTENSION_MESSAGE_BYTES } from "../rpc/protocol";
import { isExtensionPayloadWithinBudget } from "../rpc/validation";
import { ExtensionHostServiceError } from "./errors";

export const SERVER_REQUEST_METHODS = ["GET", "POST", "PATCH"] as const;
export type ServerRequestMethod = (typeof SERVER_REQUEST_METHODS)[number];

/** Label keys an extension may write through the labels PATCH. */
export const SERVER_REQUEST_LABEL_NAMESPACE = "ae.";
export const SERVER_REQUEST_LABEL_KEY_MAX_LENGTH = 64;
/** The store caps a label value at 256 characters; the page never needs more. */
export const SERVER_REQUEST_LABEL_VALUE_MAX_LENGTH = 256;
export const SERVER_REQUEST_LABELS_MAX_KEYS = 16;
export const SERVER_REQUEST_PATH_MAX_LENGTH = 1_024;
export const SERVER_REQUEST_TEXT_MAX_LENGTH = 16_384;
const SESSION_ID_MAX_LENGTH = 256;

const AE_ROUTE = /^\/v1\/ae\/[A-Za-z0-9_./-]+$/;
const SESSION_ROUTE = /^\/v1\/sessions\/([^/]+)$/;
const SESSION_EVENTS_ROUTE = /^\/v1\/sessions\/([^/]+)\/events$/;
const SESSION_ID = /^[A-Za-z0-9._~:-]+$/;
const QUERY = /^[A-Za-z0-9_.~%+=&-]*$/;

export type ServerRequestKind = "ae" | "labels" | "user-message";

export interface ServerRequest {
  kind: ServerRequestKind;
  method: ServerRequestMethod;
  path: string;
  body: Record<string, unknown> | null;
}

export interface ServerResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Record<string, unknown>;
}

function denied(message: string): ExtensionHostServiceError {
  return new ExtensionHostServiceError("PermissionDenied", message);
}

function invalid(message: string): ExtensionHostServiceError {
  return new ExtensionHostServiceError("InvalidParams", message);
}

function requireKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw denied(`${what} may not carry ${JSON.stringify(key)}`);
    }
  }
}

function validSessionId(segment: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return false;
  }
  return (
    decoded.length >= 1 &&
    decoded.length <= SESSION_ID_MAX_LENGTH &&
    decoded !== "." &&
    decoded !== ".." &&
    SESSION_ID.test(decoded)
  );
}

/** The AE routes: a safe relative path under `/v1/ae/`, an optional plain query. */
function parseAePath(path: string): string {
  const [pathname, query, ...rest] = path.split("?");
  if (rest.length > 0 || !AE_ROUTE.test(pathname)) {
    throw denied("Path is outside the allowed routes");
  }
  if (pathname.split("/").some((segment) => segment === "." || segment === "..")) {
    throw denied("Path is outside the allowed routes");
  }
  if (query !== undefined && !QUERY.test(query)) {
    throw invalid("Query string contains unsupported characters");
  }
  return path;
}

/** `PATCH /v1/sessions/{id}`: `{labels}` only, every key under `ae.`, string values. */
function parseLabelsBody(body: unknown): Record<string, unknown> {
  const value = plainObject(body);
  if (!value) throw invalid("A labels PATCH needs an object body");
  requireKeys(value, ["labels"], "A session PATCH");
  const labels = plainObject(value.labels);
  if (!labels) throw invalid("labels must be an object");
  const entries = Object.entries(labels);
  if (entries.length < 1) throw invalid("labels must name at least one key");
  if (entries.length > SERVER_REQUEST_LABELS_MAX_KEYS) {
    throw invalid(`labels may carry at most ${SERVER_REQUEST_LABELS_MAX_KEYS} keys`);
  }
  for (const [key, item] of entries) {
    if (
      !key.startsWith(SERVER_REQUEST_LABEL_NAMESPACE) ||
      key.length <= SERVER_REQUEST_LABEL_NAMESPACE.length ||
      key.length > SERVER_REQUEST_LABEL_KEY_MAX_LENGTH ||
      key.trim() !== key
    ) {
      throw denied(
        `Label ${JSON.stringify(key)} is outside the ${SERVER_REQUEST_LABEL_NAMESPACE}* namespace`,
      );
    }
    if (typeof item !== "string" || item.length > SERVER_REQUEST_LABEL_VALUE_MAX_LENGTH) {
      throw invalid(
        `Label ${JSON.stringify(key)} must be a string of at most ${SERVER_REQUEST_LABEL_VALUE_MAX_LENGTH} characters`,
      );
    }
  }
  return { labels: { ...labels } };
}

/** `POST /v1/sessions/{id}/events`: one user message, the shape the composer posts. */
function parseUserMessageBody(body: unknown): Record<string, unknown> {
  const value = plainObject(body);
  if (!value) throw invalid("A session event needs an object body");
  requireKeys(value, ["type", "data"], "A session event");
  if (value.type !== "message") throw denied("Only message events may be posted");
  const data = plainObject(value.data);
  if (!data) throw invalid("Event data must be an object");
  requireKeys(data, ["role", "content"], "A message event");
  if (data.role !== "user") throw denied("Only user messages may be posted");
  if (!Array.isArray(data.content) || data.content.length < 1) {
    throw invalid("Message content must be a non-empty array");
  }
  const content = data.content.map((part) => {
    const item = plainObject(part);
    if (!item) throw invalid("Message content parts must be objects");
    requireKeys(item, ["type", "text"], "A message content part");
    if (item.type !== "input_text" || typeof item.text !== "string") {
      throw invalid("Message content parts must be {type: 'input_text', text}");
    }
    if (item.text.length > SERVER_REQUEST_TEXT_MAX_LENGTH) {
      throw invalid(`Message text may be at most ${SERVER_REQUEST_TEXT_MAX_LENGTH} characters`);
    }
    return { type: "input_text", text: item.text };
  });
  return { type: "message", data: { role: "user", content } };
}

/**
 * Check one `server.request` call against the allowlist. Returns the request
 * to make, with the body rebuilt from the fields the allowlist names so
 * nothing else rides along; throws for anything outside it.
 */
export function parseServerRequest(params: unknown): ServerRequest {
  const input = plainObject(params);
  if (!input) throw invalid("Expected an object");
  requireKeys(input, ["method", "path", "body"], "A server request");
  const { method, path, body } = input;
  if (typeof method !== "string") throw invalid("method is required");
  const upper = method.toUpperCase();
  if (!(SERVER_REQUEST_METHODS as readonly string[]).includes(upper)) {
    throw denied(`Method ${JSON.stringify(method)} is not allowed`);
  }
  if (typeof path !== "string" || path.length < 1 || path.length > SERVER_REQUEST_PATH_MAX_LENGTH) {
    throw invalid("path must be a non-empty string");
  }
  if (!path.startsWith("/") || path.startsWith("//") || /[\s#\\]/.test(path)) {
    throw denied("Path is outside the allowed routes");
  }
  if (body !== undefined && body !== null && !isExtensionPayloadWithinBudget(body)) {
    throw invalid("Request body exceeds the message budget");
  }
  const verb = upper as ServerRequestMethod;

  if (path.startsWith("/v1/ae/")) {
    if (verb === "PATCH") throw denied("PATCH is not allowed on the AE routes");
    const aePath = parseAePath(path);
    if (verb === "GET") {
      if (body !== undefined && body !== null) throw invalid("A GET carries no body");
      return { kind: "ae", method: verb, path: aePath, body: null };
    }
    const value = body === undefined || body === null ? {} : plainObject(body);
    if (!value) throw invalid("A POST body must be an object");
    return { kind: "ae", method: verb, path: aePath, body: { ...value } };
  }

  const eventsMatch = SESSION_EVENTS_ROUTE.exec(path);
  if (eventsMatch) {
    if (verb !== "POST") throw denied(`${verb} is not allowed on session events`);
    if (!validSessionId(eventsMatch[1])) throw invalid("Session id is malformed");
    return { kind: "user-message", method: verb, path, body: parseUserMessageBody(body) };
  }

  const sessionMatch = SESSION_ROUTE.exec(path);
  if (sessionMatch) {
    if (verb !== "PATCH") throw denied(`${verb} is not allowed on a session`);
    if (!validSessionId(sessionMatch[1])) throw invalid("Session id is malformed");
    return { kind: "labels", method: verb, path, body: parseLabelsBody(body) };
  }

  throw denied("Path is outside the allowed routes");
}

/** Make an allowlisted request over the host's authenticated fetch. */
export async function performServerRequest(
  request: ServerRequest,
  signal: AbortSignal,
): Promise<ServerResponse> {
  if (signal.aborted) throw new DOMException("Host operation cancelled", "AbortError");
  let response: Response;
  try {
    response = await authenticatedFetch(request.path, {
      method: request.method,
      signal,
      ...(request.body === null
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request.body),
          }),
    });
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw error;
    }
    throw new ExtensionHostServiceError("HostError", "Server request failed");
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ExtensionHostServiceError("HostError", "Server response could not be read");
  }
  // Two bytes per UTF-16 unit, the same accounting as the RPC budget; a body
  // over it is refused here rather than after the host serializes it.
  if (text.length * 2 > MAX_EXTENSION_MESSAGE_BYTES) {
    throw new ExtensionHostServiceError("ResponseTooLarge", "Server response exceeds the limit");
  }
  let body: unknown = null;
  if (text.length > 0) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new ExtensionHostServiceError("HostError", "Malformed server response");
      }
    } else {
      body = text;
    }
  }
  return { status: response.status, ok: response.ok, body };
}
