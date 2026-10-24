// Switching the lead model from the composer (omnigent-ae, 2026-10-24): the
// pill, Alt 1 to 9 and the "Who works on this?" dialog. The open chat's model
// and effort go through the chat store's setModel and setEffort so the picker
// updates at once; any other session is PATCHed. Kept apart from aeLeadModel.ts
// because the chat store imports the START ON path, which uses that file.

import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  type AeLeadSwitch,
  type AeLeadWriter,
  aeAnnounceLead,
  aeFixedLead,
  aeLeadModelOptions,
  aePatchLeadWriter,
  aeSwitchLead,
} from "@/lib/aeLeadModel";
import type { AeRolePreset } from "@/lib/aeRoles";
import { getSessionSlim } from "@/lib/sessionsApi";
import type { Session } from "@/lib/types";
import { useChatStore } from "@/store/chatStore";

/**
 * Writes through the chat store when `sessionId` is the open chat, else PATCHes
 * it. Resolves to the value `sessionId`'s own row holds after the write, never
 * the open chat's (the user may have moved to another chat while it ran).
 */
export function aeChatLeadWriter(queryClient: QueryClient, sessionId: string): AeLeadWriter {
  const patch = aePatchLeadWriter(sessionId, (session) =>
    queryClient.setQueryData(["session", sessionId], session),
  );
  return async (field, value) => {
    const chat = useChatStore.getState();
    if (chat.conversationId !== sessionId) return patch(field, value);
    if (field === "model") {
      // Like the model picker: a native Claude or Codex chip waits for the harness to confirm.
      const harness = queryClient.getQueryData<Session>(["session", sessionId])?.harness;
      await chat.setModel(value, {
        expectConfirmation: harness === "claude-native" || harness === "codex-native",
      });
    } else {
      await chat.setEffort(value);
    }
    const row = await getSessionSlim(sessionId);
    return (field === "model" ? row.modelOverride : row.reasoningEffort) ?? null;
  };
}

/**
 * After `preset` was saved for `sessionId`: when its lead is fixed, switch the
 * session's model and effort to it. Resolves to the result without a toast, so
 * the caller can order it after its own label write; never throws.
 */
export async function aeSwitchPresetLead(
  queryClient: QueryClient,
  sessionId: string,
  hostId: string | null | undefined,
  preset: Pick<AeRolePreset, "roles" | "title"> | null | undefined,
): Promise<AeLeadSwitch | { kind: "failed"; reason: string }> {
  const lead = aeFixedLead(preset);
  if (!lead) return { kind: "none" };
  const chat = useChatStore.getState();
  const rows = chat.conversationId === sessionId ? chat.codexModelOptions : [];
  const harness = queryClient.getQueryData<Session>(["session", sessionId])?.harness;
  try {
    return await aeSwitchLead(
      sessionId,
      lead,
      aeLeadModelOptions(queryClient, hostId, rows, harness),
      aeChatLeadWriter(queryClient, sessionId),
    );
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The toast for {@link aeSwitchPresetLead}'s result; nothing for a preset that left the model alone. */
export function aeAnnouncePresetLead(
  queryClient: QueryClient,
  sessionId: string,
  presetTitle: string,
  result: Awaited<ReturnType<typeof aeSwitchPresetLead>>,
) {
  if (result.kind === "failed") {
    toast(
      `Roles preset: ${presetTitle}. Could not switch the lead model: ${result.reason}. Use the model picker.`,
    );
    return;
  }
  aeAnnounceLead(sessionId, presetTitle, result, aeChatLeadWriter(queryClient, sessionId));
}
