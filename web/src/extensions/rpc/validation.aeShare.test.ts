// omnigent-ae patch (2026-11-07): a `navigation.share` request may carry one Blob; no other
// request may, and the rest of the share request keeps the usual budget.
import { describe, expect, it } from "vitest";
import { EXTENSION_RPC_SOURCE, type ExtensionIdentity } from "./protocol";
import { isExtensionInboundMessage } from "./validation";

const identity: ExtensionIdentity = {
  extensionId: "acme.board",
  pageId: "acme.board.home",
  view: "home",
  nonce: "n",
  apiVersion: 1,
};

const request = (method: string, params: unknown) => ({
  ...identity,
  source: EXTENSION_RPC_SOURCE,
  type: "request",
  requestId: "n-1",
  method,
  params,
});
const blob = () => new Blob([new Uint8Array(200_000)], { type: "image/jpeg" });

describe("navigation.share files", () => {
  it("lets one Blob through, however large", () => {
    expect(
      isExtensionInboundMessage(request("navigation.share", { text: "a", files: [blob()] }), identity),
    ).toBe(true);
  });

  it("refuses two files, a non-Blob file and a Blob on any other method", () => {
    expect(
      isExtensionInboundMessage(
        request("navigation.share", { text: "a", files: [blob(), blob()] }),
        identity,
      ),
    ).toBe(false);
    expect(
      isExtensionInboundMessage(request("navigation.share", { text: "a", files: ["x"] }), identity),
    ).toBe(false);
    expect(
      isExtensionInboundMessage(request("navigation.openExternal", { files: [blob()] }), identity),
    ).toBe(false);
  });

  it("holds the rest of the share request to the usual budget", () => {
    expect(
      isExtensionInboundMessage(
        request("navigation.share", { text: "x".repeat(40_000), files: [blob()] }),
        identity,
      ),
    ).toBe(false);
  });
});
