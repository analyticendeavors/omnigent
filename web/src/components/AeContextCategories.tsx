import { categoryColor, type ContextUsage } from "./aeContextUsage";

const tokens = (value: number) =>
  new Intl.NumberFormat("en", { maximumFractionDigits: 1, notation: "compact" }).format(value);

export function AeCategoryBar({ data }: { data: ContextUsage }) {
  return (
    <div
      className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
      role="img"
      aria-label="Estimated context by category"
    >
      {data.categories
        .filter((c) => c.kind === "used" || c.kind === "buffer")
        .map((c) => (
          <span
            key={c.name}
            title={`${c.name}: ${tokens(c.tokens)}`}
            className={
              c.kind === "buffer" ? "ml-auto bg-muted-foreground/20" : categoryColor(c.name)
            }
            style={{ width: `${Math.min(100, (c.tokens / data.maxTokens) * 100)}%` }}
          />
        ))}
    </div>
  );
}

export function AeContextCategories({ data, error }: { data?: ContextUsage; error?: string }) {
  if (error)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {error}
      </p>
    );
  if (!data)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Reading context categories…
      </p>
    );
  if (!data.available)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {data.reason}
      </p>
    );
  return (
    <section className="min-w-0 space-y-2" aria-label="Context categories">
      <h4 className="text-sm font-medium">Context breakdown</h4>
      <p className="text-xs text-muted-foreground">
        Estimated snapshot · {tokens(data.totalTokens)} / {tokens(data.maxTokens)} ·{" "}
        {new Date(data.observedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </p>
      {!data.complete && (
        <p className="text-xs text-muted-foreground">
          Some MCP servers are unavailable or still connecting. Their tools may be missing.
        </p>
      )}
      <dl className="space-y-1 text-sm">
        {data.categories.map((c) => (
          <div key={c.name} className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0 break-words">
              <span
                aria-hidden="true"
                className={`mr-2 inline-block size-2 rounded-full ${c.kind === "used" ? categoryColor(c.name) : "bg-muted-foreground/40"}`}
              />
              {c.name}
            </dt>
            <dd className="shrink-0 tabular-nums">{tokens(c.tokens)}</dd>
          </div>
        ))}
      </dl>
      {data.categories.some((c) => c.kind === "deferred") && (
        <p className="text-xs text-muted-foreground">
          Deferred tools are available on demand and excluded from used space.
        </p>
      )}
      {Object.entries(data.details)
        .filter(([, rows]) => rows.length > 0)
        .map(([name, rows]) => (
          <details key={name} className="text-sm">
            <summary className="flex min-h-8 cursor-pointer items-center pointer-coarse:min-h-10">
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="mr-1 size-4"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
              {name} ({rows.length})
            </summary>
            <dl className="max-h-48 space-y-1 overflow-y-auto pl-3">
              {rows.map((row) => (
                <div key={row.name} className="flex items-baseline justify-between gap-3">
                  <dt className="min-w-0 break-all text-muted-foreground">{row.name}</dt>
                  <dd className="shrink-0 tabular-nums">{tokens(row.tokens)}</dd>
                </div>
              ))}
            </dl>
          </details>
        ))}
    </section>
  );
}
