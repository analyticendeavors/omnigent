// A pending approval that leads with a plain-English line and sizes by risk (2026-11-27).
// The owner: the raw tool JSON hid what the agent wanted, and a read-only `git status` took
// as much room as a file deletion. Read-only is one row, a normal write is the standard
// card with the code folded, and a destructive command gets a red border, a tag naming the
// danger, the code open, and no remember option. The approve and reject handlers and the
// write card's button row come from ApprovalCard; nothing here decides a verdict.

import { useId, useState, type ReactNode } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { AE_ICON_CHEVRON_RIGHT } from "@/lib/aeAgentsIcons";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ApprovalSummary } from "@/lib/aeApprovalSummary";
import { cn } from "@/lib/utils";
import { AeApprovalPreview } from "./AeApprovalPreview";

const PEEK_CHARS = 80;

interface AeApprovalSummaryProps {
  summary: ApprovalSummary;
  /** Who asked, shown after the title (the product or policy name). */
  policyLabel?: string;
  onApprove: () => void;
  onReject: () => void;
  /** The standard button row: the write card's buttons, the read row's "More" panel. */
  buttons: ReactNode;
  /** Only the options beyond Approve and Reject (remember, auto mode, ...): the read row's More panel. */
  extras?: ReactNode;
  /** Whether `extras` offers anything beyond Approve and Reject (remember, auto mode, ...). */
  hasMore?: boolean;
  /** The sub-agent requester line, when the prompt was mirrored up. */
  requester?: ReactNode;
  className?: string;
}

export function AeApprovalSummary({
  summary,
  policyLabel,
  onApprove,
  onReject,
  buttons,
  extras,
  hasMore = false,
  requester,
  className,
}: AeApprovalSummaryProps) {
  const { risk, kind, text, cwd, code, danger, truncated } = summary;
  const [moreOpen, setMoreOpen] = useState(false);
  const moreId = useId();
  const isEdit = kind === "edit";
  // The first line of the command stays visible, so the agent's own words are never the only
  // thing on a card whose code is folded.
  const peek = !isEdit && risk !== "destructive" && code ? firstLine(code) : null;
  const peekLine = peek ? (
    <code
      className="block truncate font-mono text-xs whitespace-nowrap text-muted-foreground"
      data-testid="approval-command-peek"
    >
      {peek}
    </code>
  ) : null;
  const codeLabel = isEdit ? "diff" : "command";
  const codeBlock = code ? (
    <AeApprovalPreview
      text={code}
      fold={risk !== "destructive"}
      label={codeLabel}
      startOpen={isEdit}
    />
  ) : null;

  if (risk === "read") {
    return (
      <Alert
        data-testid="approval-card"
        data-state="pending"
        data-risk="read"
        className={cn("flex flex-col gap-1 py-2 px-4", className)}
      >
        {requester}
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-success" />
          <span className="min-w-0 flex-1 text-ui" data-testid="approval-summary-text">
            {text}
          </span>
          <Button
            size="sm"
            onClick={onApprove}
            aria-label={`Approve: ${text}`}
            componentId="approval.approve"
          >
            <CheckIcon className="mr-1 size-3.5" />
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onReject}
            aria-label={`Reject: ${text}`}
            componentId="approval.reject"
          >
            <XIcon className="mr-1 size-3.5" />
            Reject
          </Button>
        </div>
        {peekLine}
        {codeBlock}
        {hasMore && (
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => setMoreOpen((was) => !was)}
              aria-expanded={moreOpen}
              aria-controls={moreId}
              data-testid="ae-approval-more-toggle"
              className="-mx-1 flex w-fit items-center gap-1 rounded-md px-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <AeTablerSvg
                node={AE_ICON_CHEVRON_RIGHT}
                className={cn("size-3.5 shrink-0 transition-transform", moreOpen && "rotate-90")}
              />
              More options
            </button>
            <div id={moreId} hidden={!moreOpen} className="flex flex-wrap gap-2">
              {extras}
            </div>
          </div>
        )}
      </Alert>
    );
  }

  const destructive = risk === "destructive";
  // A command the server cut off may hide a destructive tail, so it gets the same
  // approve-once-or-reject buttons as a destructive one.
  const approveOnce = destructive || truncated === true;
  return (
    <Alert
      data-testid="approval-card"
      data-state="pending"
      data-risk={risk}
      className={cn(
        "flex flex-col gap-2 py-3 px-4",
        destructive && "border-destructive",
        className,
      )}
    >
      <AlertTitle className="flex items-center gap-2 text-ui">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            destructive ? "bg-destructive" : "bg-yellow-600 dark:bg-yellow-400",
          )}
        />
        {isEdit ? "Edit a file" : "Run a command"}
        {policyLabel && <span className="text-muted-foreground text-sm">· {policyLabel}</span>}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        {requester}
        <span className="text-base text-foreground" data-testid="approval-summary-text">
          {text}
        </span>
        {peekLine}
        {((destructive && danger) || truncated || cwd) && (
          <span className="flex flex-wrap items-center gap-2 text-sm">
            {destructive && danger && (
              <span
                className="rounded bg-destructive/10 px-1.5 py-0.5 font-semibold text-destructive"
                data-testid="approval-danger-tag"
              >
                {danger}
              </span>
            )}
            {truncated && (
              <span
                className="rounded bg-muted px-1.5 py-0.5 font-semibold text-foreground"
                data-testid="approval-cutoff-tag"
              >
                command cut off
              </span>
            )}
            {cwd && <code className="rounded bg-muted px-1 py-0.5 font-mono">{cwd}</code>}
          </span>
        )}
        {codeBlock}
        {approveOnce ? (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" onClick={onApprove} componentId="approval.approve_once">
              <CheckIcon className="mr-1 size-3.5" />
              Approve once
            </Button>
            <Button size="sm" variant="outline" onClick={onReject} componentId="approval.reject">
              <XIcon className="mr-1 size-3.5" />
              Reject
            </Button>
          </div>
        ) : (
          buttons
        )}
      </AlertDescription>
    </Alert>
  );
}

function firstLine(code: string): string {
  const lines = code.split("\n").filter((l) => l.trim() !== "");
  const first = (lines[0] ?? "").trim();
  const cut = first.length > PEEK_CHARS ? `${first.slice(0, PEEK_CHARS - 1)}…` : first;
  const more = lines.length - 1;
  return more > 0 ? `${cut} (+${more} more ${more === 1 ? "line" : "lines"})` : cut;
}
