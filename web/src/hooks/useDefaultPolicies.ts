import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { refreshAeSlotLimit } from "@/lib/aeSlotLimit";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";

/** A server-wide default policy returned by the admin CRUD API. */
export interface DefaultPolicy {
  id: string | null;
  object: "default_policy";
  /** Config-file policies have ``source: "config"`` and are read-only. */
  source?: "config";
  name: string;
  type: string;
  handler: string;
  factory_params?: Record<string, unknown> | null;
  enabled: boolean;
  created_at: number | null;
  updated_at: number | null;
  created_by: string | null;
}

// ── Query helpers ────────────────────────────────────────────────────────────

const QUERY_KEY = ["default-policies"];

async function fetchDefaultPolicies(): Promise<DefaultPolicy[]> {
  const res = await authenticatedFetch("/v1/policies");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as { object: string; data: DefaultPolicy[] };
  return body.data;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/** Fetch all server-wide default policies. */
export function useDefaultPolicies() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchDefaultPolicies,
    staleTime: 5_000,
  });
}

/** POST /v1/policies — create a new default policy. */
export function useAddDefaultPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      name: string;
      type: "python" | "url";
      handler: string;
      factory_params?: Record<string, unknown> | null;
    }) => {
      const res = await authenticatedFetch("/v1/policies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw await apiErrorFromResponse(res);
      return (await res.json()) as DefaultPolicy;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      void refreshAeSlotLimit(queryClient);
    },
  });
}

/** PATCH /v1/policies/{id}: toggle enabled state, or replace the factory params. */
export function useUpdateDefaultPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      policyId,
      ...fields
    }: {
      policyId: string;
      enabled?: boolean;
      factory_params?: Record<string, unknown> | null;
    }) => {
      const res = await authenticatedFetch(`/v1/policies/${encodeURIComponent(policyId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      if (!res.ok) throw await apiErrorFromResponse(res);
      return (await res.json()) as DefaultPolicy;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      void refreshAeSlotLimit(queryClient);
    },
  });
}

/** DELETE /v1/policies/{id} — remove a default policy. */
export function useDeleteDefaultPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (policyId: string) => {
      const res = await authenticatedFetch(`/v1/policies/${encodeURIComponent(policyId)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw await apiErrorFromResponse(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      void refreshAeSlotLimit(queryClient);
    },
  });
}
