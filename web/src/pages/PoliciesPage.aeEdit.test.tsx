// Editing a global policy's parameters on the PoliciesPage (AE patch): the
// pencil on stored factory policies, the add dialog in edit mode prefilled
// from factory_params, and the PATCH it sends. Same mocking as
// PoliciesPage.test.tsx: the identity probe and the react-query hooks.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PoliciesPage } from "./PoliciesPage";
import * as identity from "@/lib/identity";
import * as defaultPolicies from "@/hooks/useDefaultPolicies";
import * as policies from "@/hooks/usePolicies";

vi.mock("@/lib/CapabilitiesContext", () => ({
  useServerInfo: () => ({
    accounts_enabled: true,
    login_url: null,
    server_version: "0.3.0.dev0",
    single_user: false,
  }),
}));
vi.mock("@/lib/identity", () => ({
  resolveIdentity: vi.fn(),
  getCurrentIsAdmin: vi.fn(),
}));
vi.mock("@/hooks/useDefaultPolicies", () => ({
  useDefaultPolicies: vi.fn(),
  useAddDefaultPolicy: vi.fn(),
  useUpdateDefaultPolicy: vi.fn(),
  useDeleteDefaultPolicy: vi.fn(),
}));
vi.mock("@/hooks/usePolicies", () => ({ usePolicyRegistry: vi.fn() }));

const addMutate = vi.fn();
const updateMutate = vi.fn();
const deleteMutate = vi.fn();

const RABBIT_HOLE = {
  handler: "ae_omni_policies.rabbit_hole.rabbit_hole",
  kind: "factory",
  name: "AE Rabbit Hole",
  description: "One ASK per session past `hours` or `turns`.",
  params_schema: {
    type: "object",
    properties: {
      hours: { type: "number", default: 4, minimum: 0, description: "Hours before the ask." },
      turns: { type: "integer", default: 60, minimum: 0, description: "Prompts before it." },
    },
  },
};
const SLOT_CAP = {
  handler: "ae_omni_policies.slot_cap.slot_cap",
  kind: "factory",
  name: "AE Slot Cap",
  description: "The slot rule.",
  params_schema: {
    type: "object",
    properties: {
      limit: { type: "integer", default: 3, minimum: 1, description: "Leave unset." },
      mode: { type: "string", enum: ["warn", "block"], default: "warn" },
      lot_url: { type: "string" },
    },
  },
};
const HURRY = {
  handler: "ae_omni_policies.hurry.hurry_modes",
  kind: "callable",
  name: "AE Hurry Modes",
  description: "",
  params_schema: null,
};

function policy(overrides: Record<string, unknown>) {
  return {
    id: "p1",
    object: "default_policy",
    name: "p",
    type: "python",
    handler: "h",
    factory_params: null,
    enabled: true,
    created_at: 1,
    updated_at: null,
    created_by: null,
    ...overrides,
  };
}

const POLICIES = [
  policy({
    id: "r1",
    name: "ae_rabbit_hole",
    handler: RABBIT_HOLE.handler,
    factory_params: { hours: 4, turns: 60 },
  }),
  policy({
    id: "s1",
    name: "ae_slot_cap",
    handler: SLOT_CAP.handler,
    factory_params: { mode: "warn", lot_url: "/lot" },
  }),
  policy({ id: "h1", name: "ae_hurry_modes", handler: HURRY.handler }),
  policy({
    id: null,
    source: "config",
    name: "from_config",
    handler: RABBIT_HOLE.handler,
    factory_params: { hours: 1 },
  }),
];

function mutationStub(mutate: ReturnType<typeof vi.fn>) {
  mutate.mockImplementation((_arg: unknown, opts?: { onSuccess?: () => void }) =>
    opts?.onSuccess?.(),
  );
  return { mutate, isPending: false, isError: false, error: null };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <PoliciesPage />
    </MemoryRouter>,
  );
}

async function openEdit(name: string) {
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${name}` }));
  await screen.findByText("Edit Global Policy");
}

beforeEach(() => {
  vi.mocked(identity.resolveIdentity).mockResolvedValue("admin");
  vi.mocked(identity.getCurrentIsAdmin).mockReturnValue(true);
  vi.mocked(defaultPolicies.useDefaultPolicies).mockReturnValue({
    data: POLICIES,
    refetch: vi.fn(),
  } as never);
  vi.mocked(policies.usePolicyRegistry).mockReturnValue({
    data: [RABBIT_HOLE, SLOT_CAP, HURRY],
  } as never);
  vi.mocked(defaultPolicies.useAddDefaultPolicy).mockReturnValue(mutationStub(addMutate) as never);
  vi.mocked(defaultPolicies.useUpdateDefaultPolicy).mockReturnValue(
    mutationStub(updateMutate) as never,
  );
  vi.mocked(defaultPolicies.useDeleteDefaultPolicy).mockReturnValue(
    mutationStub(deleteMutate) as never,
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PoliciesPage editing a policy's parameters", () => {
  it("offers Edit only on stored policies that have parameters", async () => {
    renderPage();
    expect(await screen.findByRole("button", { name: "Edit ae_rabbit_hole" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit ae_slot_cap" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit ae_hurry_modes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit from_config" })).toBeNull();
  });

  it("opens the dialog prefilled, with no picker and no Change link", async () => {
    await openEdit("ae_rabbit_hole");
    expect(screen.getByDisplayValue("4")).toBeInTheDocument();
    expect(screen.getByDisplayValue("60")).toBeInTheDocument();
    expect(screen.getByDisplayValue("ae_rabbit_hole")).toBeDisabled();
    expect(screen.queryByPlaceholderText("Filter policies...")).toBeNull();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("saves the edited params as a PATCH and closes", async () => {
    await openEdit("ae_rabbit_hole");
    fireEvent.change(screen.getByDisplayValue("60"), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMutate).toHaveBeenCalledWith(
      { policyId: "r1", factory_params: { hours: 4, turns: 80 } },
      expect.anything(),
    );
    await waitFor(() => expect(screen.queryByText("Edit Global Policy")).toBeNull());
    expect(addMutate).not.toHaveBeenCalled();
  });

  it("leaves a blank slot cap limit out of the params", async () => {
    await openEdit("ae_slot_cap");
    fireEvent.change(screen.getByDisplayValue("warn"), { target: { value: "block" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMutate).toHaveBeenCalledWith(
      { policyId: "s1", factory_params: { mode: "block", lot_url: "/lot" } },
      expect.anything(),
    );
  });

  it("saves untouched values exactly as stored", async () => {
    // An empty list and a key the schema no longer lists cannot round-trip
    // through the form's strings; editing another field must keep them.
    const sandbox = {
      ...POLICIES[0],
      id: "x1",
      name: "sandbox",
      handler: "omnigent.policies.sandbox",
      factory_params: { hours: 4, write_paths: [], retired: "kept" },
    };
    vi.mocked(defaultPolicies.useDefaultPolicies).mockReturnValue({
      data: [sandbox],
      refetch: vi.fn(),
    } as never);
    vi.mocked(policies.usePolicyRegistry).mockReturnValue({
      data: [
        {
          ...RABBIT_HOLE,
          handler: "omnigent.policies.sandbox",
          params_schema: {
            type: "object",
            properties: {
              hours: { type: "number" },
              write_paths: { type: "array", items: { type: "string" } },
            },
          },
        },
      ],
    } as never);
    await openEdit("sandbox");
    fireEvent.change(screen.getByDisplayValue("4"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMutate).toHaveBeenCalledWith(
      { policyId: "x1", factory_params: { hours: 6, write_paths: [], retired: "kept" } },
      expect.anything(),
    );
  });

  it("closes on Cancel without saving", async () => {
    await openEdit("ae_rabbit_hole");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Edit Global Policy")).toBeNull());
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("shows the server's reason when the save is refused", async () => {
    vi.mocked(defaultPolicies.useUpdateDefaultPolicy).mockReturnValue({
      mutate: updateMutate,
      isPending: false,
      isError: true,
      error: new Error("Policy 'ae_rabbit_hole' rejected these params: hours must be >= 0."),
    } as never);
    await openEdit("ae_rabbit_hole");
    expect(screen.getByRole("alert")).toHaveTextContent("hours must be >= 0");
  });

  it("keeps the switch sending only the enabled flag", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("switch", { name: "Toggle ae_rabbit_hole" }));
    expect(updateMutate).toHaveBeenCalledWith({ policyId: "r1", enabled: false });
  });
});
