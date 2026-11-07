// omnigent-ae patch (2026-11-07): `navigation.share` opens the device's share sheet with
// text and one image. It needs the navigation permission, and it names its failures.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCatalogItem } from "../types";

vi.mock("@/lib/routing", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/lib/identity", () => ({
  authenticatedFetch: vi.fn(),
  resolveIdentity: async () => "user@example.com",
}));
vi.mock("@/lib/host", () => ({ getOmnigentServerIdentity: () => "server-a" }));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));

import { useExtensionHostServices } from "./useExtensionHostServices";

function extensionWith(permissions: ExtensionCatalogItem["permissions"]): ExtensionCatalogItem {
  return {
    object: "extension",
    id: "acme.board",
    display_name: "Board",
    distribution: "acme-board",
    version: "1.0.0",
    extension_api: 1,
    status: "enabled",
    permissions,
    pages: [{ id: "acme.board.home", title: "Home", route: "home", view: "home" }],
    primary_navigation: [],
    browser: {
      declared: true,
      has_styles: false,
      digest: "digest",
      script_url: "/script",
      style_url: null,
    },
  };
}

const queryClient = new QueryClient();
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);
const signal = () => new AbortController().signal;

function share(permissions: ExtensionCatalogItem["permissions"] = ["navigation"]) {
  const { result } = renderHook(() => useExtensionHostServices(extensionWith(permissions)), {
    wrapper,
  });
  return result.current.methods["navigation.share"];
}

const image = (type = "image/jpeg", size = 10) =>
  new File([new Uint8Array(size)], "post.jpg", { type });

function setNavigator(shareFn: unknown, canShare?: unknown): void {
  Object.defineProperty(navigator, "share", { value: shareFn, configurable: true });
  Object.defineProperty(navigator, "canShare", { value: canShare, configurable: true });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "share");
  Reflect.deleteProperty(navigator, "canShare");
});

describe("navigation.share", () => {
  it("needs the navigation permission", () => {
    expect(share(["sessions.read"])).toBeUndefined();
    expect(share()).toBeTypeOf("function");
  });

  it("shares text and the image together when the sheet takes files", async () => {
    const sheet = vi.fn().mockResolvedValue(undefined);
    setNavigator(sheet, () => true);
    const file = image();
    await expect(
      share()?.({ text: "Hello", title: "T", files: [file] }, signal()),
    ).resolves.toEqual({ shared: true });
    // Always a new File with a fixed name: an extension cannot choose what the sheet shows.
    const sent = sheet.mock.calls[0][0] as ShareData;
    expect(sent.text).toBe("Hello");
    expect(sent.files).toHaveLength(1);
    expect(sent.files?.[0]).not.toBe(file);
    expect(sent.files?.[0].name).toBe("image.jpg");
    expect(sent.files?.[0].type).toBe("image/jpeg");
  });

  it("shares the text alone and says the image was dropped when canShare refuses files", async () => {
    const sheet = vi.fn().mockResolvedValue(undefined);
    setNavigator(sheet, () => false);
    await expect(
      share()?.({ text: "Hello", files: [image()] }, signal()),
    ).resolves.toEqual({ shared: true, files_dropped: true });
    expect(sheet).toHaveBeenCalledWith({ text: "Hello" });
  });

  it("rejects ShareUnavailable when the browser has no share sheet", async () => {
    await expect(share()?.({ text: "Hello" }, signal())).rejects.toMatchObject({
      code: "ShareUnavailable",
    });
  });

  it("rejects ShareCancelled on an AbortError and ShareFailed on anything else", async () => {
    setNavigator(vi.fn().mockRejectedValue(new DOMException("closed", "AbortError")));
    await expect(share()?.({ text: "Hello" }, signal())).rejects.toMatchObject({
      code: "ShareCancelled",
    });
    setNavigator(vi.fn().mockRejectedValue(new Error("boom")));
    await expect(share()?.({ text: "Hello" }, signal())).rejects.toMatchObject({
      code: "ShareFailed",
    });
  });

  it.each([
    ["text over 3,000 code points", { text: "x".repeat(3001) }],
    ["a title over 200", { text: "a", title: "x".repeat(201) }],
    ["nothing to share", {}],
    ["two files", { text: "a", files: [image(), image()] }],
    ["a gif", { text: "a", files: [image("image/gif")] }],
    ["an image over 5 MB", { text: "a", files: [image("image/jpeg", 5 * 1024 * 1024 + 1)] }],
    ["a string as a file", { text: "a", files: ["data:image/png;base64,AA=="] }],
  ])("refuses %s", async (_name, params) => {
    const sheet = vi.fn().mockResolvedValue(undefined);
    setNavigator(sheet, () => true);
    await expect(share()?.(params, signal())).rejects.toMatchObject({ code: "InvalidParams" });
    expect(sheet).not.toHaveBeenCalled();
  });

  it("answers a probe with whether there is a share sheet, and shares nothing", async () => {
    await expect(share()?.({ probe: true }, signal())).resolves.toEqual({ available: false });
    const sheet = vi.fn().mockResolvedValue(undefined);
    setNavigator(sheet, () => true);
    await expect(share()?.({ probe: true }, signal())).resolves.toEqual({ available: true });
    expect(sheet).not.toHaveBeenCalled();
  });

  it("counts code points, not UTF-16 units", async () => {
    const sheet = vi.fn().mockResolvedValue(undefined);
    setNavigator(sheet, () => true);
    // 3,000 astral characters are 6,000 UTF-16 units but 3,000 code points.
    await expect(share()?.({ text: "\u{1D5D4}".repeat(3000) }, signal())).resolves.toEqual({
      shared: true,
    });
  });
});
