// Settings > Roles' sync with the server (omnigent-ae, 2026-10-23): `GET
// /v1/ae/roles` reads the user's presets and `PUT /v1/ae/roles` saves the whole
// list on top of the revision it was read at. A stale revision answers 409 with
// the current state, which replaces the cached one; the caller tells the user.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { type AeRolesDoc, type AeRolesState, aeParseRolesState, aeRolesDoc } from "@/lib/aeRoles";
import { authenticatedFetch } from "@/lib/identity";

export const AE_ROLES_QUERY_KEY = ["ae", "roles"] as const;

/** The saved presets; throws when the route cannot answer. */
export async function fetchAeRoles(): Promise<AeRolesState> {
  const res = await authenticatedFetch("/v1/ae/roles", { method: "GET" });
  if (!res.ok) throw new Error(`GET /v1/ae/roles answered ${res.status}`);
  const parsed = aeParseRolesState(await res.json());
  if (!parsed) throw new Error("GET /v1/ae/roles answered without presets");
  return parsed;
}

export type AeRolesPutResult =
  { ok: true; saved: AeRolesState } | { ok: false; current: AeRolesState };

/**
 * Save `doc` on top of its revision. A stale revision comes back as the
 * server's current state (`ok: false`); any other failure throws with the
 * status and the server's message.
 */
export async function putAeRoles(doc: AeRolesDoc): Promise<AeRolesPutResult> {
  const res = await authenticatedFetch("/v1/ae/roles", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(aeRolesDoc(doc)),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // No JSON body; the status line is all there is.
  }
  const error = (body as { error?: { message?: unknown } } | null)?.error;
  if (res.status === 409) {
    const current = aeParseRolesState(error) ?? aeParseRolesState(body);
    if (current) return { ok: false, current };
  }
  if (!res.ok) {
    const detail = (body as { detail?: unknown } | null)?.detail;
    const first = Array.isArray(detail)
      ? (detail[0] as { msg?: unknown } | undefined)?.msg
      : detail;
    const reason = typeof error?.message === "string" ? error.message : first;
    const message = typeof reason === "string" && reason ? `: ${reason}` : "";
    throw new Error(`PUT /v1/ae/roles answered ${res.status}${message}`);
  }
  const saved = aeParseRolesState(body);
  if (!saved) throw new Error("PUT /v1/ae/roles answered without presets");
  return { ok: true, saved };
}

export function useAeRoles() {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: AE_ROLES_QUERY_KEY,
    // A read that raced a save can answer an older revision; the saved one stands.
    queryFn: async () => {
      const fetched = await fetchAeRoles();
      const shown = queryClient.getQueryData<AeRolesState>(AE_ROLES_QUERY_KEY);
      return shown && shown.revision > fetched.revision ? shown : fetched;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: "always",
    retry: false,
  });
}

/**
 * Save a whole new doc and put the answer in the cache: the saved state, or on
 * a conflict the server's current one. Resolves to the put result.
 */
export function useAeRolesSave(): (doc: AeRolesDoc) => Promise<AeRolesPutResult> {
  const queryClient = useQueryClient();
  return useCallback(
    async (doc: AeRolesDoc) => {
      const result = await putAeRoles(doc);
      queryClient.setQueryData(AE_ROLES_QUERY_KEY, result.ok ? result.saved : result.current);
      return result;
    },
    [queryClient],
  );
}
