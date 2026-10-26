// Settings > Roles > Preset insights (omnigent-ae, 2026-10-24, preset insights
// PR 3). One switch starts the detailed run log and the scheduled preset review
// (the server creates the task on save and deletes it when the switch goes off).
// Below it: who reviews, how often, which presets, when the last and next review
// are, a Run now button, and the user's own suggestions with Apply, Undo and
// Dismiss. Starter-preset suggestions show in Admin Center, not here.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { showToast } from "@/components/ui/toast";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import {
  AE_PRESET_REVIEW_QUERY_KEY,
  AE_PRESET_SUGGESTIONS_QUERY_KEY,
  type AePresetSuggestion,
  useAePresetReviewActions,
  useAePresetReviewStatus,
  useAePresetSuggestions,
} from "@/hooks/useAePresetReview";
import { useAeRolesSave } from "@/hooks/useAeRoles";
import {
  AE_INSIGHTS_FREQUENCIES,
  AE_INSIGHTS_FREQUENCY_DEFAULT,
  type AeInsights,
  type AeInsightsFrequency,
  type AeInsightsShow,
  type AeRolesState,
  aeModelLabel,
  aeWithInsights,
} from "@/lib/aeRoles";

const CONFLICT = "Your roles changed on another device, so the saved presets were reloaded.";
const DEFAULT_WEEKS = 2;
const COST_CAP = "$2";
const POLL_MS = 15_000;
const POLL_MAX_MS = 10 * 60_000;

/** "Oct 20", in the viewer's zone; empty for a missing or unreadable time. */
export function aeInsightsDay(iso: string | null | undefined): string {
  const when = iso ? new Date(iso) : null;
  if (!when || Number.isNaN(when.getTime())) return "";
  return when.toLocaleDateString([], { month: "short", day: "numeric" });
}

const LIVE = new Set(["open", "applying", "applied", "undoing", "undone"]);

/** The suggestions this block lists: the user's own that are live (open, applied, undone or mid-change). */
export function aeOwnSuggestions(all: AePresetSuggestion[] | undefined): AePresetSuggestion[] {
  return (all ?? []).filter((s) => s.kind === "own" && LIVE.has(s.status));
}

function Row({
  title,
  hint,
  hintId,
  children,
}: {
  title: string;
  hint?: React.ReactNode;
  hintId?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-border px-4 py-3 first:border-t-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0 break-words">
        <div className="text-sm font-medium">{title}</div>
        {hint ? (
          <div id={hintId} className="text-xs text-muted-foreground">
            {hint}
          </div>
        ) : null}
      </div>
      {children ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}

function SuggestionRow({
  suggestion,
  busy,
  failure,
  onAct,
}: {
  suggestion: AePresetSuggestion;
  busy: boolean;
  failure: string | undefined;
  onAct: (action: "apply" | "undo" | "dismiss") => void;
}) {
  const applied = suggestion.status === "applied";
  const facts = [suggestion.why, suggestion.saving ? `Expected saving: ${suggestion.saving}` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      data-testid={`ae-preset-suggestion-${suggestion.id}`}
      className="flex flex-col gap-2 border-t border-border px-4 py-3"
    >
      <div className="min-w-0 break-words">
        <div className="text-sm font-medium">
          {suggestion.preset_title ? `${suggestion.preset_title}: ` : ""}
          {suggestion.title}
          {applied ? " (applied)" : suggestion.status === "undone" ? " (undone)" : ""}
        </div>
        <div className="text-xs text-muted-foreground">{facts}</div>
        {suggestion.changes_text ? (
          <div
            data-testid={`ae-preset-changes-${suggestion.id}`}
            className="mt-1 text-xs font-medium"
          >
            {suggestion.changes_text.split("\n").map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        ) : null}
        {failure ? (
          <div role="alert" className="mt-1 text-xs text-destructive">
            {failure}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {suggestion.can_apply && (
          <Button size="sm" disabled={busy} onClick={() => onAct("apply")}>
            Apply
          </Button>
        )}
        {suggestion.can_undo && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onAct("undo")}>
            Undo
          </Button>
        )}
        {(suggestion.status === "open" || suggestion.status === "undone") && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onAct("dismiss")}>
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}

const SHOW_OPTIONS: [AeInsightsShow, string][] = [
  ["cost", "Cost"],
  ["tokens", "Tokens"],
  ["both", "Both"],
];

export function AePresetInsightsBlock({ state }: { state: AeRolesState }) {
  const save = useAeRolesSave();
  const isAdmin = useIsAdmin();
  const insights = state.insights;
  const enabled = insights?.enabled ?? false;
  const status = useAePresetReviewStatus(enabled);
  const suggestionsQuery = useAePresetSuggestions(enabled);
  const actions = useAePresetReviewActions();
  const [saving, setSaving] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [watchFrom, setWatchFrom] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<Record<string, string>>({});

  const change = async (next: AeInsights, message: string) => {
    if (saving) return;
    setSaving(true);
    try {
      const result = await save(aeWithInsights(state, next));
      if (!result.ok) {
        showToast(CONFLICT);
        return;
      }
      setTaskError(
        result.insightsTask?.ok === false
          ? (result.insightsTask.error ?? "The scheduled review could not be set up.")
          : null,
      );
      showToast(message);
    } catch (error) {
      showToast(`Could not save: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };
  const shown: AeInsightsShow = insights?.show ?? "both";
  const current = (): AeInsights => ({
    enabled,
    weeks: insights?.weeks ?? DEFAULT_WEEKS,
    scope: insights?.scope ?? "all",
    ...(insights?.show ? { show: insights.show } : {}),
    ...(insights?.frequency ? { frequency: insights.frequency } : {}),
  });
  // A missing or unknown value from the server reads as the default.
  const frequency = AE_INSIGHTS_FREQUENCIES.some(([value]) => value === insights?.frequency)
    ? (insights?.frequency as AeInsightsFrequency)
    : AE_INSIGHTS_FREQUENCY_DEFAULT;

  const runNow = async () => {
    setRunning(true);
    const result = await actions.run();
    setRunning(false);
    if (result.ok) setWatchFrom(Date.now());
    showToast(
      result.ok ? "The review started. Its suggestions show here when it ends." : result.message,
    );
  };
  const act = async (id: string, action: "apply" | "undo" | "dismiss") => {
    setBusyIds((ids) => new Set(ids).add(id));
    setFailures((f) => {
      const { [id]: _gone, ...rest } = f;
      return rest;
    });
    const result = await actions[action](id);
    setBusyIds((ids) => {
      const rest = new Set(ids);
      rest.delete(id);
      return rest;
    });
    if (!result.ok) setFailures((f) => ({ ...f, [id]: result.message }));
  };

  const info = status.data;
  const lastReviewAt = info?.last_review ? Date.parse(info.last_review) : Number.NaN;
  // After Run now: read the status and suggestions every 15 s for up to 10 minutes, and stop once
  // a review newer than the click shows up.
  useEffect(() => {
    if (watchFrom === null) return;
    if (!Number.isNaN(lastReviewAt) && lastReviewAt > watchFrom) {
      setWatchFrom(null);
      return;
    }
    const timer = setInterval(() => {
      if (Date.now() - watchFrom > POLL_MAX_MS) {
        setWatchFrom(null);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: AE_PRESET_REVIEW_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: AE_PRESET_SUGGESTIONS_QUERY_KEY });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [watchFrom, lastReviewAt, queryClient]);
  const mine = aeOwnSuggestions(suggestionsQuery.data);
  const open = mine.filter((s) => s.status === "open").length;
  const reviewer = info?.reviewer;
  const reviewerText = reviewer
    ? `Default planner (${reviewer.preset_title ?? "your default"}: ${aeModelLabel(reviewer.model)} ${reviewer.effort}), capped at ${COST_CAP} per run`
    : `Default planner, capped at ${COST_CAP} per run`;
  const last = aeInsightsDay(info?.last_review);
  const next = aeInsightsDay(info?.next_review);
  const when = last
    ? `Last review ${last}${next ? `, next ${next}` : ""}`
    : next
      ? `No review yet, next ${next}`
      : "No review yet";

  return (
    <div
      data-testid="ae-preset-insights"
      className="overflow-hidden rounded-xl border border-border"
    >
      <div className="border-b border-border px-4 py-2 text-sm font-medium">Preset insights</div>
      <Row
        title="Collect run logs and review presets"
        hint={
          enabled
            ? "Records each run's preset, roles, models, time, cost, raises, step-downs, hangs and review results. Stored on the server only."
            : "Off. The Admin Center card still shows runs, cost and model changes from what is always recorded; the takeaways and the reviewer need this on."
        }
      >
        <Switch
          aria-label="Collect run logs and review presets"
          checked={enabled}
          disabled={saving}
          onCheckedChange={(on) =>
            void change(
              { ...current(), enabled: on },
              on ? "Preset insights are on." : "Preset insights are off. The log is kept.",
            )
          }
        />
      </Row>
      <Row
        title="Presets card shows"
        hint="Cost is an estimate at API rates. Tokens are what a subscription actually uses up."
      >
        <div role="group" aria-label="Presets card shows" className="flex gap-1">
          {SHOW_OPTIONS.map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={shown === value ? "secondary" : "outline"}
              aria-pressed={shown === value}
              disabled={saving}
              onClick={() =>
                shown !== value &&
                void change(
                  { ...current(), show: value },
                  `The Presets card shows ${label.toLowerCase()}.`,
                )
              }
            >
              {label}
            </Button>
          ))}
        </div>
      </Row>
      {taskError && (
        <div
          role="alert"
          className="border-t border-border px-4 py-2 text-xs text-destructive break-words"
        >
          The scheduled review could not be set up: {taskError}
        </div>
      )}
      {enabled && (
        <>
          <Row
            title="How often"
            hintId="ae-insights-frequency-hint"
            hint={
              "Reviews run Monday 07:00 (server time); Monthly runs on the first Monday of the month. The reviewer reads every log line since its last run." +
              (frequency === "monthly"
                ? " Run now counts as a review, so Run now in the middle of a month can push the next Monthly review out by up to 8 weeks."
                : "")
            }
          >
            {/* Known limit: the scheduler skips any fire more than 30 s late (MISFIRE_GRACE_TIME_S),
                so a deploy at exactly the first-Monday 07:00 slot loses that month's review. */}
            <div
              role="group"
              aria-label="Frequency"
              aria-describedby="ae-insights-frequency-hint"
              className="flex flex-wrap gap-1"
            >
              {AE_INSIGHTS_FREQUENCIES.map(([value, label]) => (
                <Button
                  key={value}
                  size="sm"
                  variant={frequency === value ? "secondary" : "outline"}
                  aria-pressed={frequency === value}
                  aria-disabled={saving || undefined}
                  onClick={() =>
                    !saving &&
                    frequency !== value &&
                    void change(
                      { ...current(), frequency: value },
                      `Reviews run ${label.toLowerCase()}.`,
                    )
                  }
                >
                  {label}
                </Button>
              ))}
            </div>
          </Row>
          <Row title="Reviewer" hint={reviewerText} />
          <Row
            title="Presets it reviews"
            hint={
              isAdmin
                ? "Starters, your own presets, and every user's custom presets."
                : "Starters and your own presets."
            }
          >
            {isAdmin ? (
              <div role="group" aria-label="Presets it reviews" className="flex gap-1">
                {(["all", "own"] as const).map((scope) => (
                  <Button
                    key={scope}
                    size="sm"
                    variant={(insights?.scope ?? "all") === scope ? "secondary" : "outline"}
                    aria-pressed={(insights?.scope ?? "all") === scope}
                    disabled={saving}
                    onClick={() =>
                      (insights?.scope ?? "all") !== scope &&
                      void change(
                        { ...current(), scope },
                        scope === "all"
                          ? "The review covers all users' presets."
                          : "The review covers your presets only.",
                      )
                    }
                  >
                    {scope === "all" ? "All" : "Own"}
                  </Button>
                ))}
              </div>
            ) : null}
          </Row>
          <Row
            title={when}
            hint={
              mine.length || info
                ? `${open} ${open === 1 ? "suggestion" : "suggestions"} waiting`
                : undefined
            }
          >
            <Button size="sm" variant="outline" disabled={running} onClick={() => void runNow()}>
              Run now
            </Button>
          </Row>
          {mine.map((s) => (
            <SuggestionRow
              key={s.id}
              suggestion={s}
              busy={busyIds.has(s.id)}
              failure={failures[s.id]}
              onAct={(action) => void act(s.id, action)}
            />
          ))}
        </>
      )}
    </div>
  );
}
