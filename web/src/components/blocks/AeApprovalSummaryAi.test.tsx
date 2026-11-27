// The card's AI summary line: leads with a label, never replaces the derived line, is scrubbed,
// and a failed or absent answer keeps today's card (omnigent-ae, 2026-11-27).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  authenticatedFetch: mocks.fetch,
}));

import { ApprovalCard } from "./ApprovalCard";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function renderCard(contentPreview: string, status: "pending" | "responded" = "pending") {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ApprovalCard
        elicitationId="elic_ai"
        message="Claude wants to call **Bash**"
        phase="pre_tool_use"
        policyName="claude_native_permission"
        contentPreview={contentPreview}
        requestedSchema={{}}
        status={status}
        response={status === "responded" ? { action: "accept" } : null}
      />
    </QueryClientProvider>,
  );
}

const derived = `Bash(${JSON.stringify({ command: "pnpm install" })})`;
const agentWritten = `Bash(${JSON.stringify({ command: "pnpm install", description: "Install packages" })})`;

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });

beforeEach(() => mocks.fetch.mockReset());

describe("AI summary on an approval card", () => {
  it("shows the AI line with its label and keeps the derived line under it", async () => {
    mocks.fetch.mockResolvedValue(json({ text: "Installs the project's packages." }));
    renderCard(derived);
    await waitFor(() => expect(screen.getByTestId("approval-ai-text")).toBeDefined());
    expect(screen.getByTestId("approval-ai-text").textContent).toBe(
      "Installs the project's packages.",
    );
    expect(screen.getByText("AI summary")).toBeDefined();
    expect(screen.getByTestId("approval-summary-text").textContent).toBe("Run a command");
  });

  it("keeps the derived line first on a destructive card, with the AI line muted under it", async () => {
    mocks.fetch.mockImplementation(async () => json({ text: "Tidies the build folder." }));
    renderCard(`Bash(${JSON.stringify({ command: "rm -rf build" })})`);
    await waitFor(() => expect(screen.getByTestId("approval-ai-text")).toBeDefined());
    const derivedLine = screen.getByTestId("approval-summary-text");
    const ai = screen.getByTestId("approval-ai-summary");
    expect(derivedLine.className).toContain("text-foreground");
    expect(derivedLine.compareDocumentPosition(ai) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("approval-ai-text").className).toContain("text-muted-foreground");
    expect(screen.getByText("AI summary")).toBeDefined();
  });

  it("scrubs a secret-shaped AI reply", async () => {
    mocks.fetch.mockResolvedValue(json({ text: "Sends ghp_abcdefgh12345678 to the host." }));
    renderCard(derived);
    await waitFor(() => expect(screen.getByTestId("approval-ai-text")).toBeDefined());
    expect(screen.getByTestId("approval-ai-text").textContent).toBe(
      "Sends [redacted] to the host.",
    );
  });

  it("keeps today's card on a 503", async () => {
    mocks.fetch.mockResolvedValue(json({ error: "not set up" }, 503));
    renderCard(derived);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    await tick();
    expect(screen.queryByTestId("approval-ai-summary")).toBeNull();
    expect(screen.getByTestId("approval-summary-text").textContent).toBe("Run a command");
  });

  it("never asks for the agent's own summary or a responded card", async () => {
    renderCard(agentWritten);
    expect(screen.getByTestId("approval-summary-text").textContent).toBe("Install packages");
    expect(screen.queryByTestId("approval-ai-summary")).toBeNull();
    renderCard(derived, "responded");
    await tick();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
