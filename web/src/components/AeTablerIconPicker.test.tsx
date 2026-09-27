// The Tabler project icon picker (omnigent-ae, 2026-09-24): search by name and
// tag, pick by click or keyboard, and `onSelect` gets `tabler:<name>`.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AeTablerIconPicker, searchAeTablerIcons } from "./AeTablerIconPicker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

vi.mock("@/lib/aeTablerIconData", () => {
  const path = [["path", { d: "M4 4h16v16h-16z" }]];
  const names = [
    "folder",
    "rocket",
    "rocket-off",
    "space",
    "code",
    "brand-github",
    "flame",
    "zoom",
  ];
  return {
    aeTablerIconsIfLoaded: () => null,
    loadAeTablerIcons: () => Promise.resolve(Object.fromEntries(names.map((n) => [n, path]))),
    subscribeAeTablerIcons: () => () => undefined,
    loadAeTablerIconTags: () =>
      Promise.resolve({
        rocket: { category: "Map", tags: ["galaxy", "spaceship"] },
        flame: { category: "Nature", tags: ["fire", "hot"] },
        zoom: { tags: ["magnifier"] },
      }),
  };
});

afterEach(cleanup);

async function renderPicker() {
  const onSelect = vi.fn();
  render(<AeTablerIconPicker onSelect={onSelect} />);
  await screen.findByTestId("ae-tabler-icon-rocket");
  return onSelect;
}

describe("searchAeTablerIcons", () => {
  const names = ["folder", "rocket-off", "rocket", "space", "flame"];
  const tags = { flame: { category: "Nature", tags: ["fire"] }, rocket: { tags: ["spaceship"] } };

  it("keeps the given order for an empty query", () => {
    expect(searchAeTablerIcons(names, tags, "  ")).toEqual(names);
  });

  it("ranks the exact name, then prefixes, then tag-only matches", () => {
    expect(searchAeTablerIcons(names, tags, "rocket")).toEqual(["rocket", "rocket-off"]);
    expect(searchAeTablerIcons(names, tags, "space")).toEqual(["space", "rocket"]);
    expect(searchAeTablerIcons(names, tags, "FIRE")).toEqual(["flame"]);
    expect(searchAeTablerIcons(names, null, "fire")).toEqual([]);
  });

  it("needs every word to match", () => {
    expect(searchAeTablerIcons(names, tags, "rocket off")).toEqual(["rocket-off"]);
    expect(searchAeTablerIcons(names, tags, "rocket nature")).toEqual([]);
  });
});

describe("AeTablerIconPicker", () => {
  it("shows the suggested icons first, then the rest", async () => {
    await renderPicker();
    const order = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"))
      .filter(Boolean);
    expect(order.slice(0, 5)).toEqual(["folder", "rocket", "code", "brand-github", "flame"]);
    expect(order).toContain("zoom");
  });

  it("searches by name and by tag", async () => {
    await renderPicker();
    const search = screen.getByTestId("ae-tabler-search");
    fireEvent.change(search, { target: { value: "rock" } });
    expect(screen.getByTestId("ae-tabler-icon-rocket")).toBeInTheDocument();
    expect(screen.getByTestId("ae-tabler-icon-rocket-off")).toBeInTheDocument();
    expect(screen.queryByTestId("ae-tabler-icon-folder")).toBeNull();

    await vi.waitFor(() => {
      fireEvent.change(search, { target: { value: "fire" } });
      expect(screen.getByTestId("ae-tabler-icon-flame")).toBeInTheDocument();
    });
    fireEvent.change(search, { target: { value: "nothing-like-this" } });
    expect(screen.getByText(/No icons match/)).toBeInTheDocument();
  });

  it("calls onSelect with tabler:<name> on a click", async () => {
    const onSelect = await renderPicker();
    fireEvent.click(screen.getByTestId("ae-tabler-icon-rocket"));
    expect(onSelect).toHaveBeenCalledWith("tabler:rocket");
  });

  it("picks the first result with Enter in the search box", async () => {
    const onSelect = await renderPicker();
    const search = screen.getByTestId("ae-tabler-search");
    fireEvent.change(search, { target: { value: "code" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("tabler:code");
  });

  it("picks nothing with Enter in an empty search box", async () => {
    const onSelect = await renderPicker();
    const search = screen.getByTestId("ae-tabler-search");
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.change(search, { target: { value: "   " } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("focuses the search box when opened in a popover with a button above it", async () => {
    // The rename popover's shape: "Remove icon" first, then the picker.
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button">Change project icon</button>
          </PopoverTrigger>
          <PopoverContent>
            <button type="button">Remove icon</button>
            <AeTablerIconPicker onSelect={vi.fn()} />
          </PopoverContent>
        </Popover>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Change project icon" }));
    const search = await screen.findByTestId("ae-tabler-search");
    await screen.findByTestId("ae-tabler-icon-rocket");
    expect(search).toHaveFocus();
    expect(screen.getByRole("button", { name: "Remove icon" })).not.toHaveFocus();
  });

  it("moves through the grid with the arrow keys and back to the search box", async () => {
    await renderPicker();
    const search = screen.getByTestId("ae-tabler-search");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const folder = screen.getByTestId("ae-tabler-icon-folder");
    expect(folder).toHaveFocus();
    expect(folder).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(folder, { key: "ArrowRight" });
    const rocket = screen.getByTestId("ae-tabler-icon-rocket");
    expect(rocket).toHaveFocus();
    expect(folder).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(rocket, { key: "ArrowUp" });
    expect(search).toHaveFocus();
  });

  it("offers a retry when the icon set fails to load", async () => {
    const data = await import("@/lib/aeTablerIconData");
    const load = vi.spyOn(data, "loadAeTablerIcons");
    load.mockRejectedValueOnce(new Error("offline"));
    render(<AeTablerIconPicker onSelect={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the icon set");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("ae-tabler-icon-rocket")).toBeInTheDocument();
  });
});
