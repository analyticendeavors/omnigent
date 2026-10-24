// A model change the lead made with set_session_model (omnigent-ae): one row in the
// chat with the from and to, the reason, Undo and a link to the helper. The tool's
// result JSON is the contract; anything else falls back to the plain tool card.

import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { aeAgentRole, aeRoleName } from "@/lib/aeAgentRole";
import { AE_MODEL_FAMILY_BG } from "@/lib/aeAgentUsage";
import {
  type AeModelChange,
  type AeModelPoint,
  aeModelPointFamily,
  aeModelPointText,
  aeUndoModelChange,
} from "@/lib/aeModelChange";
import { Link } from "@/lib/routing";
import { cn } from "@/lib/utils";

function ModelText({ point }: { point: AeModelPoint }) {
  const family = aeModelPointFamily(point);
  return (
    <span className="inline-flex items-baseline gap-1 font-medium">
      {family && (
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 self-center rounded-full", AE_MODEL_FAMILY_BG[family])}
        />
      )}
      {aeModelPointText(point)}
    </span>
  );
}

function RoleChip({ role }: { role: string | null }) {
  const id = aeAgentRole({ labels: role ? { "ae.role": role } : {} });
  if (!id) return null;
  return (
    <>
      <span
        data-testid="ae-model-change-role"
        className="rounded bg-foreground/[0.07] px-1.5 text-[10px] font-medium uppercase tracking-wide"
      >
        {aeRoleName(id)}
      </span>{" "}
    </>
  );
}

/** The muted second line: the reason, then how the change was allowed. */
function whyLine(change: AeModelChange): string {
  const parts = [change.reason];
  if (change.approved === "reid") parts.push("approved by you");
  else if (change.counted && change.approved === "auto" && change.cap !== null) {
    parts.push(`raise ${change.raises} of ${change.cap} automatic`);
  }
  return parts.filter(Boolean).join(" · ");
}

/** One muted line for a change that did not happen. */
function skippedLine(change: AeModelChange): string {
  const who = change.isLead
    ? "the lead"
    : `the ${change.role ?? "helper"}${change.title ? ` "${change.title}"` : ""}`;
  const stay = aeModelPointText(change.from);
  if (change.status === "declined") return `Kept ${who} on ${stay} (you declined)`;
  if (change.status === "needs_approval") return `Waiting for you to approve a change for ${who}`;
  if (change.status === "unchanged") return `Not changed: ${who} already runs ${stay}`;
  return `Not changed: ${change.refusal ?? "the preset does not allow it"}`;
}

export function AeModelChangeRow({ change }: { change: AeModelChange }) {
  const [undo, setUndo] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  if (change.status !== "changed") {
    return (
      <p className="not-prose text-xs text-muted-foreground" data-testid="ae-model-change-note">
        {skippedLine(change)}
      </p>
    );
  }

  const raised = change.kind === "raise";
  const Arrow = raised ? ArrowUpIcon : ArrowDownIcon;
  const undoTo = change.undo;
  const runUndo = async () => {
    if (!undoTo) return;
    setUndo("busy");
    setError(null);
    try {
      await aeUndoModelChange(change.sessionId, undoTo);
      setUndo("done");
    } catch (err) {
      setUndo("idle");
      setError(err instanceof Error && err.message ? err.message : "Undo failed");
    }
  };

  return (
    <div
      className="not-prose flex w-full items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm"
      data-testid="ae-model-change"
    >
      <Arrow
        aria-hidden="true"
        data-testid="ae-model-change-arrow"
        data-direction={raised ? "up" : "down"}
        className={cn("mt-0.5 size-4 shrink-0", raised ? "text-amber-500" : "text-emerald-500")}
      />
      <div className="min-w-0 flex-1">
        <p data-testid="ae-model-change-text">
          {change.isLead ? (
            `Lead ${raised ? "raised itself" : "stepped down"} from `
          ) : (
            <>
              {raised ? "Raised" : "Lowered"} <RoleChip role={change.role} />
              {change.title && <>&ldquo;{change.title}&rdquo; </>}
              from{" "}
            </>
          )}
          <ModelText point={change.from} /> to <ModelText point={change.to} />
        </p>
        {whyLine(change) && (
          <p className="mt-0.5 text-xs text-muted-foreground" data-testid="ae-model-change-why">
            {whyLine(change)}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {undoTo && (
            <Button
              size="sm"
              variant="outline"
              disabled={undo !== "idle"}
              onClick={runUndo}
              componentId="ae.model_change.undo"
              data-testid="ae-model-change-undo"
            >
              {undo === "busy" ? "Undoing" : undo === "done" ? "Undone" : "Undo"}
            </Button>
          )}
          {!change.isLead && (
            <Button size="sm" variant="outline" asChild componentId="ae.model_change.open_helper">
              <Link to={`/c/${change.sessionId}`}>Open helper</Link>
            </Button>
          )}
          {error && (
            <span
              role="alert"
              className="text-xs text-destructive"
              data-testid="ae-model-change-error"
            >
              {error}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
