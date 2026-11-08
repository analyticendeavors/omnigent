// Browser-side OpenTelemetry tracing for the Omnigent web UI.
//
// Initializes a WebTracerProvider with fetch + XHR instrumentation so a
// trace BEGINS in the browser (at the user's click) and continues into the
// server: the instrumentation injects a W3C `traceparent` header on every
// request, which the FastAPI-instrumented server extracts. The browser
// exports spans over OTLP/HTTP to a collector.
//
// Opt-in by configuration, mirroring the server: tracing only activates when
// `VITE_OTEL_EXPORTER_OTLP_ENDPOINT` is set (the base URL of an OTLP/HTTP
// collector, e.g. `http://localhost:4318`). With no endpoint configured this
// is a no-op — no provider, no patched fetch, zero overhead — so production
// builds without a collector are unaffected.

let initialized = false;

/**
 * Initialize browser tracing if a collector endpoint is configured.
 *
 * Idempotent and safe to call once at app startup. No-op when
 * `VITE_OTEL_EXPORTER_OTLP_ENDPOINT` is unset. The SDK loads on demand, so with
 * tracing on, requests made before the import resolves are not traced.
 */
export function initBrowserTelemetry(): void {
  if (initialized) return;

  const endpoint = import.meta.env.VITE_OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return;
  initialized = true;

  const serviceName = import.meta.env.VITE_OTEL_SERVICE_NAME?.trim() || "omni-web";
  void import("./telemetryOtel").then((mod) => mod.startBrowserTelemetry(endpoint, serviceName));
}
