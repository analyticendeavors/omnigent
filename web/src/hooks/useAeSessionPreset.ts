// A session's roles preset in the composer (omnigent-ae, 2026-10-23): what
// the pill shows, picking from its menu, Alt 1 to 9, and queuing a START ON
// line from the first message. The label read and write live in
// lib/aeSessionRoles.ts; this file binds them to the session and roles queries.

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { showToast } from "@/components/ui/toast";
import { useAeRoles } from "@/hooks/useAeRoles";
import { childSessionsQueryKey } from "@/hooks/useChildSessions";
import { useSession } from "@/hooks/useSession";
import {
  AE_SUPERSEDED,
  aeLatestWins,
  aePresetDigit,
  aeRecordPresetSwitch,
  aeRememberPreset,
  aeResolveSessionPreset,
  aeRolesForPick,
  readAeSessionRoles,
  saveAeSessionRoles,
} from "@/lib/aeSessionRoles";
import { aeFixedLead } from "@/lib/aeLeadModel";
import { aeAnnouncePresetLead, aeSwitchPresetLead } from "@/lib/aeLeadModelChat";
import { aeStartOnLine } from "@/lib/aeStartOn";
import { readAeTeam } from "@/lib/aeTeam";
import {
  aeIsLegacySolo,
  aeMigratedSessionRoles,
  aeSaveTeamMember,
  aeSessionsLocked,
} from "@/lib/aeTeamPresets";
import type { AeTeamMember } from "@/lib/aeTeam";
import { aeDropStartOn, aeQueueStartOn } from "@/lib/aeStartOnApply";
import { aeChordFromEvent, aeSameChord, readAeSuggestionKeys } from "@/lib/aeSuggestionKeys";
import { isTempConvId } from "@/lib/tempConversationId";
import type { NativeModelOption } from "@/lib/types";
import { useChatStore } from "@/store/chatStore";

export function useAeSessionPreset(sessionId: string | null | undefined) {
  const queryClient = useQueryClient();
  const { session } = useSession(sessionId);
  const rolesQuery = useAeRoles();
  const state = rolesQuery.data;
  const labels = session?.labels;
  // Session changes still saving: the dialog reads the label, so it waits for them.
  const [pending, setPending] = useState(0);
  // A label saved as Solo before presets had a Helpers rule reads the new way.
  const roles = useMemo(() => {
    const stored = readAeSessionRoles(labels);
    return state ? aeMigratedSessionRoles(labels, stored, state) : stored;
  }, [labels, state]);
  const team = useMemo(() => readAeTeam(labels), [labels]);
  const choice = useMemo(
    () => (state ? aeResolveSessionPreset(roles, state) : null),
    [roles, state],
  );
  const choiceLocked = aeSessionsLocked(choice, aeIsLegacySolo(labels));
  /**
   * Put the session on `id` (a preset id or "lead-picks"); resolves true once
   * saved. Picks for one session run one at a time and the latest wins: a pick
   * still waiting when a later one arrives never lands (resolves false). A
   * preset with a fixed lead also switches the model, inside the same turn of
   * the line, then says so in a toast with Undo.
   */
  const hostId = session?.hostId;
  const pick = useCallback(
    async (id: string): Promise<boolean> => {
      if (!sessionId || !state) return false;
      const preset = state.presets.find((p) => p.id === id);
      try {
        const done = await aeLatestWins(sessionId, async () => {
          const saved = await saveAeSessionRoles(
            sessionId,
            aeRolesForPick(id, state.default_preset),
          );
          queryClient.setQueryData(["session", sessionId], saved);
          return aeSwitchPresetLead(queryClient, sessionId, hostId, preset);
        });
        if (done === AE_SUPERSEDED) return false;
        aeRememberPreset(id);
        aeRecordPresetSwitch(sessionId, id);
        if (preset) aeAnnouncePresetLead(queryClient, sessionId, preset.title, done);
        return true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        showToast(`Could not switch the roles preset: ${reason}. Try again.`);
        return false;
      }
    },
    [queryClient, sessionId, state, hostId],
  );
  /**
   * Add (`on`) or remove one session for this chat; resolves true once saved.
   * Queued behind any pending pick for the session, never skipped.
   */
  const setMember = useCallback(
    async (member: AeTeamMember, on: boolean): Promise<boolean> => {
      if (!sessionId) return false;
      setPending((n) => n + 1);
      try {
        const saved = await aeLatestWins(sessionId, () => aeSaveTeamMember(sessionId, member, on), {
          queue: true,
        });
        if (saved === AE_SUPERSEDED) return false;
        queryClient.setQueryData(["session", sessionId], saved);
        void queryClient.invalidateQueries({ queryKey: childSessionsQueryKey(sessionId) });
        return true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        showToast(`Could not change this chat's sessions: ${reason}`);
        return false;
      } finally {
        setPending((n) => n - 1);
      }
    },
    [queryClient, sessionId],
  );
  return {
    state,
    roles,
    choice,
    pick,
    team,
    setMember,
    /** The sessions list is greyed out (Helpers "own", or a label still saved as Solo). */
    locked: choiceLocked,
    /** A session add or remove is still saving. */
    pending: pending > 0,
    /** The roles query, for a retry when it failed. */
    rolesQuery,
  };
}

/**
 * Alt 1 to 9 in the composer: switch to the preset at that list position.
 * Returns true when it handled the key. The user's suggestion chord wins, and
 * a position with no preset leaves the key alone (Option+digit types on a Mac).
 */
export function useAePresetHotkey(
  sessionId: string | null | undefined,
  current: Pick<ReturnType<typeof useAeSessionPreset>, "state" | "choice" | "pick">,
) {
  const { state, choice, pick } = current;
  return useCallback(
    (event: KeyboardEvent): boolean => {
      if (event.isComposing) return false;
      const index = aePresetDigit(event);
      if (index === null || !state || !sessionId) return false;
      const chord = aeChordFromEvent(event);
      const keys = readAeSuggestionKeys();
      if (chord && (aeSameChord(chord, keys.next) || aeSameChord(chord, keys.previous))) {
        return false;
      }
      const preset = state.presets[index];
      if (!preset) return false;
      event.preventDefault();
      if (choice?.kind === "preset" && choice.preset.id === preset.id && !choice.edited) {
        showToast(`Already on ${preset.title}.`, { duration: 2000 });
        return true;
      }
      // A fixed-lead preset gets the "Lead switched" toast from the pick instead.
      void pick(preset.id).then(
        (ok) =>
          ok &&
          !aeFixedLead(preset) &&
          showToast(`Roles preset: ${preset.title}`, { duration: 2000 }),
      );
      return true;
    },
    [choice, pick, sessionId, state],
  );
}

/**
 * True only when the session is known to have no message: a new session (the
 * landing page, or a temp id) or one whose history has finished loading and is
 * empty. An existing session whose items have not loaded yet never counts.
 */
function isFirstMessage(conversationId: string | null, isNewSession: boolean): boolean {
  if (isNewSession || conversationId === null || isTempConvId(conversationId)) return true;
  const chat = useChatStore.getState();
  if (chat.conversationId !== conversationId) return false;
  const loaded =
    !chat.loadingConversation &&
    chat.abortController !== null &&
    chat.conversationLoadError === null;
  return (
    loaded &&
    !chat.hasMoreHistory &&
    chat.pendingUserMessages.length === 0 &&
    chat.queuedMessages.length === 0 &&
    !chat.blocks.some((block) => block.type === "user_message")
  );
}

/**
 * Called with the text about to be sent (by the composer, and by the New Chat
 * dialog for a first prompt, with `isNewSession` and the real session id). On a
 * session's first message, a START ON line is queued for the send to apply
 * (which checks Settings > Roles "Apply START ON lines" and the presets). Any
 * other message drops a plan still queued. Not a hook: the composer's tests
 * render it without a query client.
 */
export function aeNoteStartOn(
  text: string,
  conversationId: string | null,
  models: readonly NativeModelOption[],
  opts: { isNewSession?: boolean } = {},
) {
  if (!aeStartOnLine(text) || !isFirstMessage(conversationId, opts.isNewSession === true)) {
    aeDropStartOn();
    return;
  }
  aeQueueStartOn(conversationId, { text, models });
}
