import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsAiAccountsSection } from "./SettingsAiAccountsSection";
import { readHarnessOptions, writeHarnessOption } from "@/lib/modePreferences";

const state = vi.hoisted(() => ({
  enabled: true,
  hosts: [
    {
      host_id: "one",
      name: "Laptop",
      status: "online",
      configured_harnesses: {
        "claude-native": true,
        "codex-native": true,
        "pi-native": "needs-auth",
        "cursor-native": true,
      },
    },
    {
      host_id: "two",
      name: "Desktop",
      status: "online",
      configured_harnesses: { "claude-native": true },
    },
    { host_id: "off", name: "Offline host", status: "offline", configured_harnesses: {} },
  ],
  models: vi.fn(),
}));
vi.mock("@/hooks/useHosts", () => ({
  useHosts: () => ({ data: state.hosts }),
  useHostModelOptions: (...args: unknown[]) => {
    state.models(...args);
    return {
      data: [
        {
          id: "catalog-model",
          displayName: "Catalog model",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        },
      ],
    };
  },
}));
vi.mock("@/lib/CapabilitiesContext", () => ({ useServerInfo: () => ({}) }));
vi.mock("@/lib/capabilities", () => ({ isFeatureEnabled: () => state.enabled }));
vi.mock("@/lib/agentLabels", () => ({
  useHarnessLabels: () => ({}),
  isAutoHarness: () => false,
  useHarnessSetupSteps: () => ({ "codex-native": [{ kind: "auth", command: "codex login" }] }),
}));
vi.mock("@/shell/ClaudeAccounts", () => ({
  ClaudeAccounts: ({ host }: { host: { name: string } }) => <div>Accounts on {host.name}</div>,
}));
vi.mock("@/shell/HarnessCredentialForm", () => ({
  HarnessCredentialForm: ({ command }: { command: string }) => (
    <div>
      <input aria-label="Test secret" />
      {command}
    </div>
  ),
}));
vi.mock("@/shell/HarnessSetupDialog", () => ({
  HarnessSetupDialog: ({ open, harness }: { open: boolean; harness: string }) =>
    open ? <div>Setup {harness}</div> : null,
}));

describe("AI account settings", () => {
  beforeEach(() => {
    localStorage.clear();
    state.enabled = true;
    state.models.mockClear();
    state.hosts[1].status = "online";
  });
  it("retains the explicitly selected host when it goes offline", () => {
    const { rerender } = render(<SettingsAiAccountsSection />);
    expect(screen.getByText("Accounts on Laptop")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "two" } });
    expect(screen.getByText("Accounts on Desktop")).toBeTruthy();
    state.hosts[1].status = "offline";
    rerender(<SettingsAiAccountsSection />);
    expect((screen.getByLabelText("Host") as HTMLSelectElement).value).toBe("two");
    expect(screen.queryByText("Accounts on Laptop")).toBeNull();
    expect(screen.getByText("Reconnect this host to manage its accounts.")).toBeTruthy();
    expect(screen.queryByLabelText("Test secret")).toBeNull();
  });
  it("resets secrets when host or harness changes and shows CLI login", () => {
    render(<SettingsAiAccountsSection />);
    fireEvent.change(screen.getByLabelText("Test secret"), { target: { value: "private" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "two" } });
    expect((screen.getByLabelText("Test secret") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Test secret"), { target: { value: "private" } });
    fireEvent.change(screen.getByLabelText("Harness"), { target: { value: "codex-native" } });
    expect((screen.getByLabelText("Test secret") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("codex login")).toBeTruthy();
  });
  it("gates host writes by the server feature", () => {
    state.enabled = false;
    render(<SettingsAiAccountsSection />);
    expect(screen.queryByLabelText("Test secret")).toBeNull();
    expect(screen.queryByText("Accounts on Laptop")).toBeNull();
    expect(screen.queryByText("Setup instructions")).toBeNull();
    expect(screen.getByLabelText("Default model")).toBeTruthy();
  });
  it("persists defaults across hosts and queries only the selected harness", () => {
    writeHarnessOption("claude-native", { routing: "on" });
    render(<SettingsAiAccountsSection />);
    fireEvent.change(screen.getByLabelText("Default model"), {
      target: { value: "catalog-model" },
    });
    fireEvent.change(screen.getByLabelText("Default permissions"), { target: { value: "plan" } });
    expect(readHarnessOptions("claude-native")).toMatchObject({
      model: "catalog-model",
      routing: "off",
      mode: "plan",
    });
    expect(state.models.mock.calls.every((call) => call[1] === "claude-native")).toBe(true);
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "two" } });
    expect((screen.getByLabelText("Default model") as HTMLSelectElement).value).toBe(
      "catalog-model",
    );
    fireEvent.change(screen.getByLabelText("Harness"), { target: { value: "codex-native" } });
    expect((screen.getByLabelText("Default model") as HTMLSelectElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Default effort"), { target: { value: "high" } });
    expect(readHarnessOptions("codex-native").effort).toBe("high");
  });
  it("offers setup for other installed harnesses without credential forms", () => {
    render(<SettingsAiAccountsSection />);
    fireEvent.change(screen.getByLabelText("Harness"), { target: { value: "cursor-native" } });
    expect(screen.queryByLabelText("Test secret")).toBeNull();
    fireEvent.click(screen.getByText("Setup instructions"));
    expect(screen.getByText("Setup cursor-native")).toBeTruthy();
    expect(state.models.mock.lastCall?.slice(1)).toEqual(["cursor-native", false]);
  });
  it("retains saved model preferences when the catalog does not include them", () => {
    writeHarnessOption("claude-native", { model: "previous-host-model", effort: "high" });
    render(<SettingsAiAccountsSection />);
    expect((screen.getByLabelText("Default model") as HTMLSelectElement).value).toBe(
      "previous-host-model",
    );
    expect(screen.getByText("previous-host-model (saved; unavailable on this host)")).toBeTruthy();
    expect(readHarnessOptions("claude-native").model).toBe("previous-host-model");
    fireEvent.change(screen.getByLabelText("Default model"), {
      target: { value: "catalog-model" },
    });
    expect(readHarnessOptions("claude-native").effort).toBe("");
  });
  it("offers Pi credentials while waiting for authentication without probing models", () => {
    render(<SettingsAiAccountsSection />);
    fireEvent.change(screen.getByLabelText("Harness"), { target: { value: "pi-native" } });
    expect(screen.getByLabelText("Test secret")).toBeTruthy();
    expect(screen.getByText("Authentication required")).toBeTruthy();
    expect(state.models.mock.lastCall?.slice(1)).toEqual(["pi-native", false]);
    expect(screen.queryByText("codex login")).toBeNull();
  });
});
