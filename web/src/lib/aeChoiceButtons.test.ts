import { describe, expect, it } from "vitest";
import {
  aeChoiceField,
  aeChoiceIsNo,
  aeChoiceIsPrimary,
  aeShortChoiceLabel,
  aeShortChoiceLabels,
  trimSharedSuffix,
} from "./aeChoiceButtons";

const schema = (prop: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "object",
  properties: { Pick: { type: "string", ...prop } },
  required: ["Pick"],
  ...extra,
});

describe("aeChoiceField", () => {
  it.each([2, 3, 4])("is a choice with %i enum values", (n) => {
    const values = ["a", "b", "c", "d"].slice(0, n);
    expect(aeChoiceField(schema({ enum: values }))?.choices.map((c) => c.value)).toEqual(values);
  });

  it("is not a choice with 5 values, 1 value, two fields, a non-string enum or no enum", () => {
    expect(aeChoiceField(schema({ enum: ["a", "b", "c", "d", "e"] }))).toBeNull();
    expect(aeChoiceField(schema({ enum: ["a"] }))).toBeNull();
    expect(
      aeChoiceField({
        type: "object",
        properties: {
          A: { type: "string", enum: ["x", "y"] },
          B: { type: "string", enum: ["x", "y"] },
        },
      }),
    ).toBeNull();
    expect(aeChoiceField(schema({ type: "integer", enum: [1, 2] }))).toBeNull();
    expect(aeChoiceField(schema({ enum: [1, 2] }))).toBeNull();
    expect(aeChoiceField(schema({}))).toBeNull();
    expect(aeChoiceField({})).toBeNull();
    expect(aeChoiceField(null)).toBeNull();
  });

  it("is not a choice for an AskUserQuestion", () => {
    expect(aeChoiceField(schema({ enum: ["Yes", "No"] }), true)).toBeNull();
  });

  it("is not a choice when the field is optional, since buttons would force a value", () => {
    expect(aeChoiceField(schema({ enum: ["Yes", "No"] }, { required: [] }))).toBeNull();
    expect(aeChoiceField(schema({ enum: ["Yes", "No"] }, { required: undefined }))).toBeNull();
  });

  it("needs its own Reject unless a choice declines", () => {
    expect(aeChoiceField(schema({ enum: ["Yes", "No"] }))?.needsReject).toBe(false);
    expect(
      aeChoiceField(schema({ enum: ["a", "b"], enumNames: ["Go on", "Decline it"] }))?.needsReject,
    ).toBe(false);
    expect(aeChoiceField(schema({ enum: ["Cancel", "Run"] }))?.needsReject).toBe(false);
    expect(aeChoiceField(schema({ enum: ["dev", "prod"] }))?.needsReject).toBe(true);
    expect(aeChoiceField(schema({ enum: ["Nothing", "Now"] }))?.needsReject).toBe(true);
  });

  it("uses enumNames, trims the shared tail and keeps the full label", () => {
    const field = aeChoiceField(
      schema({
        enum: ["Yes", "No"],
        enumNames: ["Continue the operation", "Decline the operation"],
        title: "Confirm",
        description: "Pick one",
      }),
    );
    expect(field?.name).toBe("Pick");
    expect(field?.title).toBe("Confirm");
    expect(field?.description).toBe("Pick one");
    expect(field?.choices).toEqual([
      { value: "Yes", label: "Continue", fullLabel: "Continue the operation" },
      { value: "No", label: "Decline", fullLabel: "Decline the operation" },
    ]);
  });
});

describe("trimSharedSuffix", () => {
  it("removes a shared trailing run of whole words", () => {
    expect(trimSharedSuffix(["Open the file", "Close the file"])).toEqual(["Open", "Close"]);
  });
  it("drops a dangling comma or period left by the trim", () => {
    expect(trimSharedSuffix(["Yes, proceed", "No, proceed"])).toEqual(["Yes", "No"]);
    expect(trimSharedSuffix(["Stop: now.", "Go: now."])).toEqual(["Stop", "Go"]);
  });
  it("leaves labels with nothing shared alone", () => {
    expect(trimSharedSuffix(["Yes", "No"])).toEqual(["Yes", "No"]);
  });
  it("does not trim when a label would become empty", () => {
    expect(trimSharedSuffix(["Delete file", "file"])).toEqual(["Delete file", "file"]);
    expect(trimSharedSuffix(["Same", "Same"])).toEqual(["Same", "Same"]);
  });
  it("matches whole words only", () => {
    expect(trimSharedSuffix(["Run test", "Skip contest"])).toEqual(["Run test", "Skip contest"]);
  });
});

describe("button styles", () => {
  const yes = { value: "yes", label: "Yes", fullLabel: "Yes" };
  const no = { value: "No", label: "No", fullLabel: "No" };
  it("makes only a first Yes primary and a No outline", () => {
    expect(aeChoiceIsPrimary(yes, 0)).toBe(true);
    expect(aeChoiceIsPrimary(yes, 1)).toBe(false);
    expect(aeChoiceIsPrimary(no, 0)).toBe(false);
    expect(aeChoiceIsNo(no)).toBe(true);
    expect(aeChoiceIsNo(yes)).toBe(false);
  });
});

describe("aeShortChoiceLabel", () => {
  it("keeps a short label as it is", () => {
    expect(aeShortChoiceLabel("Park it")).toBe("Park it");
  });

  it("shows the words before the first colon of a long label", () => {
    expect(
      aeShortChoiceLabel(
        "Open it as overflow (Recommended): a small chat on the backup login so the red dock shows",
      ),
    ).toBe("Open it as overflow (Recommended)");
  });

  it("cuts a long label with no colon at a word", () => {
    const out = aeShortChoiceLabel(
      "Flip one of the running chats to review first and then open the new chat afterwards",
    );
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(out).not.toMatch(/\s…$/);
  });

  it("shortens the buttons of a choice field and keeps the full label", () => {
    const long = "Fix it now: one builder changes the scheduler so a check-in reuses your chat";
    const field = aeChoiceField(schema({ enum: ["a", "b"], enumNames: [long, "Park it"] }));
    expect(field?.choices[0]).toMatchObject({ label: "Fix it now", fullLabel: long });
  });
});

describe("aeShortChoiceLabels", () => {
  it("keeps the full labels of answers that would shorten to the same words", () => {
    const a = "Fix it now: patch the scheduler so a check-in reuses your chat";
    const b = "Fix it now: revert the scheduler change that broke the check-in";
    expect(aeShortChoiceLabels([a, b, "Park it"])).toEqual([a, b, "Park it"]);
  });

  it("shortens each answer when the short labels differ", () => {
    expect(
      aeShortChoiceLabels([
        "Fix it now: patch the scheduler so a check-in reuses a chat",
        "Park it",
      ]),
    ).toEqual(["Fix it now", "Park it"]);
  });

  it("never splits an emoji when it cuts a long label", () => {
    const out = aeShortChoiceLabel(`${"a".repeat(39)}😀 and more words after the picture here`);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out.endsWith("…")).toBe(true);
  });

  it("keeps the last whole word when the cut lands on a space", () => {
    expect(
      aeShortChoiceLabel("Flip one of the running chats to reviews now and then open the new chat"),
    ).toBe("Flip one of the running chats to reviews…");
  });
});
