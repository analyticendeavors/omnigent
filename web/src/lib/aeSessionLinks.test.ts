import { afterEach, describe, expect, it } from "vitest";
import { isSessionPath, sessionLinkRoute } from "./aeSessionLinks";

const ID = "e96ed7580fd0415090a5407cbff87612";

afterEach(() => {
  delete window.__OMNIGENT_BASE_PATH__;
});

describe("sessionLinkRoute", () => {
  it.each([
    [`/c/${ID}`, `/c/${ID}`],
    [`/c/${ID}/`, `/c/${ID}`],
    [`/c/${ID}?tab=pr#L12`, `/c/${ID}?tab=pr#L12`],
    [`/c/${ID}#L12`, `/c/${ID}#L12`],
    [`${window.location.origin}/c/${ID}`, `/c/${ID}`],
    [`${window.location.origin}/c/${ID}?a=1#top`, `/c/${ID}?a=1#top`],
    [`https://box.tail1234.ts.net:8010/c/${ID}`, `/c/${ID}`],
    [`https://omnigent.go-ae.org/c/${ID}`, `/c/${ID}`],
    [`/c/${ID.toUpperCase()}`, `/c/${ID}`],
  ])("routes %s in-app", (href, route) => {
    expect(sessionLinkRoute(href)).toBe(route);
  });

  it.each([
    [`https://omnigent.go-ae.org/c/${ID}?next=https://evil.example#x`],
    [`https://other-box.tail1234.ts.net/c/${ID}?tab=pr#top`],
  ])("keeps only the path of a foreign host link %s", (href) => {
    expect(sessionLinkRoute(href)).toBe(`/c/${ID}`);
  });

  it.each([
    `https://example.com/c/${ID}`,
    `https://omnigent.go-ae.org.evil.com/c/${ID}`,
    `https://evil-ts.net.example.com/c/${ID}`,
    `https://ts.net.evil.com/c/${ID}`,
    `https://evil.example.com/x.ts.net/c/${ID}`,
    `https://ts.net/c/${ID}`,
    `https://omnigent.go-ae.org@evil.com/c/${ID}`,
    `https://omnigent.go-ae.org.:443/c/${ID}`,
    `https://omnigent.go-ae.org./c/${ID}`,
    `https://box.tail1234.ts.net./c/${ID}`,
    `javascript:alert(1)//c/${ID}`,
    `data:text/html,/c/${ID}`,
    `//evil.com/c/${ID}`,
    `/\\evil.com/c/${ID}`,
    `/\t/evil.com/c/${ID}`,
    `http://relative.invalid/c/${ID}`,
    `c/${ID}`,
    `https://omnigent.go-ae.org/other/${ID}`,
    `/c/${ID.slice(1)}`,
    `/c/${ID}zz`,
    `/c/${ID}/files`,
    "/c/not-an-id",
    "/some/file.md",
    "mailto:a@b.c",
    `ftp://omnigent.go-ae.org/c/${ID}`,
    "",
  ])("leaves %s alone", (href) => {
    expect(sessionLinkRoute(href)).toBeNull();
  });

  it("strips the deployment base path for relative links", () => {
    window.__OMNIGENT_BASE_PATH__ = "/proxy/6767";
    expect(sessionLinkRoute(`/proxy/6767/c/${ID}`)).toBe(`/c/${ID}`);
  });

  it("strips the base path from an own-origin absolute link", () => {
    window.__OMNIGENT_BASE_PATH__ = "/omnigent";
    expect(sessionLinkRoute(`${window.location.origin}/omnigent/c/${ID}?a=1`)).toBe(`/c/${ID}?a=1`);
  });

  it("does not strip the base path from a foreign host", () => {
    window.__OMNIGENT_BASE_PATH__ = "/omnigent";
    expect(sessionLinkRoute(`https://omnigent.go-ae.org/omnigent/c/${ID}`)).toBeNull();
  });
});

describe("isSessionPath", () => {
  it.each([`/c/${ID}`, `/c/${ID}/`, `/c/${ID}?x=1`, `/c/${ID}#L12`, `/c/${ID}?x=1#L12`])(
    "matches %s",
    (href) => {
      expect(isSessionPath(href)).toBe(true);
    },
  );

  it.each(["/c/x", `/c/${ID}/files#L1`, `https://omnigent.go-ae.org/c/${ID}`, "/notes.md#L12"])(
    "rejects %s",
    (href) => {
      expect(isSessionPath(href)).toBe(false);
    },
  );

  it("sees through the deployment base path", () => {
    window.__OMNIGENT_BASE_PATH__ = "/proxy/6767";
    expect(isSessionPath(`/proxy/6767/c/${ID}#L1`)).toBe(true);
  });
});
