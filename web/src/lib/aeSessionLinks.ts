// A chat link to another OmniGent session (`/c/<32 hex id>`) switches to that
// session inside the app instead of opening a browser or a file. Shared by the
// markdown file-link pass (so the path is never read as a file) and the link
// renderer (so the click routes through the router).

import { stripBasePath } from "./basePath";

const SESSION_PATH = /^\/c\/([0-9a-f]{32})\/?$/i;
const PUBLIC_HOSTS = new Set(["omnigent.go-ae.org"]);
// A same-origin relative link: one leading slash, never `//host` or `/\host`.
const RELATIVE_LINK = /^\/(?![/\\])/;
// Parses a relative link; any result on another origin is rejected below.
const RELATIVE_BASE = "http://relative.invalid";

/**
 * True for a `/c/<id>` path, with or without a query or hash: the file pass
 * leaves it alone, so `/c/<id>#L12` never reads as a file citation.
 */
export function isSessionPath(href: string): boolean {
  const path = href.split(/[?#]/, 1)[0];
  return SESSION_PATH.test(stripBasePath(path));
}

function isKnownPublicHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return PUBLIC_HOSTS.has(host) || host.endsWith(".ts.net");
}

/**
 * The in-app route (`/c/<id>`) for a link to a session on this server, or null
 * for anything else. A relative link counts; an absolute one only when its host
 * is this app's origin, a `*.ts.net` host or the public go-ae.org host.
 *
 * The query and hash are kept only for this app's own origin. A `*.ts.net` host
 * matches any tailnet, not just this server's, so a link from a foreign host is
 * trusted for its session id and nothing else: its query and hash could carry
 * state the app would act on as if it were its own.
 */
export function sessionLinkRoute(href: string): string | null {
  const relative = RELATIVE_LINK.test(href);
  let url: URL;
  try {
    url = relative ? new URL(href, RELATIVE_BASE) : new URL(href);
  } catch {
    return null;
  }
  // Tabs and newlines inside `/\t/host` are stripped by URL parsing and can turn
  // a relative-looking link into another host.
  if (relative && url.origin !== RELATIVE_BASE) return null;
  const own = relative || (typeof window !== "undefined" && url.origin === window.location.origin);
  if (!relative) {
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!own && !isKnownPublicHost(url)) return null;
  }
  // Only this app's own paths sit under its deployment base path.
  const match = SESSION_PATH.exec(own ? stripBasePath(url.pathname) : url.pathname);
  if (!match) return null;
  const route = `/c/${match[1].toLowerCase()}`;
  return own ? `${route}${url.search}${url.hash}` : route;
}
