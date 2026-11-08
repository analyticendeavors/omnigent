// The OpenTelemetry setup behind `initBrowserTelemetry`, in its own module so
// the SDK (and zone.js, which wraps every timer and event listener once loaded)
// is only fetched when a collector endpoint is configured.

import { ZoneContextManager } from "@opentelemetry/context-zone";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { XMLHttpRequestInstrumentation } from "@opentelemetry/instrumentation-xml-http-request";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/** Starts tracing against the collector at `endpoint`. Call once. */
export function startBrowserTelemetry(endpoint: string, serviceName: string): void {
  const exporter = new OTLPTraceExporter({
    // OTLP/HTTP traces are posted to the collector's `/v1/traces` path.
    url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
  });

  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  // ZoneContextManager keeps the active span across async boundaries
  // (promises, timers) so child spans nest correctly in the browser.
  provider.register({ contextManager: new ZoneContextManager() });

  // Propagate `traceparent` to same-origin API calls (the default) and,
  // explicitly, to this app's own origin — scoped so the header is never
  // attached to unrelated third-party requests (analytics, CDNs).
  const propagateTraceHeaderCorsUrls = [new RegExp(`^${escapeRegExp(window.location.origin)}`)];

  registerInstrumentations({
    instrumentations: [
      new FetchInstrumentation({
        propagateTraceHeaderCorsUrls,
        clearTimingResources: true,
      }),
      new XMLHttpRequestInstrumentation({ propagateTraceHeaderCorsUrls }),
    ],
  });
}

/**
 * Escape a string for safe use inside a RegExp.
 *
 * @param value Raw string, e.g. an origin like `https://app.example.com`.
 * @returns The string with regex metacharacters escaped.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
