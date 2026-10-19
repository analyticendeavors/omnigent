import { describe, expect, it } from "vitest";
import type { DefaultPolicy } from "@/hooks/useDefaultPolicies";
import type { PolicyRegistryEntry } from "@/hooks/usePolicies";
import { aeEditedParams, aePolicyEditable, aePolicyFormValues } from "./aePolicyEdit";

function stored(overrides: Partial<DefaultPolicy> = {}): DefaultPolicy {
  return {
    id: "p1",
    object: "default_policy",
    name: "ae_rabbit_hole",
    type: "python",
    handler: "ae_omni_policies.rabbit_hole.rabbit_hole",
    factory_params: { hours: 4, turns: 60 },
    enabled: true,
    created_at: 1,
    updated_at: null,
    created_by: null,
    ...overrides,
  };
}

const FACTORY: PolicyRegistryEntry = {
  handler: "ae_omni_policies.rabbit_hole.rabbit_hole",
  kind: "factory",
  name: "AE Rabbit Hole",
  description: "",
  params_schema: { type: "object", properties: { hours: { type: "number" } } },
};

describe("aePolicyFormValues", () => {
  it("turns stored params into the dialog's strings", () => {
    expect(
      aePolicyFormValues({
        hours: 4,
        annotate_prompt: false,
        mode: "warn",
        models: ["opus", "sonnet"],
        tool_points: { web_search: 10 },
        unset: null,
      }),
    ).toEqual({
      hours: "4",
      annotate_prompt: "false",
      mode: "warn",
      models: "opus,sonnet",
      tool_points: '{"web_search":10}',
    });
  });

  it("shows objects inside a list as JSON", () => {
    expect(aePolicyFormValues({ write_paths: [{ path: "/tmp", mode: "rw" }] })).toEqual({
      write_paths: '{"path":"/tmp","mode":"rw"}',
    });
  });

  it("gives an empty form for no params", () => {
    expect(aePolicyFormValues(null)).toEqual({});
    expect(aePolicyFormValues(undefined)).toEqual({});
  });
});

describe("aePolicyEditable", () => {
  it("allows a stored factory policy with parameters", () => {
    expect(aePolicyEditable(stored(), FACTORY)).toBe(true);
  });

  it("refuses a callable, an unknown handler, or a schema without parameters", () => {
    expect(aePolicyEditable(stored(), { ...FACTORY, kind: "callable", params_schema: null })).toBe(
      false,
    );
    expect(aePolicyEditable(stored(), undefined)).toBe(false);
    expect(aePolicyEditable(stored(), { ...FACTORY, params_schema: { properties: {} } })).toBe(
      false,
    );
  });

  it("refuses a config-file policy and a row without an id", () => {
    expect(aePolicyEditable(stored({ id: null, source: "config" }), FACTORY)).toBe(false);
    expect(aePolicyEditable(stored({ id: null }), FACTORY)).toBe(false);
  });
});

describe("aeEditedParams", () => {
  // Values the dialog's strings cannot carry back: an empty list, numbers and
  // objects in a list, an item with a comma, and a key the schema no longer lists.
  const STORED = {
    hours: 4,
    write_paths: [],
    ask_thresholds_usd: [1, 2.5],
    tags: ["a,b"],
    mounts: [{ path: "/tmp" }],
    retired_key: "kept",
  };

  it("keeps every untouched value exactly as stored", () => {
    const form = aePolicyFormValues(STORED);
    expect(aeEditedParams(STORED, form, { hours: 4, tags: ["a", "b"] })).toEqual(STORED);
  });

  it("takes a changed field from the dialog and leaves the rest", () => {
    const form = { ...aePolicyFormValues(STORED), hours: "6" };
    expect(aeEditedParams(STORED, form, { hours: 6, tags: ["a", "b"] })).toEqual({
      ...STORED,
      hours: 6,
    });
  });

  it("leaves a cleared field out so the factory default applies", () => {
    const form = { ...aePolicyFormValues(STORED), hours: "" };
    const { hours: _cleared, ...rest } = STORED;
    expect(aeEditedParams(STORED, form, { tags: ["a", "b"] })).toEqual(rest);
  });

  it("adds a field the stored params did not have", () => {
    expect(
      aeEditedParams({ hours: 4 }, { hours: "4", turns: "80" }, { hours: 4, turns: 80 }),
    ).toEqual({ hours: 4, turns: 80 });
  });
});
