import { transform } from "lightningcss";
import { compile } from "tailwindcss";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ComposerHostTrigger } from "@/components/composer/ComposerControls";
import {
  COMPOSER_TIGHT_HOST_WRAPPER_CLASS,
  COMPOSER_TIGHT_MIC_CLASS,
  COMPOSER_TIGHTER_WRAPPER_CLASS,
} from "./aeComposerTight";

// The three class strings are compiled by Tailwind itself and injected, so the
// assertions read the real computed display of each control, not the class names.
beforeAll(async () => {
  const compiler = await compile("@tailwind utilities;");
  const style = document.createElement("style");
  // jsdom cannot read CSS nesting, so lower it to flat selectors first.
  const nested = compiler.build([
    ...COMPOSER_TIGHT_MIC_CLASS.split(" "),
    ...COMPOSER_TIGHT_HOST_WRAPPER_CLASS.split(" "),
    ...COMPOSER_TIGHTER_WRAPPER_CLASS.split(" "),
  ]);
  style.textContent = new TextDecoder().decode(
    transform({
      filename: "tight.css",
      code: new TextEncoder().encode(nested),
      targets: { chrome: 90 << 16 },
    }).code,
  );
  document.head.appendChild(style);
});
afterEach(cleanup);

function renderRow(opts: {
  tight: boolean;
  tighter?: boolean;
  host: "online" | "offline";
  listening?: boolean;
  connecting?: boolean;
}) {
  const attrs: Record<string, string> = {};
  if (opts.tight) attrs["data-tight"] = "";
  if (opts.tighter) attrs["data-tighter"] = "";
  render(
    <div className="group/composer-actions" {...attrs}>
      <span className={COMPOSER_TIGHTER_WRAPPER_CLASS}>
        <button type="button" aria-label="Roles preset" />
      </span>
      <span className={COMPOSER_TIGHT_HOST_WRAPPER_CLASS}>
        <ComposerHostTrigger label="Host" status={opts.host} />
      </span>
      <button
        type="button"
        aria-label="Voice dictation"
        aria-pressed={opts.listening ?? false}
        aria-busy={opts.connecting ?? false}
        className={COMPOSER_TIGHT_MIC_CLASS}
      />
    </div>,
  );
  const shown = (name: string) => getComputedStyle(screen.getByLabelText(name)).display !== "none";
  const hostShown = () => {
    const wrapper = screen.getByLabelText("Host").parentElement as HTMLElement;
    return getComputedStyle(wrapper).display !== "none";
  };
  return { mic: () => shown("Voice dictation"), host: hostShown };
}

describe("tight composer action row", () => {
  it("hides the mic and an online host badge when tight, healthy and idle", () => {
    const row = renderRow({ tight: true, host: "online" });
    expect(row.mic()).toBe(false);
    expect(row.host()).toBe(false);
  });

  it("keeps the host badge while the host is not online", () => {
    const row = renderRow({ tight: true, host: "offline" });
    expect(row.host()).toBe(true);
    expect(row.mic()).toBe(false);
  });

  it("keeps the mic while a take is recording or starting", () => {
    expect(renderRow({ tight: true, host: "online", listening: true }).mic()).toBe(true);
    cleanup();
    expect(renderRow({ tight: true, host: "online", connecting: true }).mic()).toBe(true);
  });

  it("shows everything when the row is not tight", () => {
    const row = renderRow({ tight: false, host: "online" });
    expect(row.mic()).toBe(true);
    expect(row.host()).toBe(true);
  });

  it("hides the roles preset control only in the tighter tier", () => {
    renderRow({ tight: true, host: "online" });
    expect(getComputedStyle(screen.getByLabelText("Roles preset").parentElement as HTMLElement).display).not.toBe("none");
    cleanup();
    renderRow({ tight: true, tighter: true, host: "online" });
    expect(getComputedStyle(screen.getByLabelText("Roles preset").parentElement as HTMLElement).display).toBe("none");
  });
});
