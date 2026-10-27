// Titles for chat links that show a bare session URL. A link to another session
// (`/c/<id>`) whose text is the URL itself reads as that session's title; the
// lookup goes through the sessions API once per id and is cached for the page.

import { useEffect, useState } from "react";
import { getSessionSlim } from "./sessionsApi";

const SESSION_ID = /\/c\/([0-9a-f]{32})/i;

// A title is trusted for a few minutes (a rename shows up on the next mount after
// that); a failed lookup is not retried for 30 seconds, so a reply full of links
// to an unreadable session asks once.
const TITLE_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;

const titles = new Map<string, { title: string; at: number }>();
const failures = new Map<string, number>();
const pending = new Map<string, Promise<string>>();

/** `session <first 8 chars>`: the label while a lookup runs or after it fails. */
export function sessionLinkFallbackLabel(route: string): string {
  const id = SESSION_ID.exec(route)?.[1] ?? route;
  return `session ${id.slice(0, 8)}`;
}

function sessionIdOf(route: string): string | null {
  return SESSION_ID.exec(route)?.[1]?.toLowerCase() ?? null;
}

function cachedTitle(id: string): string | null {
  const hit = titles.get(id);
  return hit !== undefined && Date.now() - hit.at < TITLE_TTL_MS ? hit.title : null;
}

async function loadTitle(id: string): Promise<string> {
  const cached = cachedTitle(id);
  if (cached !== null) return cached;
  const failedAt = failures.get(id);
  if (failedAt !== undefined && Date.now() - failedAt < FAILURE_TTL_MS) return "";
  let inflight = pending.get(id);
  if (inflight === undefined) {
    inflight = getSessionSlim(id)
      .then((session) => {
        const title = session.title?.trim() ?? "";
        if (title === "") failures.set(id, Date.now());
        else titles.set(id, { title, at: Date.now() });
        return title;
      })
      .catch(() => {
        failures.set(id, Date.now());
        return "";
      })
      .finally(() => pending.delete(id));
    pending.set(id, inflight);
  }
  return inflight;
}

/**
 * The title of the session a `/c/<id>` route points at, or its short
 * `session <id>` label until the lookup lands (and when it fails or the
 * session has no title). `enabled` false skips the lookup and returns null.
 */
export function useSessionLinkTitle(route: string, enabled: boolean): string | null {
  const id = sessionIdOf(route);
  // Keyed by id, so a link that is reused for another session never shows the
  // first session's title.
  const [found, setFound] = useState<{ id: string; title: string } | null>(null);
  useEffect(() => {
    if (!enabled || id === null) return;
    let live = true;
    void loadTitle(id).then((title) => {
      if (live && title !== "") setFound({ id, title });
    });
    return () => {
      live = false;
    };
  }, [enabled, id]);
  if (!enabled || id === null) return null;
  const own = found !== null && found.id === id ? found.title : null;
  return own ?? cachedTitle(id) ?? sessionLinkFallbackLabel(route);
}

/** Test hook: forget every cached title. */
export function resetSessionTitleCache(): void {
  titles.clear();
  failures.clear();
  pending.clear();
}
