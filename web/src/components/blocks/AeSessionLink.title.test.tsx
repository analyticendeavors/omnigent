// A bare session URL in chat reads as the session's title; an explicit link
// text stays as written, and a failed lookup falls back to `session <id>`.

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetSessionTitleCache } from "@/lib/aeSessionTitles";
import { SessionRouteLink } from "./AeSessionLink";

const getSessionSlim = vi.fn();
vi.mock("@/lib/sessionsApi", () => ({
  getSessionSlim: (id: string) => getSessionSlim(id),
}));

const ID = "0f0e59ed993446efa42135a5e80b95a1";
const URL_TEXT = `https://ae-llm-box.tailcb44aa.ts.net:8010/c/${ID}`;

beforeEach(() => {
  resetSessionTitleCache();
  getSessionSlim.mockReset();
});
afterEach(cleanup);

function link(text: string) {
  render(
    <MemoryRouter>
      <SessionRouteLink route={`/c/${ID}`} href={URL_TEXT}>
        {text}
      </SessionRouteLink>
    </MemoryRouter>,
  );
}

it("shows the title for a bare URL and keeps the href and URL tooltip", async () => {
  getSessionSlim.mockResolvedValue({ title: "Builder: PASS decks" });
  link(URL_TEXT);
  const anchor = await screen.findByRole("link", { name: "Builder: PASS decks" });
  expect(anchor.getAttribute("href")).toBe(URL_TEXT);
  expect(anchor.getAttribute("title")).toBe(URL_TEXT);
});

it("shows the short label until the title lands, then the title", async () => {
  getSessionSlim.mockResolvedValue({ title: "Late title" });
  link(URL_TEXT);
  expect(screen.getByRole("link").textContent).toBe("session 0f0e59ed");
  await screen.findByText("Late title");
});

it("falls back to the short label when the lookup fails", async () => {
  getSessionSlim.mockRejectedValue(new Error("403"));
  link(URL_TEXT);
  await vi.waitFor(() => expect(getSessionSlim).toHaveBeenCalledWith(ID));
  expect(screen.getByRole("link").textContent).toBe("session 0f0e59ed");
});

it("falls back when the session has no title", async () => {
  getSessionSlim.mockResolvedValue({ title: null });
  link(URL_TEXT);
  await vi.waitFor(() => expect(getSessionSlim).toHaveBeenCalled());
  expect(screen.getByRole("link").textContent).toBe("session 0f0e59ed");
});

it("keeps explicit link text and does not look anything up", () => {
  link("my notes");
  expect(screen.getByRole("link").textContent).toBe("my notes");
  expect(getSessionSlim).not.toHaveBeenCalled();
});

it("looks a session up once for repeated links", async () => {
  getSessionSlim.mockResolvedValue({ title: "Once" });
  render(
    <MemoryRouter>
      <SessionRouteLink route={`/c/${ID}`} href={URL_TEXT}>
        {URL_TEXT}
      </SessionRouteLink>
      <SessionRouteLink route={`/c/${ID}`} href={URL_TEXT}>
        {URL_TEXT}
      </SessionRouteLink>
    </MemoryRouter>,
  );
  await screen.findAllByText("Once");
  expect(getSessionSlim).toHaveBeenCalledTimes(1);
});
