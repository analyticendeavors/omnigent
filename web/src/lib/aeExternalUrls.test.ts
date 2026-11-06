import { describe, expect, it } from "vitest";
import {
  isAeAzureCostLinkUrl,
  isAeDatabricksLinkUrl,
  isAeFabricAdminLinkUrl,
  isAeGithubLinkUrl,
  isAeLinkedinShareUrl,
  isAeYoutubePostsUrl,
} from "./aeExternalUrls";

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

describe("isAeDatabricksLinkUrl", () => {
  const HOST = "https://dbc-00000000-0000.cloud.databricks.com";
  const WAREHOUSE = `${HOST}/sql/warehouses/0123456789abcdef`;

  it.each([
    ["the workspace", HOST],
    ["the workspace with its slash", `${HOST}/`],
    ["a warehouse", WAREHOUSE],
    ["a named workspace", "https://acme.cloud.databricks.com"],
    ["a label holding xn-- later", "https://abxn--c.cloud.databricks.com"],
  ])("admits %s", (_name, url) => {
    expect(isAeDatabricksLinkUrl(url)).toBe(true);
  });

  it.each([
    ["not a string", 42],
    ["http", HOST.replace("https:", "http:")],
    ["another host", `${HOST}.evil.example`],
    ["a lookalike domain", HOST.replace("cloud.databricks.com", "cloud-databricks.com")],
    ["a nested subdomain", HOST.replace("https://", "https://x.")],
    ["the bare domain", "https://cloud.databricks.com"],
    ["Azure Databricks", "https://adb-1234567890123456.7.azuredatabricks.net"],
    ["userinfo", HOST.replace("https://", "https://evil.example@")],
    ["a port", `${HOST}:8443`],
    ["a query", `${HOST}/?x=1`],
    ["a fragment", `${HOST}/#x`],
    ["another page", `${HOST}/sql/editor`],
    ["a longer warehouse path", `${WAREHOUSE}/monitoring`],
    ["a short warehouse id", WAREHOUSE.slice(0, -1)],
    ["an upper case warehouse id", `${HOST}/sql/warehouses/0123456789ABCDEF`],
    ["an upper case host", `https://${HOST.slice("https://".length).toUpperCase()}`],
    ["a punycode label", "https://xn--80ak6aa92e.cloud.databricks.com"],
    [
      "a punycode warehouse",
      "https://xn--80ak6aa92e.cloud.databricks.com/sql/warehouses/0123456789abcdef",
    ],
    ["a trailing dot", HOST.replace(".com", ".com.")],
    ["a space", `${HOST} `],
    ["a tab", `${HOST}\t`],
    ["an encoded warehouse id", `${HOST}/sql/warehouses/0123456789abcde%66`],
    ["a backslash", `${HOST}\\sql/warehouses/0123456789abcdef`],
    ["a leading hyphen", "https://-acme.cloud.databricks.com"],
    ["an encoded path", `${HOST}/sql%2Fwarehouses/0123456789abcdef`],
    ["a trailing newline", `${HOST}\n`],
  ])("rejects %s", (_name, url) => {
    expect(isAeDatabricksLinkUrl(url)).toBe(false);
  });
});

describe("isAeAzureCostLinkUrl", () => {
  const COST = "https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/costanalysis";

  it("admits the cost analysis page", () => {
    expect(isAeAzureCostLinkUrl(COST)).toBe(true);
  });

  it.each([
    ["not a string", 42],
    ["http", COST.replace("https:", "http:")],
    ["another host", COST.replace("portal.azure.com", "portal.azure.com.evil.example")],
    ["a lookalike host", COST.replace("portal.azure.com", "portal-azure.com")],
    ["userinfo", COST.replace("https://", "https://evil.example@")],
    ["a port", COST.replace("azure.com", "azure.com:8443")],
    ["a query", COST.replace("/#", "/?x=1#")],
    ["another blade", COST.replace("costanalysis", "overview")],
    ["a scope appended", `${COST}/scope/%2Fsubscriptions%2F0`],
    ["a trailing space", `${COST} `],
    ["a trailing newline", `${COST}\n`],
    ["an upper case host", COST.replace("portal.azure.com", "PORTAL.AZURE.COM")],
  ])("rejects %s", (_name, url) => {
    expect(isAeAzureCostLinkUrl(url)).toBe(false);
  });
});

describe("isAeLinkedinShareUrl", () => {
  const BASE = "https://www.linkedin.com/feed/?shareActive=true";
  const withText = (text: string) =>
    `${BASE}&text=${encodeURIComponent(text).replace(/'/g, "%27")}`;

  it.each([
    ["the bare share box", BASE],
    ["plain text", withText("New video is up")],
    [
      "newlines, punctuation and a link",
      withText("Line one\n\nLine two! (a) 'b' *c* https://youtu.be/abc?x=1&y=2#t"),
    ],
    ["non-ASCII text and an emoji", withText("café \u{1F680} \u65E5\u672C")],
    ["exactly 3,000 characters", withText("a".repeat(3000))],
    ["3,000 emoji", withText("\u{1F680}".repeat(3000))],
  ])("admits %s", (_name, url) => {
    expect(isAeLinkedinShareUrl(url)).toBe(true);
  });

  it.each([
    ["not a string", 42],
    ["http", BASE.replace("https:", "http:")],
    ["another host", BASE.replace("www.linkedin.com", "www.linkedin.com.evil.example")],
    ["no www", BASE.replace("www.", "")],
    ["userinfo", BASE.replace("https://", "https://evil.example@")],
    ["a port", BASE.replace("linkedin.com", "linkedin.com:8443")],
    ["another path", BASE.replace("/feed/", "/messaging/")],
    ["no shareActive", "https://www.linkedin.com/feed/"],
    ["shareActive false", BASE.replace("true", "false")],
    ["a second parameter", `${BASE}&url=https%3A%2F%2Fevil.example`],
    ["a parameter before text", `${BASE}&x=1&text=hi`],
    ["text twice", `${withText("a")}&text=b`],
    ["a fragment", `${BASE}#x`],
    ["a fragment after text", `${withText("hi")}#x`],
    ["empty text", `${BASE}&text=`],
    ["a bare apostrophe in text", `${BASE}&text=it's`],
    ["a raw space in text", `${BASE}&text=hello world`],
    ["a raw ampersand in text", `${BASE}&text=a&b=c`],
    ["lower-case escapes", `${BASE}&text=%e2%9c%93`],
    ["a bad escape", `${BASE}&text=%zz`],
    ["a lone continuation byte", `${BASE}&text=%80`],
    ["3,001 characters", withText("a".repeat(3001))],
    ["3,001 emoji", withText("\u{1F680}".repeat(3001))],
    ["a trailing space", `${BASE} `],
    ["a trailing newline", `${BASE}\n`],
    ["an upper case host", BASE.replace("www.linkedin.com", "WWW.LINKEDIN.COM")],
  ])("rejects %s", (_name, url) => {
    expect(isAeLinkedinShareUrl(url)).toBe(false);
  });
});

describe("isAeYoutubePostsUrl", () => {
  const ID = "UCQSSIe3typhsBuFEoTeeqLg";
  const POSTS = `https://www.youtube.com/channel/${ID}/posts`;

  it.each([
    ["a channel Posts tab", POSTS],
    [
      "an id with hyphen and underscore",
      "https://www.youtube.com/channel/UCjlfQwqb-0S40XQ8seYPLSw/posts",
    ],
    ["an id with an underscore", "https://www.youtube.com/channel/UC_abcdefghijklmnopqrstu/posts"],
  ])("admits %s", (_name, url) => {
    expect(isAeYoutubePostsUrl(url)).toBe(true);
  });

  it.each([
    ["not a string", 42],
    ["http", POSTS.replace("https:", "http:")],
    ["another host", POSTS.replace("www.youtube.com", "www.youtube.com.evil.example")],
    ["no www", POSTS.replace("www.", "")],
    ["userinfo", POSTS.replace("https://", "https://evil.example@")],
    ["a port", POSTS.replace("youtube.com", "youtube.com:8443")],
    ["an id that does not start with UC", POSTS.replace("UCQ", "UDQ")],
    ["a short id", POSTS.replace(ID, ID.slice(0, 22))],
    ["a long id", POSTS.replace(ID, `${ID}x`)],
    ["a handle", "https://www.youtube.com/@analyticendeavors/posts"],
    ["another tab", POSTS.replace("/posts", "/videos")],
    ["a query", `${POSTS}?x=1`],
    ["a fragment", `${POSTS}#x`],
    ["a trailing slash", `${POSTS}/`],
    ["an encoded character", POSTS.replace("Q", "%51")],
    ["a trailing newline", `${POSTS}\n`],
  ])("rejects %s", (_name, url) => {
    expect(isAeYoutubePostsUrl(url)).toBe(false);
  });
});
