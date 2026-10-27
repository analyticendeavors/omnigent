// Titles for chat links that show a bare session URL. A link to another session
// (`/c/<id>`) whose text is the URL itself reads as that session's title; the
// lookup goes through the sessions API once per id and is cached for the page.

import { useEffect, useState } from "react";
import { getSessionSlim } from "./sessionsApi";

const SESSION_ID = /\/c\/([0-9a-f]{32})/i;

const titles = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

/** `session <first 8 chars>`: the label while a lookup runs or after it fails. */
export function sessionLinkFallbackLabel(route: string): string {
  const id = SESSION_ID.exec(route)?.[1] ?? route;
  return `session ${id.slice(0, 8)}`;
}

function sessionIdOf(route: string): string | null {
  return SESSION_ID.exec(route)?.[1]?.toLowerCase() ?? null;
}

async function loadTitle(id: string): Promise<string> {
  const cached = titles.get(id);
  if (cached !== undefined) return cached;
  let inflight = pending.get(id);
  if (inflight === undefined) {
    inflight = getSessionSlim(id)
      .then((session) => {
        const title = session.title?.trim() ?? "";
        if (title !== "") titles.set(id, title);
        return title;
      })
      .catch(() => "")
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
  const [title, setTitle] = useState<string | null>(() => (id ? (titles.get(id) ?? null) : null));
  useEffect(() => {
    if (!enabled || id === null) return;
    let live = true;
    void loadTitle(id).then((found) => {
      if (live && found !== "") setTitle(found);
    });
    return () => {
      live = false;
    };
  }, [enabled, id]);
  if (!enabled || id === null) return null;
  return title ?? sessionLinkFallbackLabel(route);
}

/** Test hook: forget every cached title. */
export function resetSessionTitleCache(): void {
  titles.clear();
  pending.clear();
}
