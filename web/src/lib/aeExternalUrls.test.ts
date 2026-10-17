import { describe, expect, it } from "vitest";
import { isAeFabricAdminLinkUrl, isAeGithubLinkUrl } from "./aeExternalUrls";

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

describe("isAeFabricAdminLinkUrl", () => {
  const GUID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
  const AZURE = `https://portal.azure.com/#resource/subscriptions/${GUID}/resourceGroups/rg-fabric.prod_1/providers/Microsoft.Fabric/capacities/aetraining/overview`;

  it.each([
    AZURE,
    "https://app.fabric.microsoft.com/admin-portal/capacities",
    `https://portal.azure.com/#resource/subscriptions/${GUID.toUpperCase()}/resourceGroups/RG(1)/providers/Microsoft.Fabric/capacities/A-b/overview`,
  ])("accepts %s", (url) => {
    expect(isAeFabricAdminLinkUrl(url)).toBe(true);
  });

  it.each([
    ["not a string", 42],
    ["null", null],
    ["javascript", "javascript:alert(1)//https://portal.azure.com/"],
    ["http azure", AZURE.replace("https:", "http:")],
    ["http fabric", "http://app.fabric.microsoft.com/admin-portal/capacities"],
    ["another host", AZURE.replace("portal.azure.com", "portal.azure.com.evil.example")],
    ["a lookalike host", AZURE.replace("portal.azure.com", "evilportal.azure.com")],
    ["a subdomain", AZURE.replace("portal.azure.com", "x.portal.azure.com")],
    ["userinfo", AZURE.replace("https://", "https://evil.example@")],
    ["userinfo on fabric", "https://x@app.fabric.microsoft.com/admin-portal/capacities"],
    ["a port", AZURE.replace("azure.com", "azure.com:8443")],
    ["a query on azure", AZURE.replace("/#", "/?x=1#")],
    ["a query on fabric", "https://app.fabric.microsoft.com/admin-portal/capacities?x=1"],
    ["a fragment on fabric", "https://app.fabric.microsoft.com/admin-portal/capacities#x"],
    ["a trailing slash on fabric", "https://app.fabric.microsoft.com/admin-portal/capacities/"],
    ["a longer fabric path", "https://app.fabric.microsoft.com/admin-portal/capacities/x"],
    ["another fabric page", "https://app.fabric.microsoft.com/admin-portal/tenantSettings"],
    ["an extra azure path", AZURE.replace("/overview", "/overview/delete")],
    ["a trailing azure query", `${AZURE}?x=1`],
    ["another blade", AZURE.replace("/overview", "/configuration")],
    [
      "another provider",
      AZURE.replace("Microsoft.Fabric/capacities", "Microsoft.Compute/virtualMachines"),
    ],
    ["another Fabric type", AZURE.replace("capacities/aetraining", "workspaces/aetraining")],
    ["different case provider", AZURE.replace("Microsoft.Fabric", "microsoft.fabric")],
    ["different case type", AZURE.replace("capacities", "Capacities")],
    ["a short guid", AZURE.replace(GUID, "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4")],
    ["a non-hex guid", AZURE.replace(GUID, "zb1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d")],
    ["a slash in the group", AZURE.replace("rg-fabric.prod_1", "rg/x")],
    ["an encoded group", AZURE.replace("rg-fabric.prod_1", "rg%2Fx")],
    ["a dot group", AZURE.replace("rg-fabric.prod_1", "..")],
    ["an empty name", AZURE.replace("capacities/aetraining", "capacities/")],
    ["an underscore name", AZURE.replace("aetraining", "ae_training")],
    ["a long name", AZURE.replace("aetraining", "a".repeat(64))],
    ["a missing hash", AZURE.replace("/#resource", "/resource")],
    ["whitespace", ` ${AZURE}`],
    ["a trailing newline", `${AZURE}\n`],
  ])("rejects %s", (_name, url) => {
    expect(isAeFabricAdminLinkUrl(url)).toBe(false);
  });
});
