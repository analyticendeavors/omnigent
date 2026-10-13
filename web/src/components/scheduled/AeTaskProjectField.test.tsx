import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT,
  NO_PROJECT,
  initialProjectChoice,
  projectIdInput,
} from "@/components/scheduled/AeTaskProjectField";

describe("initialProjectChoice", () => {
  it("starts a new task on the server default", () => {
    expect(initialProjectChoice(undefined, false)).toBe(DEFAULT_PROJECT);
  });

  it("starts an edit on the task's project, or no project", () => {
    expect(initialProjectChoice("p1", true)).toBe("p1");
    expect(initialProjectChoice(null, true)).toBe(NO_PROJECT);
  });
});

describe("projectIdInput", () => {
  it("omits the field for the server default on create", () => {
    expect(projectIdInput(DEFAULT_PROJECT, undefined)).toEqual({});
  });

  it("sends null for no project and the id for a project on create", () => {
    expect(projectIdInput(NO_PROJECT, undefined)).toEqual({ projectId: null });
    expect(projectIdInput("p1", undefined)).toEqual({ projectId: "p1" });
  });

  it("sends only a change on edit", () => {
    expect(projectIdInput("p1", "p1")).toEqual({});
    expect(projectIdInput(NO_PROJECT, null)).toEqual({});
    expect(projectIdInput("p2", "p1")).toEqual({ projectId: "p2" });
    expect(projectIdInput(NO_PROJECT, "p1")).toEqual({ projectId: null });
    expect(projectIdInput("p1", null)).toEqual({ projectId: "p1" });
  });
});
