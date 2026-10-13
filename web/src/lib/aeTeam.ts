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
  mode: "auto" | "solo" | "team";
  members: AeTeamMember[];
  routingBeforeTeam?: "on" | "off" | null;
}

export function readAeTeam(labels?: Record<string, string>): AeTeam {
  const automatic: AeTeam = { version: 1, mode: "auto", members: [] };
  const raw = labels?.[AE_TEAM_LABEL];
  if (!raw || raw.length > 16_384) return automatic;
  try {
    const value = JSON.parse(raw) as Partial<AeTeam>;
    if (value?.version !== 1 || !["auto", "solo", "team"].includes(value.mode ?? ""))
      return automatic;
    if (!Array.isArray(value.members) || value.members.length > AE_TEAM_LIMIT) return automatic;
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
    return {
      version: 1,
      mode: value.mode as AeTeam["mode"],
      members,
      ...(value.routingBeforeTeam === "on" ||
      value.routingBeforeTeam === "off" ||
      value.routingBeforeTeam === null
        ? { routingBeforeTeam: value.routingBeforeTeam }
        : {}),
    };
  } catch {
    return automatic;
  }
}

export function aeTeamMemberKey(member: AeTeamMember): string {
  return JSON.stringify([member.agentId, member.model]);
}

/** Save a collaboration preference, provisioning idle children only for Team.
 * Retry reuses children by their durable label, including a partially saved team.
 * No prompts are sent here. The lead sees the roster on its next message.
 */
export async function saveAeTeam(sessionId: string, draft: AeTeam) {
  if (draft.mode === "team" && (!draft.members.length || draft.members.length > AE_TEAM_LIMIT)) {
    throw new Error(`Choose between 1 and ${AE_TEAM_LIMIT} collaborators.`);
  }
  const parent = await getSessionSlim(sessionId);
  const saved = readAeTeam(parent.labels);
  const routing = parent.subagentRoutingOverride ?? null;
  if (draft.mode !== "team") {
    return updateSession(sessionId, {
      // Restore only the override this picker owns; preserve later manual changes.
      ...(saved.mode === "team" && routing === "off"
        ? { subagentRoutingOverride: saved.routingBeforeTeam ?? null }
        : {}),
      labels: {
        [AE_TEAM_LABEL]: JSON.stringify({ version: 1, mode: draft.mode, members: [] }),
      },
    });
  }
  const routingBeforeTeam =
    saved.mode === "team" && routing === "off" ? (saved.routingBeforeTeam ?? null) : routing;
  // Manual model choices must not be replaced by the parent's spawn router.
  if (routing !== "off") await updateSession(sessionId, { subagentRoutingOverride: "off" });
  try {
    return await persistAeTeam(sessionId, { ...draft, routingBeforeTeam });
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
    labels: {
      [AE_TEAM_LABEL]: JSON.stringify({
        version: 1,
        mode: draft.mode,
        members,
        routingBeforeTeam: draft.routingBeforeTeam,
      }),
    },
  });
}
