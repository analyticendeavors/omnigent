// Settings > Roles > Preset insights (omnigent-ae, 2026-10-24, preset insights
// PR 3): the scheduled preset review's status (`GET /v1/ae/preset-review`), the
// signed-in user's own suggestions (`GET /v1/ae/preset-suggestions`) and the
// actions on them (`POST .../{id}/apply|undo|dismiss`, `POST
// /v1/ae/preset-review/run`). Apply and Undo answer the saved roles, which go
// into the roles cache so the list above shows the change at once.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { aeParseRolesState } from "@/lib/aeRoles";
import { authenticatedFetch } from "@/lib/identity";
import { AE_ROLES_QUERY_KEY } from "./useAeRoles";

export const AE_PRESET_REVIEW_QUERY_KEY = ["ae", "preset-review"] as const;
export const AE_PRESET_SUGGESTIONS_QUERY_KEY = ["ae", "preset-suggestions"] as const;

export interface AePresetReviewStatus {
  enabled: boolean;
  scope: "all" | "own";
  task: { id: string; state: string; next_run_at: string | null } | null;
  last_review: string | null;
  next_review: string | null;
  reviewer: { model: string; effort: string; preset_title: string | null };
  open: number;
}

export interface AePresetSuggestion {
  id: string;
  review_id: string;
  kind: "own" | "starter" | "no_change";
  preset_title?: string | null;
  title: string;
  why: string;
  saving?: string | null;
  status:
    | "open"
    | "applying"
    | "applied"
    | "undoing"
    | "dismissed"
    | "issue_opening"
    | "issue_opened"
    | "undone";
  can_apply: boolean;
  can_undo: boolean;
  /** One line per change, rendered by the server ("Builder: A high to B medium"). */
  changes_text?: string;
}

export type AePresetReviewAction = "run" | "apply" | "undo" | "dismiss";
export type AePresetReviewResult = { ok: true } | { ok: false; message: string };

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } } | null;
    if (typeof body?.error?.message === "string" && body.error.message) return body.error.message;
  } catch {
    // No JSON body; the status line is all there is.
  }
  return `The server answered ${res.status}.`;
}

export function useAePresetReviewStatus(enabled: boolean) {
  return useQuery({
    queryKey: AE_PRESET_REVIEW_QUERY_KEY,
    queryFn: async (): Promise<AePresetReviewStatus> => {
      const res = await authenticatedFetch("/v1/ae/preset-review", { method: "GET" });
      if (!res.ok) throw new Error(`GET /v1/ae/preset-review answered ${res.status}`);
      return (await res.json()) as AePresetReviewStatus;
    },
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: "always",
    retry: false,
  });
}

/** The user's own suggestions, newest first. */
export function useAePresetSuggestions(enabled: boolean) {
  return useQuery({
    queryKey: AE_PRESET_SUGGESTIONS_QUERY_KEY,
    queryFn: async (): Promise<AePresetSuggestion[]> => {
      const res = await authenticatedFetch("/v1/ae/preset-suggestions", { method: "GET" });
      if (!res.ok) throw new Error(`GET /v1/ae/preset-suggestions answered ${res.status}`);
      const body = (await res.json()) as { suggestions?: AePresetSuggestion[] };
      return body.suggestions ?? [];
    },
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: "always",
    retry: false,
  });
}

/** `run(null)` starts the review; the others act on the suggestion `id`. */
export function useAePresetReviewActions() {
  const queryClient = useQueryClient();
  const act = useCallback(
    async (action: AePresetReviewAction, id: string | null): Promise<AePresetReviewResult> => {
      const path =
        action === "run"
          ? "/v1/ae/preset-review/run"
          : `/v1/ae/preset-suggestions/${encodeURIComponent(id ?? "")}/${action}`;
      let res: Response;
      try {
        res = await authenticatedFetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      } catch (error) {
        // The request may have landed: read the roles again before trusting the list.
        void queryClient.invalidateQueries({ queryKey: AE_ROLES_QUERY_KEY });
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      if (!res.ok) {
        // A refusal still means the lists changed under us (the preset moved on, another
        // device saved): read the suggestions and the roles again.
        void queryClient.invalidateQueries({ queryKey: AE_PRESET_SUGGESTIONS_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: AE_ROLES_QUERY_KEY });
        return { ok: false, message: await errorMessage(res) };
      }
      const body = (await res.json().catch(() => null)) as { roles?: unknown } | null;
      const roles = aeParseRolesState(body?.roles);
      if (roles) queryClient.setQueryData(AE_ROLES_QUERY_KEY, roles);
      else if (action === "apply" || action === "undo") {
        // The preset changed but the answer did not carry the roles: fetch them.
        void queryClient.invalidateQueries({ queryKey: AE_ROLES_QUERY_KEY });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: AE_PRESET_SUGGESTIONS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: AE_PRESET_REVIEW_QUERY_KEY }),
      ]);
      return { ok: true };
    },
    [queryClient],
  );
  return useMemo(
    () => ({
      run: () => act("run", null),
      apply: (id: string) => act("apply", id),
      undo: (id: string) => act("undo", id),
      dismiss: (id: string) => act("dismiss", id),
    }),
    [act],
  );
}
