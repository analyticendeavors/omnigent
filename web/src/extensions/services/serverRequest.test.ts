import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/lib/identity";
import { ExtensionHostServiceError } from "./errors";
import { parseServerRequest, performServerRequest } from "./serverRequest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

beforeEach(() => vi.mocked(authenticatedFetch).mockReset());
afterEach(() => vi.useRealTimers());

const userMessage = {
  type: "message",
  data: { role: "user", content: [{ type: "input_text", text: "A" }] },
};

function codeOf(params: unknown): string {
  try {
    parseServerRequest(params);
  } catch (error) {
    if (error instanceof ExtensionHostServiceError) return error.code;
    throw error;
  }
  return "allowed";
}

describe("parseServerRequest: allowed shapes", () => {
  it("passes GET and POST under /v1/ae/ with a plain query", () => {
    expect(parseServerRequest({ method: "GET", path: "/v1/ae/lot?status=open&limit=50" })).toEqual({
      kind: "ae",
      method: "GET",
      path: "/v1/ae/lot?status=open&limit=50",
      body: null,
    });
    expect(
      parseServerRequest({ method: "post", path: "/v1/ae/lot/park", body: { thread: "x" } }),
    ).toEqual({ kind: "ae", method: "POST", path: "/v1/ae/lot/park", body: { thread: "x" } });
    expect(parseServerRequest({ method: "POST", path: "/v1/ae/lot/t_1/resume" }).body).toEqual({});
  });

  it("passes a labels PATCH whose keys all sit under ae.", () => {
    const request = parseServerRequest({
      method: "PATCH",
      path: "/v1/sessions/conv_1",
      body: { labels: { "ae.status": "review", "ae.gate": "" } },
    });
    expect(request).toEqual({
      kind: "labels",
      method: "PATCH",
      path: "/v1/sessions/conv_1",
      body: { labels: { "ae.status": "review", "ae.gate": "" } },
    });
  });

  it("passes one user message to a session's events and rebuilds the body", () => {
    const request = parseServerRequest({
      method: "POST",
      path: "/v1/sessions/conv_1/events",
      body: {
        ...userMessage,
        data: { ...userMessage.data, content: [{ type: "input_text", text: "close it" }] },
      },
    });
    expect(request).toEqual({
      kind: "user-message",
      method: "POST",
      path: "/v1/sessions/conv_1/events",
      body: {
        type: "message",
        data: { role: "user", content: [{ type: "input_text", text: "close it" }] },
      },
    });
  });
});

describe("parseServerRequest: denials", () => {
  it.each([
    ["DELETE anywhere", { method: "DELETE", path: "/v1/sessions/conv_1" }],
    ["DELETE under the AE routes", { method: "DELETE", path: "/v1/ae/lot/t_1" }],
    ["PUT", { method: "PUT", path: "/v1/ae/lot" }],
    ["PATCH under the AE routes", { method: "PATCH", path: "/v1/ae/lot", body: {} }],
    ["GET on a session", { method: "GET", path: "/v1/sessions/conv_1" }],
    ["GET on the session list", { method: "GET", path: "/v1/sessions" }],
    ["POST on a session", { method: "POST", path: "/v1/sessions/conv_1", body: {} }],
    ["PATCH on session events", { method: "PATCH", path: "/v1/sessions/conv_1/events", body: {} }],
    ["a route outside the list", { method: "GET", path: "/v1/projects" }],
    ["a session sub-resource", { method: "POST", path: "/v1/sessions/conv_1/policies", body: {} }],
    ["an absolute URL", { method: "GET", path: "https://evil.example/v1/ae/lot" }],
    ["a protocol-relative URL", { method: "GET", path: "//evil.example/v1/ae/lot" }],
    ["a traversal under the AE routes", { method: "GET", path: "/v1/ae/../sessions" }],
    ["a fragment", { method: "GET", path: "/v1/ae/lot#x" }],
    [
      "a PATCH that renames",
      {
        method: "PATCH",
        path: "/v1/sessions/conv_1",
        body: { title: "x", labels: { "ae.status": "review" } },
      },
    ],
    [
      "a PATCH that archives",
      { method: "PATCH", path: "/v1/sessions/conv_1", body: { archived: true } },
    ],
    [
      "a label outside ae.",
      {
        method: "PATCH",
        path: "/v1/sessions/conv_1",
        body: { labels: { "omnigent.pinned": "1" } },
      },
    ],
    [
      "a label that only looks like ae.",
      {
        method: "PATCH",
        path: "/v1/sessions/conv_1",
        body: { labels: { "ae.status": "x", aex: "y" } },
      },
    ],
    [
      "the bare namespace as a key",
      { method: "PATCH", path: "/v1/sessions/conv_1", body: { labels: { "ae.": "x" } } },
    ],
    [
      "an assistant message",
      {
        method: "POST",
        path: "/v1/sessions/conv_1/events",
        body: { ...userMessage, data: { ...userMessage.data, role: "assistant" } },
      },
    ],
    [
      "a non-message event",
      {
        method: "POST",
        path: "/v1/sessions/conv_1/events",
        body: { ...userMessage, type: "tool" },
      },
    ],
    [
      "an event with extra fields",
      { method: "POST", path: "/v1/sessions/conv_1/events", body: { ...userMessage, actor: "x" } },
    ],
    ["extra request fields", { method: "GET", path: "/v1/ae/lot", headers: { "X-A": "b" } }],
  ])("refuses %s before any fetch", (_name, params) => {
    expect(codeOf(params)).toBe("PermissionDenied");
  });

  it.each([
    ["no params", undefined],
    ["a missing path", { method: "GET" }],
    ["a GET with a body", { method: "GET", path: "/v1/ae/lot", body: {} }],
    ["a non-object POST body", { method: "POST", path: "/v1/ae/lot/park", body: "x" }],
    ["a PATCH without labels", { method: "PATCH", path: "/v1/sessions/conv_1", body: {} }],
    ["empty labels", { method: "PATCH", path: "/v1/sessions/conv_1", body: { labels: {} } }],
    [
      "a non-string label value",
      { method: "PATCH", path: "/v1/sessions/conv_1", body: { labels: { "ae.absorbed": 2 } } },
    ],
    [
      "a label value over 256 characters",
      {
        method: "PATCH",
        path: "/v1/sessions/conv_1",
        body: { labels: { "ae.next": "x".repeat(257) } },
      },
    ],
    [
      "a malformed session id",
      { method: "PATCH", path: "/v1/sessions/%2F", body: { labels: { "ae.status": "x" } } },
    ],
    [
      "a dot session id",
      { method: "PATCH", path: "/v1/sessions/..", body: { labels: { "ae.status": "x" } } },
    ],
    [
      "empty message content",
      {
        method: "POST",
        path: "/v1/sessions/conv_1/events",
        body: { ...userMessage, data: { role: "user", content: [] } },
      },
    ],
    [
      "a non-text content part",
      {
        method: "POST",
        path: "/v1/sessions/conv_1/events",
        body: {
          ...userMessage,
          data: { role: "user", content: [{ type: "input_image", text: "x" }] },
        },
      },
    ],
    ["a query with a stray character", { method: "GET", path: "/v1/ae/lot?a=<b>" }],
  ])("rejects %s as malformed", (_name, params) => {
    expect(codeOf(params)).toBe("InvalidParams");
  });

  it("rejects a body over the RPC message budget", () => {
    expect(
      codeOf({ method: "POST", path: "/v1/ae/lot/park", body: { state: "x".repeat(40_000) } }),
    ).toBe("InvalidParams");
  });
});

describe("performServerRequest", () => {
  it("sends JSON bodies through the authenticated fetch and returns status and body", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(JSON.stringify({ outcome: "filed", task_id: 7 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const controller = new AbortController();
    const request = parseServerRequest({
      method: "POST",
      path: "/v1/ae/lot/park",
      body: { thread: "x" },
    });

    await expect(performServerRequest(request, controller.signal)).resolves.toEqual({
      status: 200,
      ok: true,
      body: { outcome: "filed", task_id: 7 },
    });
    expect(authenticatedFetch).toHaveBeenCalledWith("/v1/ae/lot/park", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread: "x" }),
    });
  });

  it("hands back error statuses with the server's own error body", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "conflict", message: "no open gate" } }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const request = parseServerRequest({ method: "GET", path: "/v1/ae/capacity" });

    await expect(performServerRequest(request, new AbortController().signal)).resolves.toEqual({
      status: 409,
      ok: false,
      body: { error: { code: "conflict", message: "no open gate" } },
    });
    const [, init] = vi.mocked(authenticatedFetch).mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });

  it("returns non-JSON bodies as text and an empty body as null", async () => {
    vi.mocked(authenticatedFetch)
      .mockResolvedValueOnce(new Response("plain", { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const request = parseServerRequest({ method: "GET", path: "/v1/ae/health" });

    await expect(performServerRequest(request, new AbortController().signal)).resolves.toEqual({
      status: 502,
      ok: false,
      body: "plain",
    });
    await expect(performServerRequest(request, new AbortController().signal)).resolves.toEqual({
      status: 204,
      ok: true,
      body: null,
    });
  });

  it("refuses a response over the RPC message budget and maps transport failures", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "x".repeat(70_000) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const request = parseServerRequest({ method: "GET", path: "/v1/ae/lot" });
    await expect(performServerRequest(request, new AbortController().signal)).rejects.toMatchObject(
      { code: "ResponseTooLarge" },
    );

    vi.mocked(authenticatedFetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(performServerRequest(request, new AbortController().signal)).rejects.toMatchObject(
      { code: "HostError" },
    );

    vi.mocked(authenticatedFetch).mockResolvedValueOnce(
      new Response("{", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await expect(performServerRequest(request, new AbortController().signal)).rejects.toMatchObject(
      { code: "HostError", message: "Malformed server response" },
    );
  });

  it("does not fetch with a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = parseServerRequest({ method: "GET", path: "/v1/ae/lot" });

    await expect(performServerRequest(request, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});
