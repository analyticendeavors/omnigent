import { describe, expect, it } from "vitest";
import { isAeGithubLinkUrl } from "./aeExternalUrls";

describe("isAeGithubLinkUrl", () => {
  it.each([
    "https://github.com/analyticendeavors/omnigent-ae/pull/57",
    "https://github.com/analyticendeavors/omnigent-ae/issues/28",
    "https://github.com/omnigent-ai/omnigent/pull/6935/files",
    "https://github.com/omnigent-ai/omnigent/pull/6935/commits",
    "https://github.com/omnigent-ai/omnigent/pull/6935/checks",
    "https://github.com/acme/repo.name_x/pull/1#issuecomment-1234567",
    "https://github.com/acme/repo/issues/9#discussion_r42",
    "https://github.com/A-b.c_d/E.f-g_h/pull/1234567890",
  ])("accepts %s", (url) => {
    expect(isAeGithubLinkUrl(url)).toBe(true);
  });

  it.each([
    ["not a string", 42],
    ["null", null],
    ["empty", ""],
    ["javascript", "javascript:alert(1)//https://github.com/a/b/pull/1"],
    ["data", "data:text/html,https://github.com/a/b/pull/1"],
    ["http", "http://github.com/a/b/pull/1"],
    ["protocol relative", "//github.com/a/b/pull/1"],
    ["another host", "https://gitlab.com/a/b/pull/1"],
    ["a subdomain", "https://gist.github.com/a/b/pull/1"],
    ["a lookalike host", "https://github.com.evil.example/a/b/pull/1"],
    ["a lookalike suffix", "https://evilgithub.com/a/b/pull/1"],
    ["uppercase host", "https://GitHub.com/a/b/pull/1"],
    ["userinfo", "https://user@github.com/a/b/pull/1"],
    ["userinfo lookalike", "https://github.com@evil.example/a/b/pull/1"],
    ["a port", "https://github.com:443/a/b/pull/1"],
    ["another port", "https://github.com:8443/a/b/pull/1"],
    ["a query", "https://github.com/a/b/pull/1?tab=files"],
    ["an empty query", "https://github.com/a/b/pull/1?"],
    ["a query after a suffix", "https://github.com/a/b/pull/1/files?diff=split"],
    ["an extra path segment", "https://github.com/a/b/pull/1/merge"],
    ["a trailing slash", "https://github.com/a/b/pull/1/"],
    ["a nested path", "https://github.com/a/b/c/pull/1"],
    ["a missing repo", "https://github.com/a/pull/1"],
    ["another page kind", "https://github.com/a/b/settings/1"],
    ["a suffix on an issue", "https://github.com/a/b/issues/1/files"],
    ["an encoded slash", "https://github.com/a%2Fb/c/pull/1"],
    ["an encoded dot", "https://github.com/a/%2e%2e/pull/1"],
    ["a dot segment", "https://github.com/a/../pull/1"],
    ["a single dot segment", "https://github.com/./b/pull/1"],
    ["a backslash", "https://github.com\\@evil.example/a/b/pull/1"],
    ["zero", "https://github.com/a/b/pull/0"],
    ["a leading zero", "https://github.com/a/b/pull/01"],
    ["a negative number", "https://github.com/a/b/pull/-1"],
    ["not a number", "https://github.com/a/b/pull/abc"],
    ["too many digits", "https://github.com/a/b/pull/12345678901"],
    ["an empty fragment", "https://github.com/a/b/pull/1#"],
    ["a fragment with a script", "https://github.com/a/b/pull/1#<script>"],
    ["whitespace", " https://github.com/a/b/pull/1"],
    ["a trailing newline", "https://github.com/a/b/pull/1\n"],
    ["a tab inside", "https://github.com/a/b/pu\tll/1"],
    ["a non-ASCII owner", "https://github.com/ａ/b/pull/1"],
  ])("rejects %s", (_name, url) => {
    expect(isAeGithubLinkUrl(url)).toBe(false);
  });
});
