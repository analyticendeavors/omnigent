import { afterEach, describe, expect, it, vi } from "vitest";
import type { startBrowserTelemetry as StartFn } from "./telemetryOtel";

// Mock the OpenTelemetry SDK so the test is deterministic and free of
// zone.js / network side effects. `vi.hoisted` builds the spies before the
// hoisted `vi.mock` factories run.
const m = vi.hoisted(() => {
  const register = vi.fn();
  return {
    register,
    registerInstrumentations: vi.fn(),
    // Constructor-style mock (normal function, not arrow) so `new
    // WebTracerProvider(...)` works and exposes `.register`.
    WebTracerProvider: vi.fn(function (this: { register: typeof register }) {
      this.register = register;
    }),
    BatchSpanProcessor: vi.fn(),
    FetchInstrumentation: vi.fn(),
    XMLHttpRequestInstrumentation: vi.fn(),
    OTLPTraceExporter: vi.fn(),
    ZoneContextManager: vi.fn(),
    resourceFromAttributes: vi.fn(() => ({})),
    otelModuleLoads: vi.fn(),
    startFails: false,
  };
});

// Counts how often the on-demand module is evaluated.
vi.mock("./telemetryOtel", async () => {
  m.otelModuleLoads();
  const actual = await vi.importActual<{ startBrowserTelemetry: typeof StartFn }>(
    "./telemetryOtel",
  );
  return {
    startBrowserTelemetry: (endpoint: string, serviceName: string) => {
      if (m.startFails) throw new Error("start boom");
      actual.startBrowserTelemetry(endpoint, serviceName);
    },
  };
});

vi.mock("@opentelemetry/instrumentation", () => ({
  registerInstrumentations: m.registerInstrumentations,
}));
vi.mock("@opentelemetry/sdk-trace-web", () => ({
  WebTracerProvider: m.WebTracerProvider,
  BatchSpanProcessor: m.BatchSpanProcessor,
}));
vi.mock("@opentelemetry/instrumentation-fetch", () => ({
  FetchInstrumentation: m.FetchInstrumentation,
}));
vi.mock("@opentelemetry/instrumentation-xml-http-request", () => ({
  XMLHttpRequestInstrumentation: m.XMLHttpRequestInstrumentation,
}));
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: m.OTLPTraceExporter,
}));
vi.mock("@opentelemetry/context-zone", () => ({
  ZoneContextManager: m.ZoneContextManager,
}));
vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: m.resourceFromAttributes,
}));
vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  m.startFails = false;
  vi.resetModules();
});

// Lets the dynamic import in initBrowserTelemetry settle before asserting a non-call.
const flushImports = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });

describe("initBrowserTelemetry", () => {
  it("no-ops when no collector endpoint is configured", async () => {
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_ENDPOINT", "");
    const { initBrowserTelemetry } = await import("./telemetry");

    initBrowserTelemetry();
    await flushImports();

    // With no collector, nothing is registered — production builds without
    // a backend pay zero overhead and never patch fetch.
    expect(m.WebTracerProvider).not.toHaveBeenCalled();
    expect(m.registerInstrumentations).not.toHaveBeenCalled();
  });

  it("loads the OpenTelemetry module only when an endpoint is set", async () => {
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_ENDPOINT", "");
    const off = await import("./telemetry");
    await off.initBrowserTelemetry();
    await flushImports();
    // zone.js loads with the SDK, so the module must stay unloaded.
    expect(m.otelModuleLoads).not.toHaveBeenCalled();

    vi.resetModules();
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318");
    const on = await import("./telemetry");
    await on.initBrowserTelemetry();
    expect(m.otelModuleLoads).toHaveBeenCalledTimes(1);
  });

  it("resolves only after instrumentation is registered", async () => {
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318");
    const { initBrowserTelemetry } = await import("./telemetry");

    await initBrowserTelemetry();

    expect(m.registerInstrumentations).toHaveBeenCalledTimes(1);
  });

  it("warns, resets and resolves when tracing fails to start", async () => {
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.startFails = true;
    const { initBrowserTelemetry } = await import("./telemetry");

    await expect(initBrowserTelemetry()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("failed to start");

    // `initialized` was reset, so a later call tries again.
    m.startFails = false;
    await initBrowserTelemetry();
    expect(m.registerInstrumentations).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("registers a provider + fetch/XHR instrumentation when an endpoint is set", async () => {
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318");
    const { initBrowserTelemetry } = await import("./telemetry");

    initBrowserTelemetry();
    await vi.waitFor(() => expect(m.WebTracerProvider).toHaveBeenCalledTimes(1));

    expect(m.register).toHaveBeenCalledTimes(1);
    // Traces post to the collector's /v1/traces path.
    expect(m.OTLPTraceExporter).toHaveBeenCalledWith({
      url: "http://localhost:4318/v1/traces",
    });
    expect(m.FetchInstrumentation).toHaveBeenCalledTimes(1);
    expect(m.XMLHttpRequestInstrumentation).toHaveBeenCalledTimes(1);
    expect(m.registerInstrumentations).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — a second call does not re-register", async () => {
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318");
    const { initBrowserTelemetry } = await import("./telemetry");

    initBrowserTelemetry();
    initBrowserTelemetry();
    await vi.waitFor(() => expect(m.WebTracerProvider).toHaveBeenCalled());
    await flushImports();

    expect(m.WebTracerProvider).toHaveBeenCalledTimes(1);
  });

  it("strips a trailing slash from the endpoint before appending /v1/traces", async () => {
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318/");
    const { initBrowserTelemetry } = await import("./telemetry");

    initBrowserTelemetry();
    await vi.waitFor(() =>
      expect(m.OTLPTraceExporter).toHaveBeenCalledWith({
        url: "http://localhost:4318/v1/traces",
      }),
    );
  });
});
