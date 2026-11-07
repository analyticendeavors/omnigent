import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineExtension,
  type ExtensionContext,
} from "../../../sdks/web-extension/src/index";
import {
  EXTENSION_RPC_SOURCE,
  EXTENSION_RPC_VERSION,
  type ExtensionIdentity,
} from "../../../sdks/web-extension/src/protocol";

const identity: ExtensionIdentity = {
  extensionId: "test.ext",
  pageId: "main",
  view: "page",
  nonce: "n1",
  apiVersion: EXTENSION_RPC_VERSION,
};

// Activates the SDK against a fake host port and hands back the context plus
// the port, so a test can read what the SDK posted.
async function activate(): Promise<{
  context: ExtensionContext;
  posted: Array<Record<string, unknown>>;
}> {
  globalThis.__OMNIGENT_EXTENSION__ = identity;
  const posted: Array<Record<string, unknown>> = [];
  const port = {
    postMessage: (message: Record<string, unknown>) => posted.push(message),
    start: vi.fn(),
    close: vi.fn(),
    onmessage: null as unknown,
  };
  let context: ExtensionContext | undefined;
  defineExtension({
    activate: (ctx) => {
      context = ctx;
    },
  });
  const init = new Event("message");
  Object.defineProperties(init, {
    source: { value: window.parent },
    ports: { value: [port] },
    data: {
      value: {
        ...identity,
        source: EXTENSION_RPC_SOURCE,
        type: "init",
        capabilities: ["navigation.openPage"],
      },
    },
  });
  window.dispatchEvent(init);
  await Promise.resolve();
  if (!context) throw new Error("extension did not activate");
  return { context, posted };
}

describe("navigation.openPage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    window.dispatchEvent(new Event("pagehide"));
    delete globalThis.__OMNIGENT_EXTENSION__;
  });

  it("sends no params key when the extension passes none", async () => {
    const { context, posted } = await activate();
    void context.navigation.openPage("x").catch(() => undefined);
    const request = posted.find((m) => m.type === "request");
    expect(request?.method).toBe("navigation.openPage");
    // The host rejects any undefined value, so the key must be absent.
    expect(request?.params).toEqual({ pageId: "x" });
    expect(Object.keys(request?.params as object)).not.toContain("params");
  });

  it("still sends params when the extension passes them", async () => {
    const { context, posted } = await activate();
    void context.navigation.openPage("x", { a: 1 }).catch(() => undefined);
    const request = posted.find((m) => m.type === "request");
    expect(request?.params).toEqual({ pageId: "x", params: { a: 1 } });
  });
});
