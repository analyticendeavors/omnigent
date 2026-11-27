import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), toastError: vi.fn() }));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

import { AeMasterChatRow } from "./AeMasterChatRow";

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderRow(path = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <AeMasterChatRow />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function answerGet(body: unknown, status = 200) {
  mocks.fetch.mockImplementation((_url: string, init?: RequestInit) =>
    init?.method === "POST" ? json(500, {}) : json(status, body),
  );
}

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.toastError.mockReset();
});
afterEach(cleanup);

describe("AeMasterChatRow", () => {
  it("shows the waiting count with a plural label", async () => {
    answerGet({ session_id: null, waiting: 9 });
    renderRow();
    const pill = await screen.findByTestId("ae-master-chat-count");
    expect(pill.textContent).toBe("9");
    expect(pill.getAttribute("aria-label")).toBe("9 sessions waiting on you");
  });

  it("says 1 session in the singular", async () => {
    answerGet({ session_id: null, waiting: 1 });
    renderRow();
    expect((await screen.findByLabelText("1 session waiting on you")).textContent).toBe("1");
  });

  it.each([0, null])("shows no pill at %s", async (waiting) => {
    answerGet({ session_id: null, waiting });
    renderRow();
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    await screen.findByTestId("ae-master-chat-row");
    expect(screen.queryByTestId("ae-master-chat-count")).toBeNull();
  });

  it("renders without a pill when an older server answers 404", async () => {
    answerGet({ detail: "Not Found" }, 404);
    renderRow();
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(screen.getByTestId("ae-master-chat-row")).toBeTruthy();
    expect(screen.queryByTestId("ae-master-chat-count")).toBeNull();
  });

  it("is a real link to the session when the id is known, active on that page", async () => {
    answerGet({ session_id: "conv_m", waiting: 2 });
    renderRow("/c/conv_m");
    await waitFor(() =>
      expect(screen.getByTestId("ae-master-chat-row").getAttribute("href")).toBe("/c/conv_m"),
    );
    expect(screen.getByRole("link", { name: /Master chat/ }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("posts, then opens the new session, ignoring a second click meanwhile", async () => {
    let finish: (r: Response) => void = () => {};
    mocks.fetch.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : json(200, { session_id: null, waiting: 0 }),
    );
    renderRow();
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    const link = screen.getByRole("link", { name: /Master chat/ });
    fireEvent.click(link);
    fireEvent.click(link);
    const posts = () =>
      mocks.fetch.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "POST");
    expect(posts()).toHaveLength(1);
    finish(
      new Response(JSON.stringify({ session_id: "conv_new", created: true }), { status: 200 }),
    );
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/c/conv_new"));
  });

  it("shows the server's sentence when the create fails, and stays usable", async () => {
    mocks.fetch.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json(503, { error: { message: "no master chat was started: no host" } })
        : json(200, { session_id: null, waiting: 0 }),
    );
    renderRow();
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    const link = screen.getByRole("link", { name: /Master chat/ });
    fireEvent.click(link);
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("no master chat was started: no host"),
    );
    expect(screen.getByTestId("where").textContent).toBe("/");
    fireEvent.click(link);
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(2));
  });
});
