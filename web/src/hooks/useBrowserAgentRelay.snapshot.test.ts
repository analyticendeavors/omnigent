import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SNAPSHOT_JS } from "./useBrowserAgentRelay";

// jsdom has no layout, so size comes from a `data-size="WxH"` attribute
// (default 100x20) on the element.
const realRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const [w, h] = (this.getAttribute("data-size") ?? "100x20").split("x").map(Number);
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON() {} };
  };
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
  document.body.innerHTML = "";
});

function snapshot(): { tree: string } {
  return JSON.parse((0, eval)(SNAPSHOT_JS));
}

const DIALOG = `
  <div role="dialog" style="position:fixed">
    <h2>Add link</h2>
    <input type="radio" aria-label="YouTube">
    <input placeholder="Title">
  </div>`;

describe("SNAPSHOT_JS visibility walk", () => {
  it("lists a dialog rendered inside a zero-size portal root", () => {
    document.body.innerHTML = `<h1>hello</h1><div data-size="0x0" style="position:absolute">${DIALOG}</div>`;
    const { tree } = snapshot();
    expect(tree).toContain('heading "hello"');
    expect(tree).toContain('dialog');
    expect(tree).toContain('heading "Add link"');
    expect(tree).toContain('radio "YouTube"');
    expect(tree).toContain('textbox "Title"');
  });

  it("lists children of a display:contents wrapper", () => {
    document.body.innerHTML = `<div data-size="0x0" style="display:contents"><button>Go</button></div>`;
    expect(snapshot().tree).toContain('button "Go"');
  });

  it("skips children of a zero-height overflow:hidden container", () => {
    document.body.innerHTML = `<div data-size="100x0" style="overflow-x:hidden;overflow-y:hidden"><button>Hidden</button></div><button>Shown</button>`;
    const { tree } = snapshot();
    expect(tree).not.toContain("Hidden");
    expect(tree).toContain("Shown");
  });

  it("skips display:none and opacity:0 subtrees", () => {
    document.body.innerHTML = `
      <div style="display:none"><button>NoneBtn</button></div>
      <div style="opacity:0"><button>FadedBtn</button></div>
      <button>Visible</button>`;
    const { tree } = snapshot();
    expect(tree).not.toContain("NoneBtn");
    expect(tree).not.toContain("FadedBtn");
    expect(tree).toContain("Visible");
  });

  it("does not list a visibility:hidden element itself", () => {
    document.body.innerHTML = `<button style="visibility:hidden">Ghost</button><button>Real</button>`;
    const { tree } = snapshot();
    expect(tree).not.toContain("Ghost");
    expect(tree).toContain("Real");
  });

  it("walks open shadow roots", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    root.innerHTML = `<button>InShadow</button>`;
    expect(snapshot().tree).toContain('button "InShadow"');
  });

  it("walks a same-origin iframe body", () => {
    document.body.innerHTML = `<iframe></iframe>`;
    const frame = document.querySelector("iframe")!;
    // The frame is another realm: give its Element.prototype the same size stub.
    (frame.contentWindow as unknown as Window & typeof globalThis).Element.prototype.getBoundingClientRect =
      Element.prototype.getBoundingClientRect;
    const doc = frame.contentDocument!;
    doc.body.innerHTML = `<button>InFrame</button>`;
    expect(snapshot().tree).toContain('button "InFrame"');
  });

  it("keeps refs for portal content in window.__omni_refs__", () => {
    document.body.innerHTML = `<div data-size="0x0">${DIALOG}</div>`;
    const { tree } = snapshot();
    const ref = Number(/radio "YouTube" \[ref=(\d+)\]/.exec(tree)![1]);
    const refs = (window as unknown as { __omni_refs__: Map<number, WeakRef<Element>> })
      .__omni_refs__;
    expect(refs.get(ref)!.deref()).toBe(document.querySelector('input[type="radio"]'));
  });
});
