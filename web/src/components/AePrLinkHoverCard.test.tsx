import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import { authenticatedFetch } from "@/lib/identity";
import type { AePrCard } from "@/lib/aePrs";
import { AePrLinkHoverCard } from "./AePrLinkHoverCard";

const URL_2669 = "https://github.com/analyticendeavors/website_content/pull/2669";

const CARD: AePrCard = {
  repo: "analyticendeavors/website_content",
  number: 2669,
  url: URL_2669,
  title: "rolling dev -> main bridge",
  additions: 53,
  deletions: 53,
  changed_files: 29,
  state: "merged",
  draft: false,
  author: "demo-author",
  head_ref: "dev",
  base_ref: "main",
  head_sha: null,
  ci: { state: "passing", passing: 6, failing: 0, pending: 0, total: 6 },
  mergeable: { state: "clean", detail: "" },
  review: { state: "none", approvals: 0, changes_requested: 0, requested: [] },
  merge: { methods: [], default_method: null, allowed: false, reason: "merged" },
};

function renderLink(href: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AePrLinkHoverCard href={href}>
        <a href={href}>the link</a>
      </AePrLinkHoverCard>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(authenticatedFetch).mockReset();
});

describe("AePrLinkHoverCard", () => {
  it("previews a pull request's state, title, author and size, fetching only once open", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(CARD), { status: 200 })),
    );
    renderLink(URL_2669);
    expect(authenticatedFetch).not.toHaveBeenCalled();

    fireEvent.focus(screen.getByText("the link"));
    const preview = await screen.findByTestId("ae-pr-hover");
    await screen.findByText("rolling dev -> main bridge");
    expect(preview).toHaveAttribute("data-pr-state", "merged");
    expect(preview).toHaveTextContent("Merged");
    expect(preview).toHaveTextContent("#2669");
    expect(preview).toHaveTextContent("by demo-author");
    expect(preview).toHaveTextContent("+53");
    expect(preview).toHaveTextContent("29 files");
    // A merged pull request's checks no longer matter.
    expect(preview).not.toHaveTextContent("checks");
    expect(vi.mocked(authenticatedFetch).mock.calls[0][0]).toBe(
      "/v1/ae/prs/analyticendeavors/website_content/2669",
    );
  });

  it("says so when GitHub does not answer", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      Promise.resolve(new Response("{}", { status: 502 })),
    );
    renderLink(URL_2669);
    fireEvent.focus(screen.getByText("the link"));
    await waitFor(() =>
      expect(screen.getByTestId("ae-pr-hover-status")).toHaveTextContent("GitHub did not answer"),
    );
  });

  it("leaves any other link alone", () => {
    renderLink("https://github.com/analyticendeavors/website_content/issues/12");
    fireEvent.focus(screen.getByText("the link"));
    expect(screen.queryByTestId("ae-pr-hover")).toBeNull();
    expect(screen.getByText("the link")).not.toHaveAttribute("data-state");
  });
});

describe("AePrLinkHoverCard edges", () => {
  it("previews a link to a comment on a pull request", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(CARD), { status: 200 })),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AePrLinkHoverCard href={`${URL_2669}#issuecomment-1`}>
          <a href={`${URL_2669}#issuecomment-1`} title={URL_2669}>
            comment link
          </a>
        </AePrLinkHoverCard>
      </QueryClientProvider>,
    );
    const link = screen.getByText("comment link");
    fireEvent.focus(link);
    await screen.findByText("rolling dev -> main bridge");
  });

  it("says a missing or hidden pull request is not visible rather than GitHub being down", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      Promise.resolve(new Response("{}", { status: 404 })),
    );
    renderLink(URL_2669);
    fireEvent.focus(screen.getByText("the link"));
    await waitFor(() =>
      expect(screen.getByTestId("ae-pr-hover-status")).toHaveTextContent("no such pull request"),
    );
  });

  it("falls back to a plain pull request pill for an unknown state", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ...CARD, state: "queued" }), { status: 200 })),
    );
    renderLink(URL_2669);
    fireEvent.focus(screen.getByText("the link"));
    const preview = await screen.findByTestId("ae-pr-hover");
    await screen.findByText("rolling dev -> main bridge");
    expect(preview).toHaveAttribute("data-pr-state", "unknown");
  });
});
