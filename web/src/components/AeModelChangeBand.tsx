// The model change band (omnigent-ae): a line above every chat for each model change the
// lead made with set_session_model, with Undo, a link to the helper and Dismiss. It reads
// `GET /v1/ae/sessions/{id}/model-changes`, so it shows in the terminal view too, where the
// chat transcript never renders.

import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { aeAgentRole, aeRoleName } from "@/lib/aeAgentRole";
import { AE_MODEL_FAMILY_BG } from "@/lib/aeAgentUsage";
import {
  type AeModelChangeItem,
  type AeModelPoint,
  aeChangeSignature,
  aeModelPointFamily,
  aeModelPointText,
  aeUndoModelChange,
  useAeModelChanges,
} from "@/lib/aeModelChange";
import { Link } from "@/lib/routing";
import { cn } from "@/lib/utils";
import { CHAT_COLUMN_WIDTH } from "@/pages/chatLayout";

const DISMISSED_KEY = "omnigent:ae-model-changes-dismissed";
const SHOWN = 2;

type Dismissed = Record<string, { sig: string; at: number }>;
const DAY_S = 86_400;

function readDismissed(): Dismissed {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "{}") as unknown;
    return typeof raw === "object" && raw !== null ? (raw as Dismissed) : {};
  } catch {
    return {};
  }
}

function writeDismissed(value: Dismissed) {
  // Entries older than a day can never match a listed change again.
  const cutoff = Date.now() / 1000 - DAY_S;
  const kept = Object.fromEntries(
    Object.entries(value).filter(([, v]) => typeof v?.at === "number" && v.at > cutoff),
  );
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(kept));
  } catch {
    // Private mode or blocked storage: the dismissal lasts until the page reloads.
  }
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function aeRelativeTime(at: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round(now / 1000 - at));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

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
      <span className="rounded bg-foreground/[0.07] px-1.5 text-[10px] font-medium uppercase tracking-wide">
        {aeRoleName(id)}
      </span>{" "}
    </>
  );
}

function BandLine({
  item,
  onDismiss,
}: {
  item: AeModelChangeItem;
  onDismiss: (item: AeModelChangeItem) => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { change } = item;
  const raised = change.kind === "raise";
  const Arrow = raised ? ArrowUpIcon : ArrowDownIcon;
  const undoTo = change.undo;

  const runUndo = async () => {
    if (!undoTo) return;
    setBusy(true);
    setError(null);
    try {
      await aeUndoModelChange(change.sessionId, undoTo);
      await queryClient.invalidateQueries({ queryKey: ["ae-model-changes"] });
      await queryClient.invalidateQueries({ queryKey: ["ae-session-usage", change.sessionId] });
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Undo failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex items-start gap-2 text-xs"
      data-testid="ae-model-change-line"
      data-session={change.sessionId}
    >
      <Arrow
        aria-hidden="true"
        data-testid="ae-model-change-arrow"
        data-direction={raised ? "up" : "down"}
        className={cn("mt-0.5 size-3.5 shrink-0", raised ? "text-amber-500" : "text-emerald-500")}
      />
      <div className="min-w-0 flex-1">
        <span data-testid="ae-model-change-text">
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
        </span>
        <span className="text-muted-foreground" data-testid="ae-model-change-why">
          {change.reason && ` · ${change.reason}`} &middot; {aeRelativeTime(item.at)}
        </span>
        <span className="ml-2 inline-flex flex-wrap items-center gap-x-2">
          {item.undone ? (
            <span className="text-muted-foreground" data-testid="ae-model-change-undone">
              Undone
            </span>
          ) : (
            undoTo && (
              <Button
                variant="link"
                size="xs"
                className="h-auto px-0 text-xs"
                disabled={busy}
                onClick={runUndo}
                componentId="ae.model_change.undo"
                data-testid="ae-model-change-undo"
              >
                {busy ? "Undoing" : "Undo"}
              </Button>
            )
          )}
          {!change.isLead && (
            <Button
              variant="link"
              size="xs"
              className="h-auto px-0 text-xs"
              asChild
              componentId="ae.model_change.open_helper"
            >
              <Link to={`/c/${change.sessionId}`}>Open helper</Link>
            </Button>
          )}
          <Button
            variant="link"
            size="xs"
            className="h-auto px-0 text-xs text-muted-foreground"
            onClick={() => onDismiss(item)}
            componentId="ae.model_change.dismiss"
            data-testid="ae-model-change-dismiss"
          >
            Dismiss
          </Button>
          {error && (
            <span role="alert" className="text-destructive" data-testid="ae-model-change-error">
              {error}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

export function AeModelChangeBand({ leadId }: { leadId: string | null }) {
  const { data } = useAeModelChanges(leadId);
  const [dismissed, setDismissed] = useState<Dismissed>(readDismissed);
  const [expanded, setExpanded] = useState(false);

  const items = (data?.items ?? []).filter(
    (item) => dismissed[item.change.sessionId]?.sig !== aeChangeSignature(item),
  );
  if (items.length === 0) return null;

  const dismiss = (item: AeModelChangeItem) => {
    const next = {
      ...readDismissed(),
      ...dismissed,
      [item.change.sessionId]: { sig: aeChangeSignature(item), at: item.at },
    };
    setDismissed(next);
    writeDismissed(next);
  };

  const shown = expanded ? items : items.slice(0, SHOWN);
  const hidden = items.length - shown.length;
  return (
    <div className={cn("mx-auto mb-2 w-full px-6", CHAT_COLUMN_WIDTH)}>
      <div
        className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2"
        data-testid="ae-model-change-band"
      >
        {shown.map((item) => (
          <BandLine key={`${item.change.sessionId}:${item.at}`} item={item} onDismiss={dismiss} />
        ))}
        {hidden > 0 && (
          <Button
            variant="link"
            size="xs"
            className="h-auto justify-start px-0 text-xs text-muted-foreground"
            onClick={() => setExpanded(true)}
            componentId="ae.model_change.show_more"
            data-testid="ae-model-change-more"
          >
            + {hidden} more change{hidden === 1 ? "" : "s"} &middot; Show
          </Button>
        )}
      </div>
    </div>
  );
}
