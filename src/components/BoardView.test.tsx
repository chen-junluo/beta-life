// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../defaults";
import { BoardView } from "./BoardView";

describe("BoardView focus layout", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("compresses every sleep lane into the available period width", () => {
    act(() => {
      root.render(
        <BoardView
          items={[]}
          settings={structuredClone(DEFAULT_SETTINGS)}
          viewMode="sleep"
          onItemsChange={vi.fn()}
          onCreate={vi.fn()}
          onEdit={vi.fn()}
          onSloganChange={vi.fn()}
        />,
      );
    });

    const period = host.querySelector<HTMLElement>('.period-group[data-layout="focus"]');
    const hoursGrid = host.querySelector<HTMLElement>(".focused-hours-grid");

    expect(period).not.toBeNull();
    expect(period!.style.getPropertyValue("--focused-board-min-width")).toBe("");
    expect(hoursGrid?.style.gridTemplateColumns).toBe("repeat(9, minmax(0, 1fr))");
    expect(hoursGrid?.children).toHaveLength(9);
  });
});
