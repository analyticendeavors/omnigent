import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AE_BUILD_CHECK_INTERVAL_MS, resetAnnouncedBuildsForTests } from "@/lib/aeBuildCheck";
import { EmbeddedProvider } from "@/lib/embedded";

const mocks = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { dismiss: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import { AeReloadNotice } from "./AeReloadNotice";

const html = (name: string) => `<script type="module" crossorigin src="./assets/${name}"></script>`;

describe("AeReloadNotice", () => {
  const fetchMock = vi.fn();
  const serve = (name: string) =>
    fetchMock.mockResolvedValue({ ok: true, text: async () => html(name) });
  const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  beforeEach(() => {
    vi.useFakeTimers();
    resetAnnouncedBuildsForTests();
    mocks.toast.mockReset();
    mocks.toast.dismiss.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    const script = document.createElement("script");
    script.type = "module";
    script.setAttribute("src", "./assets/index-OLD.js");
    document.head.appendChild(script);
  });
  afterEach(() => {
    document.head.querySelectorAll("script").forEach((s) => s.remove());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders nothing and stays quiet while the build is the same", async () => {
    serve("index-OLD.js");
    const { container } = render(<AeReloadNotice />);
    await tick(AE_BUILD_CHECK_INTERVAL_MS * 2);
    expect(container.innerHTML).toBe("");
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("shows one persistent toast for a new build, and Later keeps it quiet for that build", async () => {
    serve("index-NEW1.js");
    render(<AeReloadNotice />);
    await tick(AE_BUILD_CHECK_INTERVAL_MS * 3);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    const [title, options] = mocks.toast.mock.calls[0];
    expect(title).toBe("OmniGent was updated.");
    expect(options).toMatchObject({
      id: "ae-reload-notice",
      description: "Reload to get the new version.",
      duration: Number.POSITIVE_INFINITY,
      action: { label: "Reload" },
      cancel: { label: "Later" },
    });
    options.cancel.onClick();
    expect(mocks.toast.dismiss).toHaveBeenCalledWith("ae-reload-notice");
    await tick(AE_BUILD_CHECK_INTERVAL_MS * 2);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    serve("index-NEW2.js");
    await tick(AE_BUILD_CHECK_INTERVAL_MS);
    expect(mocks.toast).toHaveBeenCalledTimes(2);
  });

  it("stops checking after unmount", async () => {
    serve("index-NEW1.js");
    const { unmount } = render(<AeReloadNotice />);
    unmount();
    await tick(AE_BUILD_CHECK_INTERVAL_MS * 2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays quiet for a build after Later even when the component remounts", async () => {
    serve("index-NEW1.js");
    const first = render(<AeReloadNotice />);
    await tick(AE_BUILD_CHECK_INTERVAL_MS);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    mocks.toast.mock.calls[0][1].cancel.onClick();
    first.unmount();
    render(<AeReloadNotice />);
    await tick(AE_BUILD_CHECK_INTERVAL_MS * 2);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("does not check at all when embedded", async () => {
    serve("index-NEW1.js");
    render(
      <EmbeddedProvider>
        <AeReloadNotice />
      </EmbeddedProvider>,
    );
    await tick(AE_BUILD_CHECK_INTERVAL_MS * 2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
