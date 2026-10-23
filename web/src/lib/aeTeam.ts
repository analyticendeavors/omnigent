import { fetchChildSessions } from "@/hooks/useChildSessions";
import { type AeSessionRoles, aeParseSessionRoles, aeTeamLabelText } from "./aeSessionRoles";
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
  /** Roles preset for this session; absent keeps the saved one, null clears it (your default). */
  roles?: AeSessionRoles | null;
}

export function readAeTeam(labels?: Record<string, string>): AeTeam {
  const automatic: AeTeam = { version: 1, mode: "auto", members: [] };
  const raw = labels?.[AE_TEAM_LABEL];
  if (!raw || raw.length > 16_384) return automatic;
  try {
    const value = JSON.parse(raw) as Partial<AeTeam>;
    if (value?.version !== 1) return automatic;
    // A label this client cannot read as a team (unknown mode, bad members) still
    // keeps a readable roles choice, so a writer never drops it.
    const roleOnly = { ...automatic, ...aeParsedRoles(aeParseSessionRoles(value.roles)) };
    if (!["auto", "solo", "team"].includes(value.mode ?? "")) return roleOnly;
    if (!Array.isArray(value.members) || value.members.length > AE_TEAM_LIMIT) return roleOnly;
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
      ...aeParsedRoles(aeParseSessionRoles(value.roles)),
    };
  } catch {
    return automatic;
  }
}

function aeParsedRoles(roles: AeSessionRoles | null) {
  return roles ? { roles } : {};
}

export function aeTeamMemberKey(member: AeTeamMember): string {
  return JSON.stringify([member.agentId, member.model]);
}

/** Save the chat's sessions and roles choice, provisioning idle children for new members.
 * The mode is derived: "team" when the draft lists sessions, else "auto" (the
 * preset's Helpers rule replaced Solo, 2026-10-23); a label still saved as Solo
 * keeps that mode until a writer sets its roles. Every other label field is kept.
 * Retry reuses children by their durable label, including a partially saved team.
 * No prompts are sent here. The lead sees the roster on its next message.
 */
export async function saveAeTeam(sessionId: string, input: AeTeam) {
  if (input.members.length > AE_TEAM_LIMIT) {
    throw new Error(`Choose up to ${AE_TEAM_LIMIT} sessions.`);
  }
  const parent = await getSessionSlim(sessionId);
  const saved = readAeTeam(parent.labels);
  const routing = parent.subagentRoutingOverride ?? null;
  // Every writer keeps the session's roles preset unless the draft sets it.
  const roles = input.roles === undefined ? saved.roles : input.roles;
  const keepSolo = input.roles === undefined && saved.mode === "solo";
  const draft: AeTeam = {
    ...input,
    mode: input.members.length ? "team" : keepSolo ? "solo" : "auto",
  };
  if (draft.mode !== "team") {
    return updateSession(sessionId, {
      // Restore only the override this picker owns; preserve later manual changes.
      ...(saved.mode === "team" && routing === "off"
        ? { subagentRoutingOverride: saved.routingBeforeTeam ?? null }
        : {}),
      labels: {
        [AE_TEAM_LABEL]: aeTeamLabelText(parent.labels, {
          mode: draft.mode,
          members: [],
          roles,
        }),
      },
    });
  }
  const routingBeforeTeam =
    saved.mode === "team" && routing === "off" ? (saved.routingBeforeTeam ?? null) : routing;
  // Manual model choices must not be replaced by the parent's spawn router.
  if (routing !== "off") await updateSession(sessionId, { subagentRoutingOverride: "off" });
  try {
    return await persistAeTeam(sessionId, { ...draft, routingBeforeTeam, roles }, parent.labels);
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

async function persistAeTeam(
  sessionId: string,
  draft: AeTeam,
  labels: Record<string, string> | undefined,
) {
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
      [AE_TEAM_LABEL]: aeTeamLabelText(labels, {
        mode: draft.mode,
        members,
        routingBeforeTeam: draft.routingBeforeTeam ?? null,
        roles: draft.roles,
      }),
    },
  });
}
