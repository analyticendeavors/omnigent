import { fetchChildSessions } from "@/hooks/useChildSessions";
import { createSession, getSessionSlim, updateSession } from "./sessionsApi";

export const AE_TEAM_LABEL = "ae.team";
export const AE_TEAM_MEMBER_LABEL = "ae.team.member";
export const AE_TEAM_LIMIT = 6;

export interface AeTeamMember {
  agentId: string;
  agentName: string;
  displayName: string;
  model: string | null;
  sessionId?: string;
}

export interface AeTeam {
  version: 1;
  mode: "solo" | "team";
  members: AeTeamMember[];
}

export function readAeTeam(labels?: Record<string, string>): AeTeam {
  const solo: AeTeam = { version: 1, mode: "solo", members: [] };
  const raw = labels?.[AE_TEAM_LABEL];
  if (!raw || raw.length > 16_384) return solo;
  try {
    const value = JSON.parse(raw) as Partial<AeTeam>;
    if (value?.version !== 1 || !["solo", "team"].includes(value.mode ?? "")) return solo;
    if (!Array.isArray(value.members) || value.members.length > AE_TEAM_LIMIT) return solo;
    const members = value.members.filter(
      (m): m is AeTeamMember =>
        !!m &&
        typeof m.agentId === "string" &&
        !!m.agentId &&
        typeof m.agentName === "string" &&
        typeof m.displayName === "string" &&
        (m.model === null || typeof m.model === "string") &&
        (m.sessionId === undefined || typeof m.sessionId === "string"),
    );
    return { version: 1, mode: value.mode as AeTeam["mode"], members };
  } catch {
    return solo;
  }
}

export function aeTeamMemberKey(member: AeTeamMember): string {
  return JSON.stringify([member.agentId, member.model]);
}

/** Provision idle children first; publish the roster only when all are ready.
 * Retry reuses children by their durable label, including a partially saved team.
 * No prompts are sent here. The lead sees the roster on its next message.
 */
export async function saveAeTeam(sessionId: string, draft: AeTeam) {
  if (draft.mode === "team" && (!draft.members.length || draft.members.length > AE_TEAM_LIMIT)) {
    throw new Error(`Choose between 1 and ${AE_TEAM_LIMIT} collaborators.`);
  }
  if (draft.mode === "solo") return persistAeTeam(sessionId, draft);
  const parent = await getSessionSlim(sessionId);
  const routing = parent.subagentRoutingOverride ?? null;
  // Manual model choices must not be replaced by the parent's spawn router.
  if (routing !== "off") await updateSession(sessionId, { subagentRoutingOverride: "off" });
  try {
    return await persistAeTeam(sessionId, draft);
  } catch (error) {
    if (routing !== "off") {
      try {
        await updateSession(sessionId, { subagentRoutingOverride: routing });
      } catch {
        throw new Error(
          "Could not save the team or restore automatic routing. Automatic collaborator routing remains off; reopen the picker to retry.",
        );
      }
    }
    throw error;
  }
}

async function persistAeTeam(sessionId: string, draft: AeTeam) {
  const members: AeTeamMember[] = [];
  if (draft.mode === "team") {
    const children = await fetchChildSessions(sessionId);
    // Sequential creation keeps retries bounded and avoids launching a burst of runners.
    /* oxlint-disable no-await-in-loop */
    for (const member of draft.members) {
      const key = aeTeamMemberKey(member);
      const existing = children.find((c) => c.labels?.[AE_TEAM_MEMBER_LABEL] === key);
      if (existing) {
        members.push({ ...member, sessionId: existing.id });
        continue;
      }
      const child = await createSession(member.agentId, [], {
        parentSessionId: sessionId,
        subAgentName: null,
        title:
          `ui:${member.agentName.slice(0, 60)}:${member.displayName} · ${member.model ?? "default"}`.slice(
            0,
            200,
          ),
        ...(member.model ? { modelOverride: member.model } : {}),
        labels: { [AE_TEAM_MEMBER_LABEL]: key },
      });
      members.push({ ...member, sessionId: child.id });
    }
    /* oxlint-enable no-await-in-loop */
  }
  return updateSession(sessionId, {
    ...(draft.mode === "team" ? { subagentRoutingOverride: "off" as const } : {}),
    labels: { [AE_TEAM_LABEL]: JSON.stringify({ version: 1, mode: draft.mode, members }) },
  });
}
