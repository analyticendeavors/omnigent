// A pending approval that leads with a plain-English line and sizes by risk (2026-11-27).
// The owner: the raw tool JSON hid what the agent wanted, and a read-only `git status` took
// as much room as a file deletion. Read-only is one row, a normal write is the standard
// card with the code folded, and a destructive command gets a red border, a tag naming the
// danger, the code open, and no remember option. The approve and reject handlers and the
// write card's button row come from ApprovalCard; nothing here decides a verdict.

import type { ReactNode } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ApprovalSummary } from "@/lib/aeApprovalSummary";
import { cn } from "@/lib/utils";
import { AeApprovalPreview } from "./AeApprovalPreview";

interface AeApprovalSummaryProps {
  summary: ApprovalSummary;
  /** Who asked, shown after the title (the product or policy name). */
  policyLabel?: string;
  onApprove: () => void;
  onReject: () => void;
  /** The write card's usual button row; read and destructive cards ignore it. */
  buttons: ReactNode;
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
  requester,
  className,
}: AeApprovalSummaryProps) {
  const { risk, kind, text, cwd, code, danger } = summary;
  const isEdit = kind === "edit";
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
          <Button size="sm" onClick={onApprove} componentId="approval.approve">
            <CheckIcon className="mr-1 size-3.5" />
            Approve
          </Button>
          <Button size="sm" variant="outline" onClick={onReject} componentId="approval.reject">
            <XIcon className="mr-1 size-3.5" />
            Reject
          </Button>
        </div>
        {codeBlock}
      </Alert>
    );
  }

  const destructive = risk === "destructive";
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
        {(danger || cwd) && (
          <span className="flex flex-wrap items-center gap-2 text-sm">
            {destructive && danger && (
              <span
                className="rounded bg-destructive/10 px-1.5 py-0.5 font-semibold text-destructive"
                data-testid="approval-danger-tag"
              >
                {danger}
              </span>
            )}
            {cwd && <code className="rounded bg-muted px-1 py-0.5 font-mono">{cwd}</code>}
          </span>
        )}
        {codeBlock}
        {destructive ? (
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
